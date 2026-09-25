import type { CredentialInfo } from '@tapthat/shared';

/**
 * Full-mode configuration. The sole reader and writer of this storage key — the
 * content script and the options page both go through here, and
 * chrome.storage.onChanged is what makes Apply appear or disappear on an open
 * page without a reload.
 *
 * The raw Claude credential is never stored: it is POSTed once to the sidecar,
 * which keeps it sealed and hands back an opaque handle.
 */
export interface Settings {
  sidecarUrl: string | null;
  token: string | null;
  credential: Pick<CredentialInfo, 'handle' | 'fingerprint' | 'kind'> | null;
  allowedOrigins: string[];
}

const KEY = 'av:settings';

export const DEFAULTS: Settings = {
  sidecarUrl: null,
  token: null,
  credential: null,
  allowedOrigins: [],
};

function normalize(raw: Partial<Settings> | undefined): Settings {
  return { ...DEFAULTS, ...(raw ?? {}), allowedOrigins: raw?.allowedOrigins ?? [] };
}

export async function get(): Promise<Settings> {
  try {
    const bag = await chrome.storage.local.get(KEY);
    return normalize(bag[KEY] as Partial<Settings> | undefined);
  } catch {
    return { ...DEFAULTS };
  }
}

export async function patch(update: Partial<Settings>): Promise<Settings> {
  const next = { ...(await get()), ...update };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function reset(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

export function subscribe(fn: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && KEY in changes) fn(normalize(changes[KEY]!.newValue as Partial<Settings> | undefined));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Trims, drops a trailing slash, and rejects anything that is not http(s). */
export function normalizeSidecarUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Accepts "https://site.dev/some/page" as well as a bare origin. */
export function normalizeOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}
