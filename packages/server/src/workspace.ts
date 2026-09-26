import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { RepoCommit } from 'tapthat-shared';
import type { Config, MirrorConfig, RepoConfig } from './config';
import { Repo } from './repo';
import { makeVerifier } from './verify';

export interface WorkspaceEntry {
  name: string;
  repo: Repo;
  /** Post-run build check for this repository, when it has one. */
  verify?: () => Promise<{ ok: boolean; output: string }>;
  config?: RepoConfig;
}

/**
 * The repositories one batch may change, side by side under one directory.
 *
 * A single-repo setup is a workspace of one, and then every path and message
 * reads exactly as it did before workspaces existed: nothing is prefixed.
 */
export class Workspace {
  constructor(
    /** The agent's working directory: the checkout itself, or the directory holding several. */
    readonly root: string,
    readonly entries: WorkspaceEntry[],
    readonly mirrors: MirrorConfig[] = [],
  ) {
    if (!entries.length) throw new Error('A workspace needs at least one repository.');
  }

  static single(repo: Repo, verify?: WorkspaceEntry['verify']): Workspace {
    return new Workspace(repo.root, [{ name: 'repo', repo, verify }]);
  }

  static fromConfig(config: Config, gitToken: string | null = null): Workspace {
    return new Workspace(
      config.workspaceRoot,
      config.repos.map((r) => ({
        name: r.name,
        repo: new Repo(r.root, gitToken),
        verify: makeVerifier(r.verifyCommand, r.root),
        config: r,
      })),
      config.mirrors,
    );
  }

  get primary(): WorkspaceEntry {
    return this.entries[0]!;
  }

  get multi(): boolean {
    return this.entries.length > 1;
  }

  get(name: string): WorkspaceEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  /** `api/src/x.ts` in a multi-repo workspace, `src/x.ts` in a single one. */
  label(name: string, path: string): string {
    return this.multi ? `${name}/${path}` : path;
  }

  /** Where a repository sits relative to the agent's working directory. */
  relativePath(entry: WorkspaceEntry): string {
    return relative(this.root, entry.repo.root) || '.';
  }
}

const MIRROR_SKIP = new Set(['node_modules', 'generated', '.DS_Store', '.git']);

async function listFiles(dir: string, base = dir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (MIRROR_SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out;
}

/**
 * Makes `dst` an exact copy of `src`: new and changed files copied, files that
 * no longer exist in `src` deleted. Installed and generated files are left
 * alone — the same rules as Dealroom's `sync.sh`. Returns the paths it wrote or
 * removed, relative to `dst`.
 */
export async function mirrorDirectory(src: string, dst: string): Promise<string[]> {
  const [from, to] = await Promise.all([listFiles(src), listFiles(dst)]);
  const wanted = new Set(from);
  const changed: string[] = [];

  for (const file of from) {
    const a = await readFile(join(src, file));
    const b = await readFile(join(dst, file)).catch(() => null);
    if (b && a.equals(b)) continue;
    await mkdir(join(dst, file, '..'), { recursive: true });
    await copyFile(join(src, file), join(dst, file));
    changed.push(file);
  }
  for (const file of to) {
    if (wanted.has(file)) continue;
    await rm(join(dst, file), { force: true });
    changed.push(file);
  }
  return changed.sort();
}

export type RevertOutcome =
  | { ok: true; commits: RepoCommit[] }
  | { ok: false; kind: 'dirty' | 'conflict' | 'revert_failed'; repo: string; conflicts: string[]; message: string };

/**
 * Undo for a batch that committed in several repositories: every repository or
 * none. Each revert is staged first; only when all of them apply cleanly is
 * anything committed. A conflict anywhere abandons every staged revert, so the
 * reviewer never ends up with the API undone and the page still depending on it.
 */
export async function revertAll(
  ws: Workspace,
  commits: RepoCommit[],
  author: { name: string; email: string },
): Promise<RevertOutcome> {
  const targets = commits.map((c) => ({ commit: c, entry: ws.get(c.repo) ?? ws.primary }));

  for (const { entry } of targets) {
    if (!(await entry.repo.isClean())) {
      return {
        ok: false,
        kind: 'dirty',
        repo: entry.name,
        conflicts: [],
        message: `${ws.multi ? `${entry.name}: ` : ''}The working tree has uncommitted changes; undo refused.`,
      };
    }
  }

  const staged: WorkspaceEntry[] = [];
  for (const { commit, entry } of targets) {
    const outcome = await entry.repo.stageRevert(commit.sha);
    if (!outcome.ok) {
      for (const done of staged) await done.repo.abandonRevert().catch(() => {});
      return {
        ok: false,
        kind: outcome.conflicts.length ? 'conflict' : 'revert_failed',
        repo: entry.name,
        conflicts: outcome.conflicts.map((p) => ws.label(entry.name, p)),
        message: outcome.message,
      };
    }
    staged.push(entry);
  }

  const reverted: RepoCommit[] = [];
  for (const { commit, entry } of targets) {
    reverted.push({ repo: entry.name, sha: await entry.repo.commitRevert(commit.sha, author) });
  }
  return { ok: true, commits: reverted };
}
