import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { Repo } from './repo';
import type { Progress } from './session';

/**
 * Start session's clean slate: everything git ignores is removed, except what
 * the playground cannot run without. Build output and caches (`.next`, a
 * turbopack cache that only grows) and files earlier sessions left behind go;
 * installed dependencies, secrets and the sidecar's own state stay.
 */

/** Kept in every repo, whatever the config says. */
export const ALWAYS_KEPT = ['node_modules', '.env', '.env.*'];

/** The branch prefix sessions use; none may be left over when a new one starts. */
export const SESSION_BRANCH_PREFIX = 'tapthat/session-';

export interface CleanDeps {
  repos: Array<{ name: string; repo: Repo }>;
  /** Names (a `*` matches anything) kept wherever they appear. */
  keep: string[];
  /** Absolute paths never removed: the sidecar's state may live inside a checkout. */
  protect: string[];
  /** Nothing may be serving from, or writing to, build output while it is removed. */
  stopServers(): Promise<void>;
  startServers(): Promise<void>;
  /** Reinstalls a repo whose lockfile changed; throws when the install fails. */
  install(name: string): Promise<void>;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

/**
 * Removes `path` except the kept names and protected paths somewhere beneath it.
 * Returns the bytes freed and whether anything under it survived.
 */
async function prune(path: string, isKept: (name: string) => boolean, protect: string[]): Promise<{ bytes: number; kept: boolean }> {
  if (isKept(basename(path)) || protect.some((p) => inside(path, p))) return { bytes: 0, kept: true };
  const stat = await lstat(path).catch(() => null);
  if (!stat) return { bytes: 0, kept: false };
  if (!stat.isDirectory()) {
    await rm(path, { force: true });
    return { bytes: stat.size, kept: false };
  }
  let bytes = 0;
  let kept = false;
  for (const child of await readdir(path)) {
    const r = await prune(join(path, child), isKept, protect);
    bytes += r.bytes;
    kept ||= r.kept;
  }
  if (!kept) await rm(path, { recursive: true, force: true });
  return { bytes, kept };
}

/** Removes a repo's ignored files, keeping the given names and paths. */
export async function pruneIgnored(
  repo: Repo,
  keep: string[],
  protect: string[] = [],
): Promise<{ removed: string[]; bytes: number }> {
  const patterns = [...ALWAYS_KEPT, ...keep].map(globToRegExp);
  const isKept = (name: string) => patterns.some((p) => p.test(name));
  const guarded = protect.map((p) => resolve(p));

  const removed: string[] = [];
  let bytes = 0;
  for (const entry of await repo.ignored()) {
    // `api/shared/db/generated/` is kept by `generated`, whichever segment matches.
    if (entry.split('/').some((segment) => segment && isKept(segment))) continue;
    const full = resolve(repo.root, entry);
    if (relative(repo.root, full).startsWith('..')) continue;
    const r = await prune(full, isKept, guarded);
    bytes += r.bytes;
    if (!r.kept) removed.push(entry);
  }
  return { removed, bytes };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** Runs while starting a session, after the code is up to date with dev. */
export function makeCleanStep(deps: CleanDeps): (progress: Progress) => Promise<void> {
  return async (progress) => {
    progress('Stopping the dev servers…');
    await deps.stopServers();
    try {
      let bytes = 0;
      for (const [i, { name, repo }] of deps.repos.entries()) {
        progress(`Clearing build output and caches… ${name}`, i + 1, deps.repos.length);
        const r = await pruneIgnored(repo, deps.keep, deps.protect);
        bytes += r.bytes;
        if (r.removed.length) console.log(`[tapthat] ${name}: cleared ${r.removed.join(', ')} (${formatBytes(r.bytes)})`);
        for (const branch of await repo.branchesStartingWith(SESSION_BRANCH_PREFIX)) {
          await repo.deleteBranch(branch);
        }
      }
      progress(`Cleared ${formatBytes(bytes)} of build output and caches.`);
      for (const { name } of deps.repos) await deps.install(name);
    } finally {
      progress('Starting the dev servers…');
      await deps.startServers();
    }
  };
}
