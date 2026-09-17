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

export type Emit = (event: Omit<BatchEvent, 'seq' | 'at'>) => void;

/** Wraps a sink so every event gets a monotonic seq and a timestamp. */
export function sequencer(sink: (e: BatchEvent) => void): Emit {
  let seq = 0;
  return (event) => sink({ ...event, seq: seq++, at: new Date().toISOString() });
}
