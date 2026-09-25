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
  | 'failed'
  | 'reverted';

export interface BatchEvent {
  seq: number;
  batchId: string;
  at: string;
  type: BatchEventType;
  message?: string;
  files?: string[];
  sha?: string;
  output?: string;
}

export interface BatchRequest {
  /** Client-generated, and the idempotency key: a replay must not run twice. */
  batchId: string;
  credentialHandle: string | null;
  page: PageContext;
  comments: CommentRecord[];
  client?: { name: string; version: string };
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
  events: BatchEvent[];
  queueDepth: number;
  result: { summary: string; filesChanged: string[]; sha?: string; durationMs: number } | null;
  error: { kind: string; message: string } | null;
}

export interface CredentialInfo {
  handle: string;
  fingerprint: string;
  kind: 'api_key' | 'oauth_token';
  validated: boolean;
}

export interface Health {
  status: 'ok' | 'degraded';
  version: string;
  repo: { branch: string | null; head: string | null; clean: boolean | null };
  devServer: { reachable: boolean; url: string };
  queue: { depth: number; running: boolean };
  killSwitch: boolean;
}

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
