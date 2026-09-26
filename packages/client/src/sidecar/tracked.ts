import { isTerminal, type BatchAccepted, type BatchEvent, type BatchState, type BatchStatus, type RepoCommit } from 'tapthat-shared';

/**
 * A batch as the extension tracks it. Ephemeral run state, deliberately kept
 * off CommentRecord: it is persisted per page so a mid-run reload (HMR will
 * cause some) picks the thread back up, but it never travels with an export.
 */
export interface TrackedBatch {
  batchId: string;
  eventsToken: string | null;
  state: BatchState;
  createdAt: string;
  commentIds: string[];
  baseSha: string | null;
  branch: string;
  /** Jobs ahead of this one when it was accepted. */
  ahead: number;
  lastSeq: number;
  /** Latest agent chatter, one line — so a 30s run visibly moves. */
  progress: string | null;
  filesChanged: string[];
  summary: string | null;
  sha: string | null;
  /** One per repository in a multi-repo workspace. */
  commits: RepoCommit[];
  pushed: 'yes' | 'failed' | null;
  error: { kind: string; message: string } | null;
  /** Compiler output from verifyCommand, when the build broke. */
  verifyOutput: string | null;
  dismissed: boolean;
}

/** What the reviewer sees on a comment: the plan's six states plus undo. */
export type Phase = 'queued' | 'editing' | 'live' | 'committed' | 'unverified' | 'failed' | 'reverted';

export function track(accepted: BatchAccepted, commentIds: string[]): TrackedBatch {
  return {
    batchId: accepted.batchId,
    eventsToken: accepted.eventsToken,
    state: accepted.state,
    createdAt: new Date().toISOString(),
    commentIds,
    baseSha: accepted.baseSha,
    branch: accepted.branch,
    ahead: accepted.queueDepth,
    lastSeq: -1,
    progress: null,
    filesChanged: [],
    summary: null,
    sha: null,
    commits: [],
    pushed: null,
    error: null,
    verifyOutput: null,
    dismissed: false,
  };
}

export function applyEvent(batch: TrackedBatch, event: BatchEvent): TrackedBatch {
  if (event.seq <= batch.lastSeq) return batch;
  const next: TrackedBatch = { ...batch, lastSeq: event.seq };
  switch (event.type) {
    case 'started':
      next.state = 'running';
      next.progress = 'Reading the code…';
      break;
    case 'agent-message':
      next.progress = event.message?.split('\n').find((l) => l.trim())?.slice(0, 140) ?? next.progress;
      break;
    case 'files-changed':
      next.filesChanged = event.files ?? [];
      break;
    case 'verify-failed':
      next.state = 'applied-unverified';
      next.verifyOutput = event.output ?? null;
      break;
    case 'committed':
      next.state = 'committed';
      next.sha = event.sha ?? null;
      next.commits = event.commits ?? (event.sha ? [{ repo: '', sha: event.sha }] : []);
      break;
    case 'pushed':
      next.pushed = 'yes';
      break;
    case 'push-failed':
      next.pushed = 'failed';
      break;
    case 'reverted':
      next.state = 'reverted';
      break;
    // 'failed' events can be non-terminal (a failed cleanup, a failed commit);
    // the terminal state arrives with the done status.
    default:
      break;
  }
  return next;
}

export function applyStatus(batch: TrackedBatch, status: BatchStatus): TrackedBatch {
  let next = batch;
  for (const event of status.events) next = applyEvent(next, event);
  return {
    ...next,
    state: status.state,
    summary: status.result?.summary || next.summary,
    filesChanged: status.result?.filesChanged.length ? status.result.filesChanged : next.filesChanged,
    sha: status.result?.sha ?? next.sha,
    commits: status.result?.commits ?? next.commits ?? [],
    error: status.error,
    verifyOutput: status.state === 'applied-unverified' ? (next.verifyOutput ?? status.error?.message ?? null) : next.verifyOutput,
  };
}

export function phaseOf(batch: TrackedBatch): Phase {
  switch (batch.state) {
    case 'queued':
      return 'queued';
    case 'running':
      // Files on disk means HMR has already pushed them: the change is live.
      return batch.filesChanged.length ? 'live' : 'editing';
    case 'applied':
      return 'live';
    case 'applied-unverified':
      return 'unverified';
    case 'committed':
      return 'committed';
    case 'failed':
      return 'failed';
    case 'reverted':
      return 'reverted';
  }
}

export function isFinished(batch: TrackedBatch): boolean {
  return isTerminal(batch.state);
}

/** Latest phase per comment, newest batch wins; dismissed batches drop out. */
export function commentPhases(batches: TrackedBatch[]): Map<string, Phase> {
  const phases = new Map<string, Phase>();
  for (const batch of batches) {
    if (batch.dismissed) continue;
    for (const id of batch.commentIds) phases.set(id, phaseOf(batch));
  }
  return phases;
}
