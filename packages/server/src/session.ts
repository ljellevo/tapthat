import { randomBytes } from 'node:crypto';
import type {
  PendingBatch,
  RepoCommit,
  SessionEvent,
  SessionOutcome,
  SessionResponse,
  SessionStatus,
} from 'tapthat-shared';
import type { Audit } from './audit';
import { subjectLine } from './job';
import type { Config } from './config';
import type { Queue } from './queue';
import type { Store, StoredSession } from './store';
import type { Workspace, WorkspaceEntry } from './workspace';

/**
 * The playground flow (git.mode "session").
 *
 * A reviewer starts a session, which brings every repository (and, with a
 * snapshot hook, the data) up to date with `dev`. Batches then collect as
 * commits on a local session branch — undoable one by one, never pushed. Commit
 * squashes the session per repository, replays it onto the latest `dev`, and
 * pushes; the platform deploys `dev` from there. Discard throws it all away.
 *
 * No step resets a working tree. Commit builds its commits with plumbing
 * (`commit-tree`, `merge-tree`), so the playground stays exactly as reviewers
 * see it until the push has succeeded everywhere.
 */

export type Progress = (message: string, step?: number, steps?: number) => void;

/** Where the data half of a session plugs in (Phase 2b: a database dump). */
export interface SessionHooks {
  /** Runs while starting, after the code is up to date with dev. */
  onStart?(progress: Progress): Promise<void>;
  /** Runs while discarding, after the code is back on dev. */
  onDiscard?(progress: Progress): Promise<void>;
}

export class SessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface SessionDeps {
  config: Config;
  workspace: Workspace;
  store: Store;
  queue: Queue;
  audit: Audit;
  hooks?: SessionHooks;
}

const BUSY: ReadonlySet<string> = new Set(['starting', 'committing', 'discarding']);

function sessionId(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export class Sessions {
  constructor(private readonly deps: SessionDeps) {}

  get enabled(): boolean {
    return this.deps.config.git.mode === 'session';
  }

  current(): StoredSession | null {
    return this.deps.store.getSession();
  }

  /** The branch a repo may legitimately have checked out right now. */
  allowedBranches(): string[] {
    const s = this.current();
    return s && s.state !== 'failed' ? [this.deps.config.branch, s.branch] : [this.deps.config.branch];
  }

  /**
   * Null when a batch may run now. Session mode needs an active session, so
   * a reviewer can never apply changes onto a playground that is halfway
   * through restoring data or pushing to dev.
   */
  gate(): SessionError | null {
    if (!this.enabled) return null;
    const s = this.current();
    if (!s || s.state === 'failed') {
      return new SessionError(409, 'no_session', 'No session is active. Start a session first.');
    }
    if (s.state !== 'active') {
      return new SessionError(409, 'session_busy', `The session is ${s.state}. Try again when it is done.`);
    }
    return null;
  }

  recordBatch(batchId: string): void {
    const s = this.current();
    if (!s || s.batchIds.includes(batchId)) return;
    s.batchIds.push(batchId);
    this.deps.store.putSession(s);
  }

  /**
   * After a restart: a session caught mid-step cannot be trusted, and says so
   * rather than pretending to be active.
   */
  async reconcile(): Promise<void> {
    const s = this.current();
    if (!s) return;
    if (BUSY.has(s.state)) {
      this.fail(s, `The sidecar restarted while the session was ${s.state}. Discard it and start again.`);
      return;
    }
    if (s.state === 'active') {
      for (const e of this.deps.workspace.entries) {
        const on = await e.repo.branch().catch(() => null);
        if (on !== s.branch) {
          this.fail(s, `${e.name} is no longer on the session branch (${on ?? 'unknown'}). Discard the session and start again.`);
          return;
        }
      }
    }
  }

  // ── status ───────────────────────────────────────────────────────────────

  async status(): Promise<SessionResponse> {
    const s = this.current();
    return {
      mode: this.deps.config.git.mode,
      session: s ? await this.describe(s) : null,
      last: this.deps.store.getLastSession(),
    };
  }

  private async describe(s: StoredSession): Promise<SessionStatus> {
    const { batchIds, ...rest } = s;
    const repos: SessionStatus['repos'] = [];
    for (const e of this.deps.workspace.entries) {
      const base = s.base.find((b) => b.repo === e.name)?.sha;
      if (!base) continue;
      const files = await e.repo.diffNames(base).catch(() => [] as string[]);
      if (files.length) repos.push({ name: e.name, files });
    }
    return { ...rest, pending: this.pending(batchIds), repos };
  }

  private pending(batchIds: string[]): PendingBatch[] {
    return batchIds.flatMap((id) => {
      const b = this.deps.store.getBatch(id);
      if (!b || b.state !== 'committed') return [];
      return [
        {
          batchId: id,
          at: b.createdAt,
          summary: b.result?.summary ?? '',
          files: b.result?.filesChanged ?? [],
          comments: b.commentTexts ?? [],
          pageUrl: b.pageUrl,
          reviewer: b.reviewer ?? null,
        },
      ];
    });
  }

  // ── start ────────────────────────────────────────────────────────────────

  /** Returns at once; progress is in the session's events. */
  start(reviewer: string | null): StoredSession {
    if (!this.enabled) throw new SessionError(409, 'not_session_mode', 'This sidecar commits every batch directly (git.mode "commit").');
    const existing = this.current();
    if (existing && existing.state !== 'failed') {
      const pending = this.pending(existing.batchIds).length;
      throw new SessionError(
        409,
        existing.state === 'active' ? 'session_active' : 'session_busy',
        existing.state === 'active'
          ? `A session is already running${pending ? ` with ${pending} pending change(s). Commit or discard it first` : ''}.`
          : `The session is ${existing.state}.`,
      );
    }
    if (existing?.state === 'failed') {
      throw new SessionError(409, 'session_failed', 'The last session failed. Discard it first, which also resets the data.');
    }

    const id = sessionId();
    const session: StoredSession = {
      id,
      state: 'starting',
      startedAt: new Date().toISOString(),
      startedBy: reviewer,
      branch: `tapthat/session-${id}`,
      base: [],
      events: [],
      error: null,
      batchIds: [],
    };
    this.deps.store.putSession(session);
    void this.deps.queue.run(this.deps.config.branch, () => this.runStart(session)).catch((err) => {
      this.fail(session, err instanceof Error ? err.message : String(err));
    });
    return session;
  }

  private async runStart(s: StoredSession): Promise<void> {
    const { config, workspace, hooks } = this.deps;
    const progress = this.progress(s);

    progress('Updating the code from dev…');
    for (const e of workspace.entries) {
      await this.backToBase(e, 'start');
      await e.repo.fetch(config.git.remote, this.branchOf(e));
      await e.repo.fastForwardTo(`${config.git.remote}/${this.branchOf(e)}`).catch((err: unknown) => {
        throw new Error(`${e.name}: dev has diverged from the playground's copy and cannot be fast-forwarded (${String(err)})`);
      });
    }

    if (hooks?.onStart) await hooks.onStart(progress);

    const base: RepoCommit[] = [];
    for (const e of workspace.entries) {
      base.push({ repo: e.name, sha: await e.repo.resolveRef('HEAD') });
      await e.repo.switchNew(s.branch, 'HEAD');
    }
    s.base = base;
    s.state = 'active';
    progress('Session started.');
    this.deps.audit('session.started', { session: s.id, by: s.startedBy, base });
  }

  // ── commit ───────────────────────────────────────────────────────────────

  async commit(reviewer: string | null): Promise<SessionOutcome> {
    const s = this.requireActive();
    return this.deps.queue.run(this.deps.config.branch, async () => {
      s.state = 'committing';
      this.save(s);
      try {
        const outcome = await this.runCommit(s, reviewer);
        return outcome;
      } catch (err) {
        // A refusal before anything was pushed leaves the session exactly as it was.
        const pushed = err instanceof SessionError ? (err.details.pushed as RepoCommit[] | undefined) : undefined;
        if (err instanceof SessionError && !pushed?.length) {
          s.state = 'active';
          this.save(s);
        } else {
          this.fail(s, err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    });
  }

  private async runCommit(s: StoredSession, reviewer: string | null): Promise<SessionOutcome> {
    const { config, workspace } = this.deps;
    const progress = this.progress(s);
    const pending = this.pending(s.batchIds);
    const message = this.commitMessage(s, pending, reviewer);

    // 1. Every repo, before anything leaves the playground.
    const plans: Array<{ entry: WorkspaceEntry; result: string; files: string[] }> = [];
    const conflicts: string[] = [];
    for (const e of this.ordered()) {
      const status = await e.repo.status();
      if (status.dirty.length || status.untracked.length) {
        const paths = [...status.dirty, ...status.untracked].map((p) => workspace.label(e.name, p));
        throw new SessionError(
          409,
          'dirty',
          `${e.name} has changes that were never committed (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}) — usually a batch whose build broke. Undo or fix it first.`,
          { paths },
        );
      }
      const base = s.base.find((b) => b.repo === e.name)!.sha;
      const files = await e.repo.diffNames(base);
      if (!files.length) continue;

      progress(`Preparing ${e.name}…`);
      await e.repo.fetch(config.git.remote, this.branchOf(e));
      const remoteHead = await e.repo.resolveRef(`${config.git.remote}/${this.branchOf(e)}`);
      // The whole session as one commit on top of its base: HEAD's tree, base as parent.
      const squash = await e.repo.commitTree('HEAD^{tree}', base, message, config.git.author);
      let result = squash;
      if (remoteHead !== base) {
        // dev moved on while the session ran: replay the session on top of it.
        const merged = await e.repo.mergeTrees(remoteHead, squash);
        if (!merged.ok) {
          conflicts.push(...merged.conflicts.map((p) => workspace.label(e.name, p)));
          continue;
        }
        result = await e.repo.commitTree(merged.tree, remoteHead, message, config.git.author);
      }
      plans.push({ entry: e, result, files });
    }

    if (conflicts.length) {
      throw new SessionError(
        409,
        'conflict',
        `Someone changed the same lines on dev since this session started (${conflicts.join(', ')}). Nothing was sent. A developer needs to merge these by hand.`,
        { conflicts },
      );
    }
    if (!plans.length) throw new SessionError(409, 'nothing_to_commit', 'This session has no changes to send.');

    // 2. Push, in deploy order: the API before the app that depends on it.
    const pushed: RepoCommit[] = [];
    for (const { entry, result } of plans) {
      progress(`Sending ${entry.name} to ${this.branchOf(entry)}…`);
      try {
        await entry.repo.pushCommit(config.git.remote, result, this.branchOf(entry));
      } catch (err) {
        throw new SessionError(
          502,
          'push_failed',
          `Pushing ${entry.name} failed: ${err instanceof Error ? err.message : String(err)}` +
            (pushed.length ? ` Already sent: ${pushed.map((p) => p.repo).join(', ')}.` : ''),
          { pushed },
        );
      }
      pushed.push({ repo: entry.name, sha: result.slice(0, 7) });
    }

    // 3. The playground moves onto the new dev, and the session ends.
    for (const e of workspace.entries) {
      await this.backToBase(e, 'commit');
      await e.repo.fetch(config.git.remote, this.branchOf(e));
      await e.repo.fastForwardTo(`${config.git.remote}/${this.branchOf(e)}`);
      await e.repo.deleteBranch(s.branch).catch(() => {});
    }

    const outcome: SessionOutcome = {
      id: s.id,
      outcome: 'committed',
      at: new Date().toISOString(),
      by: reviewer,
      commits: pushed,
      notices: this.notices(plans),
    };
    this.end(outcome);
    this.deps.audit('session.committed', { session: s.id, by: reviewer, commits: pushed, batches: s.batchIds });
    return outcome;
  }

  private commitMessage(s: StoredSession, pending: PendingBatch[], reviewer: string | null): string {
    const n = pending.length;
    const subject =
      n === 1 && pending[0]!.summary
        ? subjectLine(pending[0]!.summary)
        : `TapThat: ${n || 'no'} change${n === 1 ? '' : 's'} from the playground`;
    const lines = [subject, ''];
    for (const p of pending) {
      lines.push(`- ${p.summary.split('\n')[0] || 'Change'}${p.reviewer ? ` (${p.reviewer})` : ''}`);
      for (const c of p.comments) lines.push(`    "${c.split('\n')[0]}"`);
    }
    const reviewers = [...new Set([reviewer, s.startedBy, ...pending.map((p) => p.reviewer)].filter(Boolean))];
    lines.push('', `TapThat-Session: ${s.id}`);
    if (reviewers.length) lines.push(`Reviewed-by: ${reviewers.join(', ')}`);
    return lines.join('\n');
  }

  /** Shared folders that other repositories copy, and that this session changed. */
  private notices(plans: Array<{ entry: WorkspaceEntry; files: string[] }>): string[] {
    return this.deps.workspace.mirrors.flatMap((m) => {
      const plan = plans.find((p) => p.entry.name === m.from.repo);
      const changed = plan?.files.some((f) => f === m.from.path || f.startsWith(`${m.from.path}/`));
      return changed && m.alsoUsedBy.length
        ? [`${m.from.repo}/${m.from.path} changed. ${m.alsoUsedBy.join(', ')} keep their own copy: sync it there too.`]
        : [];
    });
  }

  // ── discard ──────────────────────────────────────────────────────────────

  async discard(reviewer: string | null): Promise<SessionOutcome> {
    const s = this.current();
    if (!s) throw new SessionError(409, 'no_session', 'There is no session to discard.');
    if (BUSY.has(s.state)) throw new SessionError(409, 'session_busy', `The session is ${s.state}. Try again when it is done.`);

    return this.deps.queue.run(this.deps.config.branch, async () => {
      s.state = 'discarding';
      this.save(s);
      const progress = this.progress(s);
      try {
        progress('Putting the code back to dev…');
        for (const e of this.deps.workspace.entries) {
          await this.backToBase(e, 'discard');
          await e.repo.deleteBranch(s.branch).catch(() => {});
        }
        if (this.deps.hooks?.onDiscard) await this.deps.hooks.onDiscard(progress);
      } catch (err) {
        this.fail(s, err instanceof Error ? err.message : String(err));
        throw err;
      }
      const outcome: SessionOutcome = {
        id: s.id,
        outcome: 'discarded',
        at: new Date().toISOString(),
        by: reviewer,
        commits: [],
        notices: [],
      };
      this.end(outcome);
      this.deps.audit('session.discarded', { session: s.id, by: reviewer, batches: s.batchIds });
      return outcome;
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private branchOf(e: WorkspaceEntry): string {
    return e.config?.branch ?? this.deps.config.branch;
  }

  /** Deploy order first, then the rest in workspace order. */
  private ordered(): WorkspaceEntry[] {
    const order = this.deps.config.git.deployOrder;
    const rank = (e: WorkspaceEntry) => (order.includes(e.name) ? order.indexOf(e.name) : order.length);
    return [...this.deps.workspace.entries].sort((a, b) => rank(a) - rank(b));
  }

  /**
   * Returns a repo to its base branch. For discard, whatever the session left
   * in the tree — a broken build's edits — is restored path by path first;
   * this checkout belongs to the playground, but there is still no hard reset.
   */
  private async backToBase(e: WorkspaceEntry, why: 'start' | 'commit' | 'discard'): Promise<void> {
    const status = await e.repo.status();
    if (status.dirty.length || status.untracked.length) {
      if (why !== 'discard') {
        throw new Error(`${e.name} has uncommitted changes (${[...status.dirty, ...status.untracked].slice(0, 3).join(', ')}). Discard first.`);
      }
      await e.repo.restorePaths(status.dirty, status.untracked);
    }
    if ((await e.repo.branch()) !== this.branchOf(e)) await e.repo.switchTo(this.branchOf(e));
  }

  private requireActive(): StoredSession {
    const gate = this.gate();
    if (gate) throw gate;
    return this.current()!;
  }

  private progress(s: StoredSession): Progress {
    return (message, step, steps) => {
      const event: SessionEvent = { at: new Date().toISOString(), message, step, steps };
      s.events.push(event);
      if (s.events.length > 200) s.events.splice(0, s.events.length - 200);
      this.save(s);
    };
  }

  private save(s: StoredSession): void {
    this.deps.store.putSession(s);
  }

  private fail(s: StoredSession, message: string): void {
    s.state = 'failed';
    s.error = message;
    s.events.push({ at: new Date().toISOString(), message });
    this.save(s);
    this.deps.audit('session.failed', { session: s.id, error: message });
  }

  private end(outcome: SessionOutcome): void {
    this.deps.store.putLastSession(outcome);
    this.deps.store.putSession(null);
  }
}
