import type { CommentRecord, PageSession } from '../types';

/**
 * Storage key ignores query string and hash so pins survive SPA param churn
 * (?tab=2, #section) while still separating genuinely different routes.
 */
export function pageKey(): string {
  return `av:${location.origin}${location.pathname}`;
}

type Listener = (comments: CommentRecord[]) => void;

const listeners = new Set<Listener>();
let cache: CommentRecord[] = [];

function emit() {
  for (const fn of listeners) fn(cache);
}

async function write() {
  const session: PageSession = {
    key: pageKey(),
    url: location.href,
    title: document.title,
    comments: cache,
  };
  await chrome.storage.local.set({ [pageKey()]: session });
  chrome.runtime.sendMessage({ type: 'COUNT', count: cache.filter((c) => !c.resolved).length }).catch(() => {});
  emit();
}

export async function load(): Promise<CommentRecord[]> {
  const key = pageKey();
  const bag = await chrome.storage.local.get(key);
  const session = bag[key] as PageSession | undefined;
  cache = session?.comments ?? [];
  chrome.runtime.sendMessage({ type: 'COUNT', count: cache.filter((c) => !c.resolved).length }).catch(() => {});
  emit();
  return cache;
}

export function list(): CommentRecord[] {
  return cache;
}

/** Comments still awaiting action — what pins, the badge and exports use. */
export function open(): CommentRecord[] {
  return cache.filter((c) => !c.resolved);
}

export function resolved(): CommentRecord[] {
  return cache.filter((c) => c.resolved);
}

/** Next display number: max existing + 1, so deleting #2 doesn't renumber #3. */
export function nextNumber(): number {
  return cache.reduce((max, c) => Math.max(max, c.n), 0) + 1;
}

export async function add(record: CommentRecord) {
  cache = [...cache, record];
  await write();
}

export async function update(id: string, patch: Partial<CommentRecord>) {
  cache = cache.map((c) => (c.id === id ? { ...c, ...patch } : c));
  await write();
}

export async function setResolved(id: string, resolved: boolean) {
  cache = cache.map((c) =>
    c.id === id
      ? { ...c, resolved, resolvedAt: resolved ? new Date().toISOString() : undefined }
      : c,
  );
  await write();
}

export async function remove(id: string) {
  cache = cache.filter((c) => c.id !== id);
  await write();
}

export async function clear() {
  cache = [];
  await write();
}

/** Mark records whose selector no longer resolves, without persisting the flag. */
export function markStale(staleIds: Set<string>) {
  cache = cache.map((c) => ({ ...c, stale: staleIds.has(c.id) }));
  emit();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(cache);
  return () => listeners.delete(fn);
}
