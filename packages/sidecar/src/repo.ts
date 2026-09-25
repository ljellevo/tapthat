import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Git operations, scoped to one working tree.
 *
 * This module deliberately exposes NO reset() and no `git add -A`. The sidecar
 * frequently shares a developer's real checkout (the `npx` path), where a hard
 * reset on a failed job would delete their uncommitted work with no undo, and an
 * `add -A` would sweep unrelated changes into an agent's commit. Recovery is
 * always scoped to the paths the agent actually touched — so the unsafe call has
 * nowhere in the codebase to live.
 */
export interface RepoStatus {
  /** Paths with staged or unstaged modifications, relative to the repo root. */
  dirty: string[];
  /** Paths git does not track. */
  untracked: string[];
}

export class Repo {
  constructor(readonly root: string) {}

  private async gitRaw(...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, {
      cwd: this.root,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  private async git(...args: string[]): Promise<string> {
    return (await this.gitRaw(...args)).trim();
  }

  /**
   * Returns null when this is a usable worktree, or the reason it is not.
   *
   * Distinguishing "not a repo" from "git could not read it" matters: a
   * permissions or ownership problem reported as "not a git working tree" sends
   * you looking in entirely the wrong place.
   */
  async worktreeProblem(): Promise<string | null> {
    try {
      const inside = await this.git('rev-parse', '--is-inside-work-tree');
      return inside === 'true' ? null : `${this.root} is not a git working tree.`;
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
      if (/not a git repository/i.test(stderr)) {
        return `${this.root} is not a git working tree.`;
      }
      return `Could not read the git repository at ${this.root}:\n  ${stderr || String(err)}`;
    }
  }

  async isGitWorktree(): Promise<boolean> {
    return (await this.worktreeProblem()) === null;
  }

  async head(): Promise<string> {
    return this.git('rev-parse', '--short', 'HEAD');
  }

  async branch(): Promise<string> {
    return this.git('rev-parse', '--abbrev-ref', 'HEAD');
  }

  /**
   * Porcelain v1, -z so paths containing spaces or newlines survive. Entries are
   * NUL-terminated `XY path`; renames add a second NUL-terminated path we skip.
   */
  async status(): Promise<RepoStatus> {
    // gitRaw, not git: porcelain's first column is significant whitespace, so
    // trimming ' M app.js' to 'M app.js' would shift every path by one character.
    const raw = await this.gitRaw('status', '--porcelain', '-z', '--untracked-files=all');
    const dirty: string[] = [];
    const untracked: string[] = [];

    const parts = raw.split('\0').filter((p) => p.length > 0);
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (code === '??') {
        untracked.push(path);
      } else {
        dirty.push(path);
        // A rename entry is followed by its origin path; don't read it as a file.
        if (code.includes('R')) i++;
      }
    }

    return { dirty, untracked };
  }

  async isClean(): Promise<boolean> {
    const { dirty, untracked } = await this.status();
    return dirty.length === 0 && untracked.length === 0;
  }

  /**
   * Tracked files modified since `sinceSha`, plus anything newly untracked.
   * This is ground truth for what a run changed — never the agent's own report
   * of what it edited.
   */
  async changedPaths(sinceSha: string, knownUntracked: ReadonlySet<string>): Promise<string[]> {
    const { dirty, untracked } = await this.status();
    const fresh = untracked.filter((p) => !knownUntracked.has(p));

    let committedSince: string[] = [];
    const head = await this.head();
    if (head !== sinceSha) {
      const out = await this.gitRaw('diff', '--name-only', '-z', `${sinceSha}..HEAD`);
      committedSince = out.split('\0').filter((p) => p.length > 0);
    }

    return [...new Set([...dirty, ...fresh, ...committedSince])].sort();
  }

  /**
   * Undo a failed run without touching anything else in the tree: restore only
   * the tracked paths the agent modified, and delete only the untracked files it
   * created. Files that were already dirty or already untracked are left exactly
   * as they were.
   */
  async restorePaths(tracked: string[], created: string[]): Promise<void> {
    if (tracked.length) {
      await this.git('checkout', '--', ...tracked);
    }
    for (const path of created) {
      await rm(join(this.root, path), { force: true, recursive: true });
    }
  }

  async commitPaths(
    paths: string[],
    message: string,
    author: { name: string; email: string },
  ): Promise<string | null> {
    if (!paths.length) return null;
    await this.git('add', '--', ...paths);

    // `add` on an unchanged path stages nothing; committing then fails rather
    // than making an empty commit, so check first.
    const staged = await this.git('diff', '--cached', '--name-only');
    if (!staged) return null;

    await this.git(
      '-c',
      `user.name=${author.name}`,
      '-c',
      `user.email=${author.email}`,
      'commit',
      '--no-verify',
      '-m',
      message,
    );
    return this.head();
  }

  async revert(sha: string): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[] }> {
    try {
      await this.git('revert', '--no-edit', sha);
      return { ok: true, sha: await this.head() };
    } catch {
      // A conflicted revert leaves the tree mid-operation; abort so the next job
      // starts from a clean state rather than inheriting the conflict.
      const { dirty } = await this.status();
      await this.git('revert', '--abort').catch(() => {});
      return { ok: false, conflicts: dirty };
    }
  }
}
