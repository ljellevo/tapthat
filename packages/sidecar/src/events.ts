import type { BatchEvent } from '@tapthat/shared';

export type { BatchEvent, BatchEventType, BatchState } from '@tapthat/shared';

export type Emit = (event: Omit<BatchEvent, 'seq' | 'at'>) => void;

/** Wraps a sink so every event gets a monotonic seq and a timestamp. */
export function sequencer(sink: (e: BatchEvent) => void): Emit {
  let seq = 0;
  return (event) => sink({ ...event, seq: seq++, at: new Date().toISOString() });
}
