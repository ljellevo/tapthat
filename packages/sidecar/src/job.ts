import { buildMarkdown } from '@tapthat/shared';
import type { BatchRequest } from '@tapthat/shared';
import type { BatchEvent, BatchState, Emit } from './events';
import { Repo } from './repo';

export type { BatchRequest };

export interface AgentResult {
  ok: boolean;
  /** The agent's own prose summary. Never trusted for which files changed. */
  summary: string;
  /** Verbatim error text when ok is false — shown to the reviewer as-is. */
  error?: string;
}

export interface JobDeps {
  repo: Repo;
  /** Injectable so the safety suite can exercise the handler without the CLI. */
  runAgent(prompt: string, signal: AbortSignal): Promise<AgentResult>;
  /** Optional post-run build check. Resolves ok:false with output on failure. */
  verify?(): Promise<{ ok: boolean; output: string }>;
  config: {
    allowDirty: boolean;
    git: { enabled: boolean; author: { name: string; email: string } };
    timeoutMs: number;
    maxCommentsPerBatch: number;
  };
}

export interface BatchResult {
  state: BatchState;
  summary?: string;
  filesChanged: string[];
  sha?: string;
  error?: { kind: 'agent' | 'git' | 'config' | 'timeout'; message: string };
  baseSha?: string;
}

function commitMessage(batch: BatchRequest, summary: string): string {
  const subject = summary.split('\n')[0]!.trim().slice(0, 72) || 'Apply TapThat feedback';
  return `${subject}\n\nTapThat batch ${batch.batchId}\nPage: ${batch.page.url}`;
}

/**
 * The fast path, end to end. Ordering matters: the tree is checked before
 * anything runs, and the pre-run snapshot is what makes scoped recovery possible
 * on failure.
 */
export async function runJob(
  batch: BatchRequest,
  deps: JobDeps,
  emit: Emit,
): Promise<BatchResult> {
  const { repo, config } = deps;

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
  const before = await repo.status();
  if (!config.allowDirty && before.dirty.length > 0) {
    return {
      state: 'failed',
      filesChanged: [],
      error: {
        kind: 'git',
        message:
          `Working tree has uncommitted changes in ${before.dirty.length} file(s): ` +
          `${before.dirty.slice(0, 5).join(', ')}${before.dirty.length > 5 ? ', …' : ''}. ` +
          `Commit or stash them first — the agent's edits would be indistinguishable from yours.`,
      },
    };
  }

  // 2. Snapshot. Everything we may need to undo is defined relative to this.
  const baseSha = await repo.head();
  const knownUntracked = new Set(before.untracked);
  const preexistingDirty = new Set(before.dirty);
  emit({ batchId: batch.batchId, type: 'started', message: `base ${baseSha}` });

  // 3-4. Render the prompt. The sidecar variant fences the captured page
  //      content as untrusted data.
  const prompt = buildMarkdown(batch.comments, batch.page, {
    variant: 'sidecar',
    repoRoot: repo.root,
    batchId: batch.batchId,
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
  const touched = await repo.changedPaths(baseSha, knownUntracked);
  const agentTracked = touched.filter((p) => !preexistingDirty.has(p) && !knownUntracked.has(p));
  const after = await repo.status();
  const created = after.untracked.filter((p) => !knownUntracked.has(p));

  if (!result.ok) {
    // 7. Scoped recovery: only what this run touched.
    try {
      await repo.restorePaths(
        agentTracked.filter((p) => !created.includes(p)),
        created,
      );
    } catch (err) {
      emit({
        batchId: batch.batchId,
        type: 'failed',
        message: `cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const message = result.error?.trim() || 'The agent exited without applying a change.';
    emit({ batchId: batch.batchId, type: 'failed', message });
    return { state: 'failed', filesChanged: [], baseSha, error: { kind: 'agent', message } };
  }

  emit({ batchId: batch.batchId, type: 'files-changed', files: agentTracked });

  if (agentTracked.length === 0) {
    const message = 'The agent reported success but changed no files.';
    emit({ batchId: batch.batchId, type: 'failed', message });
    return { state: 'failed', filesChanged: [], baseSha, error: { kind: 'agent', message } };
  }

  // 6a. Verify before committing. The agent has no Bash, so it cannot know it
  //     broke the build; without this the reviewer sees "live" over a red overlay.
  if (deps.verify) {
    const verified = await deps.verify();
    if (!verified.ok) {
      emit({ batchId: batch.batchId, type: 'verify-failed', output: verified.output, files: agentTracked });
      // The edits stay on disk: HMR has already shown them, and silently
      // reverting would be more confusing than surfacing the break.
      return {
        state: 'applied-unverified',
        summary: result.summary,
        filesChanged: agentTracked,
        baseSha,
        error: { kind: 'agent', message: verified.output },
      };
    }
    emit({ batchId: batch.batchId, type: 'verify-passed' });
  }

  // 6b. Commit only the paths this run touched.
  if (!config.git.enabled) {
    return { state: 'applied', summary: result.summary, filesChanged: agentTracked, baseSha };
  }

  try {
    const sha = await repo.commitPaths(
      agentTracked,
      commitMessage(batch, result.summary),
      config.git.author,
    );
    if (sha) emit({ batchId: batch.batchId, type: 'committed', sha, files: agentTracked });
    return {
      state: sha ? 'committed' : 'applied',
      summary: result.summary,
      filesChanged: agentTracked,
      sha: sha ?? undefined,
      baseSha,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ batchId: batch.batchId, type: 'failed', message: `commit failed: ${message}` });
    return {
      state: 'applied',
      summary: result.summary,
      filesChanged: agentTracked,
      baseSha,
      error: { kind: 'git', message },
    };
  }
}

export type { BatchEvent };
