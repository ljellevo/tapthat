import { pageKey } from './store';
import type { TrackedBatch } from '../sidecar/tracked';

/** Enough history for the panel and a resume; older runs live in git. */
const KEEP = 5;

const keyFor = () => `av:batch:${pageKey()}`;
let cache: TrackedBatch[] = [];

export async function load(): Promise<TrackedBatch[]> {
  try {
    const key = keyFor();
    const bag = await chrome.storage.local.get(key);
    cache = (bag[key] as TrackedBatch[] | undefined) ?? [];
  } catch {
    cache = [];
  }
  return cache;
}

export function list(): TrackedBatch[] {
  return cache;
}

export function latest(): TrackedBatch | null {
  return [...cache].reverse().find((b) => !b.dismissed) ?? null;
}

export async function put(batch: TrackedBatch): Promise<void> {
  const rest = cache.filter((b) => b.batchId !== batch.batchId);
  cache = [...rest, batch].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-KEEP);
  await chrome.storage.local.set({ [keyFor()]: cache }).catch(() => {});
}

export function get(batchId: string): TrackedBatch | undefined {
  return cache.find((b) => b.batchId === batchId);
}
