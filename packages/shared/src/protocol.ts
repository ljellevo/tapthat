import type { CommentRecord, PageContext } from './types';

/**
 * The extension↔sidecar wire contract. Lives in shared so a change to a response
 * shape breaks the typecheck on both sides at once rather than at runtime in a
 * reviewer's browser.
 */

export type BatchState =
  | 'queued'
  | 'running'
  | 'applied'
  | 'applied-unverified'
  | 'committed'
  | 'failed'
  | 'reverted';

export type BatchEventType =
  | 'accepted'
  | 'queued'
  | 'started'
  | 'prompt-rendered'
  | 'agent-message'
  | 'files-changed'
  | 'verify-passed'
  | 'verify-failed'
  | 'committed'
  | 'pushed'
  | 'push-failed'
  | 'failed'
  | 'reverted';

/** One repository's commit from a batch. A single-repo workspace has exactly one. */
export interface RepoCommit {
  repo: string;
  sha: string;
}

export interface BatchEvent {
  seq: number;
  batchId: string;
  at: string;
  type: BatchEventType;
  message?: string;
  /** In a multi-repo workspace, prefixed with the repo name: `api/src/routes/deals.ts`. */
  files?: string[];
  /** The first (or only) commit, kept for single-repo clients. */
  sha?: string;
  commits?: RepoCommit[];
  output?: string;
}

export interface BatchRequest {
  /** Client-generated, and the idempotency key: a replay must not run twice. */
  batchId: string;
  credentialHandle: string | null;
  page: PageContext;
  comments: CommentRecord[];
  client?: { name: string; version: string };
  /** Shown to teammates in the playground's pending changes. Free text, not an identity. */
  reviewer?: string;
}

export interface BatchAccepted {
  batchId: string;
  state: BatchState;
  queueDepth: number;
  baseSha: string | null;
  branch: string;
  eventsToken: string;
}

export interface BatchStatus {
  batchId: string;
  state: BatchState;
  createdAt: string;
  baseSha: string | null;
  branch: string;
  pageUrl: string;
  commentIds: string[];
  reviewer?: string | null;
  events: BatchEvent[];
  queueDepth: number;
  result: {
    summary: string;
    filesChanged: string[];
    /** The first (or only) commit, kept for single-repo clients. */
    sha?: string;
    commits?: RepoCommit[];
    durationMs: number;
  } | null;
  error: { kind: string; message: string } | null;
}

export interface CredentialInfo {
  handle: string;
  fingerprint: string;
  kind: 'api_key' | 'oauth_token';
  validated: boolean;
}

export interface RepoHealth {
  name: string;
  branch: string | null;
  head: string | null;
  clean: boolean | null;
}

export interface Health {
  status: 'ok' | 'degraded';
  version: string;
  /** The primary repository — the one whose dev server the reviewer is looking at. */
  repo: { branch: string | null; head: string | null; clean: boolean | null };
  /** Every repository in the workspace, primary first. */
  repos: RepoHealth[];
  devServer: { reachable: boolean; url: string };
  devServers: Array<{ name: string; url: string; reachable: boolean }>;
  queue: { depth: number; running: boolean };
  /**
   * `envCredential` tells the extension whether it must collect a credential
   * before the first Apply, or whether the sidecar will fall back to its own.
   */
  agent: { cliVersion: string | null; envCredential: boolean };
  killSwitch: boolean;
  /** `session`: changes collect in a playground session and reach `dev` on Commit. */
  mode: 'commit' | 'session';
  session: { id: string; state: SessionState; pending: number } | null;
}

// ── Sessions (git.mode "session": the playground flow) ─────────────────────

export type SessionState = 'starting' | 'active' | 'committing' | 'discarding' | 'failed';

export interface SessionEvent {
  at: string;
  message: string;
  /** Progress through a long step, e.g. copying databases: 2 of 5. */
  step?: number;
  steps?: number;
}

/** A batch that landed in the session and will travel with Commit. */
export interface PendingBatch {
  batchId: string;
  at: string;
  summary: string;
  files: string[];
  comments: string[];
  pageUrl: string;
  reviewer: string | null;
}

export interface SessionStatus {
  id: string;
  state: SessionState;
  startedAt: string;
  startedBy: string | null;
  /** The local branch batches collect on, in every repo. Never pushed. */
  branch: string;
  /** Each repo's `dev` head when the session started. */
  base: RepoCommit[];
  pending: PendingBatch[];
  /** What Commit would send, per repo that changed. */
  repos: Array<{ name: string; files: string[] }>;
  events: SessionEvent[];
  error: string | null;
}

export interface SessionOutcome {
  id: string;
  outcome: 'committed' | 'discarded';
  at: string;
  by: string | null;
  /** Committed: the new head of `dev` in each repo that changed. */
  commits: RepoCommit[];
  /** Things a human still has to do, e.g. sync a shared folder to other repos. */
  notices: string[];
}

/** GET /api/session */
export interface SessionResponse {
  mode: 'commit' | 'session';
  session: SessionStatus | null;
  last: SessionOutcome | null;
}

/** Body of POST /api/session/{start,commit,discard}. */
export interface SessionActionRequest {
  reviewer?: string;
}

/** GET /api/config — what the extension needs to configure itself from URL + token alone. */
export interface SidecarInfo {
  version: string;
  branch: string;
  allowedOrigins: string[];
  proxy: boolean;
  push: boolean;
}

export interface RevertAccepted {
  /** The first (or only) revert commit. */
  revertSha: string;
  commits?: RepoCommit[];
}

/**
 * SSE on GET /api/batches/:id/events?t=<eventsToken>. Every BatchEvent is sent
 * as a default `message` with `id: <seq>`, so a reconnect with Last-Event-ID
 * resumes exactly where it left off. When the batch reaches a terminal state the
 * stream sends one `done` event carrying the full BatchStatus, then closes.
 */
export const SSE_DONE_EVENT = 'done';

export interface ApiError {
  error: string;
  message?: string;
  conflicts?: string[];
}

/** Terminal states stop polling. */
export const TERMINAL_STATES: readonly BatchState[] = [
  'applied',
  'applied-unverified',
  'committed',
  'failed',
  'reverted',
];

export function isTerminal(state: BatchState): boolean {
  return TERMINAL_STATES.includes(state);
}
