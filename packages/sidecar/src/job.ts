import { join } from 'node:path';
import { buildMarkdown } from '@tapthat/shared';
import type { BatchRequest, RepoCommit, WorkspaceContext } from '@tapthat/shared';
import type { BatchEvent, BatchState, Emit } from './events';
import { Repo } from './repo';
import { mirrorDirectory, Workspace, type WorkspaceEntry } from './workspace';

export type { BatchRequest };

export interface AgentResult {
  ok: boolean;
  /** The agent's own prose summary. Never trusted for which files changed. */
  summary: string;
  /** Verbatim error text when ok is false — shown to the reviewer as-is. */
  error?: string;
}

export interface JobDeps {
  /** The repositories this batch may change. */
  workspace?: Workspace;
  /** Shorthand for a workspace of one; kept so single-repo callers read naturally. */
  repo?: Repo;
  /** Injectable so the safety suite can exercise the handler without the CLI. */
  runAgent(prompt: string, signal: AbortSignal): Promise<AgentResult>;
  /** With `repo`: its post-run build check. Resolves ok:false with output on failure. */
  verify?(): Promise<{ ok: boolean; output: string }>;
  config: {
    allowDirty: boolean;
    git: { enabled: boolean; author: { name: string; email: string } };
    timeoutMs: number;
    maxCommentsPerBatch: number;
    /** House rules for the prompt, e.g. "Do not change Prisma schemas." */
    rules?: string[];
  };
}

export interface BatchResult {
  state: BatchState;
  summary?: string;
  filesChanged: string[];
  /** The first (or only) commit. */
  sha?: string;
  commits?: RepoCommit[];
  error?: { kind: 'agent' | 'git' | 'config' | 'timeout'; message: string };
  baseSha?: string;
}

/** A subject line of at most 72 characters, cut on a word boundary. */
function subjectLine(summary: string): string {
  const first = summary.split('\n')[0]!.trim();
  if (first.length <= 72) return first || 'Apply TapThat feedback';
  const cut = first.slice(0, 71);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function commitMessage(batch: BatchRequest, summary: string): string {
  const subject = subjectLine(summary);
  // The full summary goes in the body when the subject had to be shortened.
  const body = subject.endsWith('…') ? `${summary.trim()}\n\n` : '';
  return `${subject}\n\n${body}TapThat batch ${batch.batchId}\nPage: ${batch.page.url}`;
}

interface Snapshot {
  baseSha: string;
  knownUntracked: Set<string>;
  preexistingDirty: Set<string>;
}

interface Touched {
  entry: WorkspaceEntry;
  /** Paths this run changed, tracked or new, relative to the repo. */
  paths: string[];
  /** Of those, the files this run created. */
  created: string[];
}

async function touchedBy(entry: WorkspaceEntry, snap: Snapshot): Promise<Touched> {
  const changed = await entry.repo.changedPaths(snap.baseSha, snap.knownUntracked);
  const paths = changed.filter((p) => !snap.preexistingDirty.has(p) && !snap.knownUntracked.has(p));
  const after = await entry.repo.status();
  const created = after.untracked.filter((p) => !snap.knownUntracked.has(p));
  return { entry, paths, created };
}

function under(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * The agent edits the original of a mirrored folder; the sidecar makes the
 * copies match. Editing a copy directly is refused rather than silently
 * overwritten — the next sync would undo it, and the reviewer would have seen a
 * change that never really happened.
 */
async function applyMirrors(ws: Workspace, touched: Map<string, Touched>): Promise<string | null> {
  for (const mirror of ws.mirrors) {
    const sourceChanged = touched.get(mirror.from.repo)?.paths.some((p) => under(p, mirror.from.path)) ?? false;
    for (const target of mirror.to) {
      const copyChanged = touched.get(target.repo)?.paths.some((p) => under(p, target.path)) ?? false;
      if (copyChanged && !sourceChanged) {
        return (
          `The agent edited ${target.repo}/${target.path}, which is a copy of ${mirror.from.repo}/${mirror.from.path}. ` +
          `Changes there are overwritten by the next sync, so nothing was kept. Ask again; the change belongs in ${mirror.from.repo}/${mirror.from.path}.`
        );
      }
      if (!sourceChanged) continue;
      const src = ws.get(mirror.from.repo)!.repo.root;
      const dst = ws.get(target.repo)!.repo.root;
      await mirrorDirectory(join(src, mirror.from.path), join(dst, target.path));
    }
  }
  return null;
}

function workspaceContext(ws: Workspace, rules: string[]): WorkspaceContext {
  const mirrorRules = ws.mirrors.flatMap((m) =>
    m.to.map(
      (t) =>
        `\`${t.repo}/${t.path}\` is a copy of \`${m.from.repo}/${m.from.path}\`. Edit only the original; the copy is updated for you.`,
    ),
  );
  return {
    repos: ws.entries.map((e) => ({ name: e.name, path: ws.relativePath(e), description: e.config?.description })),
    rules: [...mirrorRules, ...rules],
  };
}

/**
 * The fast path, end to end. Ordering matters: every tree is checked before
 * anything runs, and the pre-run snapshot is what makes scoped recovery possible
 * on failure. With several repositories, each step covers all of them, so a
 * batch lands everywhere or nowhere.
 */
export async function runJob(
  batch: BatchRequest,
  deps: JobDeps,
  emit: Emit,
): Promise<BatchResult> {
  const { config } = deps;
  const ws = deps.workspace ?? Workspace.single(deps.repo!, deps.verify?.bind(deps));

  if (batch.comments.length === 0) {
    return { state: 'failed', filesChanged: [], error: { kind: 'config', message: 'Batch contains no comments.' } };
  }
  if (batch.comments.length > config.maxCommentsPerBatch) {
    return {
      state: 'failed',
      filesChanged: [],
      error: {
        kind: 'config',
        message: `Batch has ${batch.comments.length} comments; the limit is ${config.maxCommentsPerBatch}.`,
      },
    };
  }

  // 1. Precondition. The sidecar often shares a developer's real checkout, so
  //    running an agent over their uncommitted work is not recoverable.
  const snapshots = new Map<string, Snapshot>();
  const dirty: string[] = [];
  for (const entry of ws.entries) {
    const before = await entry.repo.status();
    dirty.push(...before.dirty.map((p) => ws.label(entry.name, p)));
    snapshots.set(entry.name, {
      baseSha: '',
      knownUntracked: new Set(before.untracked),
      preexistingDirty: new Set(before.dirty),
    });
  }
  if (!config.allowDirty && dirty.length > 0) {
    return {
      state: 'failed',
      filesChanged: [],
      error: {
        kind: 'git',
        message:
          `Working tree has uncommitted changes in ${dirty.length} file(s): ` +
          `${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}. ` +
          `Commit or stash them first — the agent's edits would be indistinguishable from yours.`,
      },
    };
  }

  // 2. Snapshot. Everything we may need to undo is defined relative to this.
  for (const entry of ws.entries) snapshots.get(entry.name)!.baseSha = await entry.repo.head();
  const baseSha = snapshots.get(ws.primary.name)!.baseSha;
  emit({
    batchId: batch.batchId,
    type: 'started',
    message: ws.multi
      ? `base ${ws.entries.map((e) => `${e.name}@${snapshots.get(e.name)!.baseSha}`).join(' ')}`
      : `base ${baseSha}`,
  });

  // 3-4. Render the prompt. The sidecar variant fences the captured page
  //      content as untrusted data.
  const rules = config.rules ?? [];
  const prompt = buildMarkdown(batch.comments, batch.page, {
    variant: 'sidecar',
    repoRoot: ws.root,
    batchId: batch.batchId,
    workspace: ws.multi || rules.length ? workspaceContext(ws, rules) : undefined,
  });
  emit({ batchId: batch.batchId, type: 'prompt-rendered', message: `${prompt.length} chars` });

  // 5. Run, with a hard ceiling.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let result: AgentResult;
  try {
    result = await deps.runAgent(prompt, controller.signal);
  } catch (err) {
    result = { ok: false, summary: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }

  // What changed is git's answer, never the model's.
  const collect = async () => {
    const map = new Map<string, Touched>();
    for (const entry of ws.entries) map.set(entry.name, await touchedBy(entry, snapshots.get(entry.name)!));
    return map;
  };
  let touched = await collect();

  // 5b. Copies follow their originals, before anything is verified or committed.
  if (result.ok && ws.mirrors.length) {
    const refused = await applyMirrors(ws, touched);
    if (refused) result = { ok: false, summary: result.summary, error: refused };
    else touched = await collect();
  }

  if (!result.ok) {
    // 7. Scoped recovery: only what this run touched, in every repository.
    for (const t of touched.values()) {
      try {
        await t.entry.repo.restorePaths(
          t.paths.filter((p) => !t.created.includes(p)),
          t.created,
        );
      } catch (err) {
        emit({
          batchId: batch.batchId,
          type: 'failed',
          message: `cleanup failed in ${t.entry.name}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    const message = result.error?.trim() || 'The agent exited without applying a change.';
    emit({ batchId: batch.batchId, type: 'failed', message });
    return { state: 'failed', filesChanged: [], baseSha, error: { kind: 'agent', message } };
  }

  const changedRepos = [...touched.values()].filter((t) => t.paths.length > 0);
  const filesChanged = changedRepos.flatMap((t) => t.paths.map((p) => ws.label(t.entry.name, p)));
  emit({ batchId: batch.batchId, type: 'files-changed', files: filesChanged });

  if (filesChanged.length === 0) {
    const message = 'The agent reported success but changed no files.';
    emit({ batchId: batch.batchId, type: 'failed', message });
    return { state: 'failed', filesChanged: [], baseSha, error: { kind: 'agent', message } };
  }

  // 6a. Verify before committing, every repository that changed. The agent has
  //     no Bash, so it cannot know it broke the build; without this the
  //     reviewer sees "live" over a red overlay.
  const failures: string[] = [];
  for (const t of changedRepos) {
    if (!t.entry.verify) continue;
    const verified = await t.entry.verify();
    if (!verified.ok) failures.push(ws.multi ? `── ${t.entry.name} ──\n${verified.output}` : verified.output);
  }
  if (failures.length) {
    const output = failures.join('\n\n');
    emit({ batchId: batch.batchId, type: 'verify-failed', output, files: filesChanged });
    // The edits stay on disk: HMR has already shown them, and silently
    // reverting would be more confusing than surfacing the break.
    return {
      state: 'applied-unverified',
      summary: result.summary,
      filesChanged,
      baseSha,
      error: { kind: 'agent', message: output },
    };
  }
  if (changedRepos.some((t) => t.entry.verify)) emit({ batchId: batch.batchId, type: 'verify-passed' });

  // 6b. Commit only the paths this run touched, one commit per repository, all
  //     carrying the same batch trailer.
  if (!config.git.enabled) {
    return { state: 'applied', summary: result.summary, filesChanged, baseSha };
  }

  const commits: RepoCommit[] = [];
  try {
    for (const t of changedRepos) {
      const sha = await t.entry.repo.commitPaths(t.paths, commitMessage(batch, result.summary), config.git.author);
      if (sha) commits.push({ repo: t.entry.name, sha });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const done = commits.length ? ` (already committed: ${commits.map((c) => `${c.repo}@${c.sha}`).join(', ')})` : '';
    emit({ batchId: batch.batchId, type: 'failed', message: `commit failed: ${message}${done}` });
    return {
      state: 'applied',
      summary: result.summary,
      filesChanged,
      baseSha,
      commits: commits.length ? commits : undefined,
      sha: commits[0]?.sha,
      error: { kind: 'git', message },
    };
  }

  if (commits.length) {
    emit({ batchId: batch.batchId, type: 'committed', sha: commits[0]!.sha, commits, files: filesChanged });
  }
  return {
    state: commits.length ? 'committed' : 'applied',
    summary: result.summary,
    filesChanged,
    sha: commits[0]?.sha,
    commits: commits.length ? commits : undefined,
    baseSha,
  };
}

export type { BatchEvent };
