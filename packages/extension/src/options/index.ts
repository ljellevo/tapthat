import * as settingsStore from '../settings';
import { normalizeOrigin, normalizeSidecarUrl, type Settings } from '../settings';
import { createClient, SidecarError } from '../sidecar/client';

/**
 * The options page. Requests from here are extension-origin, which host
 * permissions exempt from CORS, and which the sidecar accepts with a valid token.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const url = $<HTMLInputElement>('url');
const token = $<HTMLInputElement>('token');
const origins = $<HTMLTextAreaElement>('origins');
const result = $<HTMLDivElement>('result');
const credState = $<HTMLDivElement>('cred-state');
const cred = $<HTMLInputElement>('cred');
const credResult = $<HTMLDivElement>('cred-result');
const modeEl = $<HTMLSpanElement>('mode');

function show(el: HTMLElement, text: string, tone: 'ok' | 'err' | 'warn' | '' = '') {
  el.textContent = text;
  el.className = `result ${tone}`;
}

function paint(s: Settings) {
  url.value = s.sidecarUrl ?? '';
  token.value = s.token ?? '';
  origins.value = s.allowedOrigins.join('\n');
  modeEl.textContent = s.sidecarUrl ? 'Full' : 'Light';
  credState.textContent = s.credential
    ? `Connected •••• ${s.credential.fingerprint} (${s.credential.kind === 'oauth_token' ? 'OAuth token' : 'API key'})`
    : 'Not connected';
  credState.className = `result ${s.credential ? 'ok' : ''}`;
}

function clientFor(s: Settings) {
  if (!s.sidecarUrl) throw new SidecarError(0, 'config', 'Enter the sidecar URL first.');
  return createClient({ baseUrl: s.sidecarUrl, token: s.token });
}

async function test(s: Settings): Promise<Settings> {
  const client = clientFor(s);
  show(result, 'Testing…');
  const health = await client.health();
  const info = await client.info();
  let next = s;
  // With the list left empty, the sidecar's own allowlist is the natural answer:
  // it is the set of pages the sidecar will accept comments from anyway.
  if (!s.allowedOrigins.length && info.allowedOrigins.length) {
    next = await settingsStore.patch({ allowedOrigins: info.allowedOrigins });
    paint(next);
  }
  const lines = [
    `✓ Connected to sidecar ${health.version}`,
    `  branch ${health.repo.branch} @ ${health.repo.head}${health.repo.clean === false ? ' (uncommitted changes)' : ''}`,
    `  dev server ${health.devServer.reachable ? 'responding' : 'NOT responding'} at ${health.devServer.url}`,
    `  agent ${health.agent.cliVersion ?? 'NOT FOUND on the sidecar'}`,
    `  credential ${health.agent.envCredential ? 'the sidecar has its own' : 'each reviewer pastes their own'}`,
    `  Apply appears on: ${next.allowedOrigins.join(', ') || '(no sites — add one above)'}`,
  ];
  const warn = !health.devServer.reachable || !health.agent.cliVersion || !next.allowedOrigins.length;
  show(result, lines.join('\n'), warn ? 'warn' : 'ok');
  return next;
}

function describe(err: unknown): string {
  if (err instanceof SidecarError) {
    if (err.code === 'unauthorized') return '✗ The sidecar rejected the token.';
    return `✗ ${err.message}`;
  }
  return `✗ ${String(err)}`;
}

$('save').addEventListener('click', async () => {
  const sidecarUrl = url.value.trim() ? normalizeSidecarUrl(url.value) : null;
  if (url.value.trim() && !sidecarUrl) {
    show(result, '✗ The sidecar URL must start with http:// or https://', 'err');
    return;
  }
  const lines = origins.value.split(/\s+/).filter(Boolean);
  const parsed = lines.map(normalizeOrigin);
  const bad = lines.filter((_, i) => !parsed[i]);
  if (bad.length) {
    show(result, `✗ Not a site address: ${bad.join(', ')}`, 'err');
    return;
  }
  const next = await settingsStore.patch({
    sidecarUrl,
    token: token.value.trim() || null,
    allowedOrigins: [...new Set(parsed as string[])],
  });
  paint(next);
  if (!sidecarUrl) {
    show(result, 'Saved. No sidecar configured — TapThat is in Light mode.', 'ok');
    return;
  }
  await test(next).catch((err) => show(result, describe(err), 'err'));
});

$('test').addEventListener('click', async () => {
  await test(await settingsStore.get()).catch((err) => show(result, describe(err), 'err'));
});

$('reset').addEventListener('click', async () => {
  await settingsStore.reset();
  paint(await settingsStore.get());
  show(result, 'Cleared. TapThat is back in Light mode; the Export button works as before.', 'ok');
});

$('cred-save').addEventListener('click', async () => {
  const value = cred.value.trim();
  if (!value) return;
  try {
    const s = await settingsStore.get();
    const info = await clientFor(s).saveCredential(value);
    cred.value = '';
    paint(await settingsStore.patch({ credential: { handle: info.handle, fingerprint: info.fingerprint, kind: info.kind } }));
    show(credResult, 'Saved. It will be checked on your first Apply.', 'ok');
  } catch (err) {
    show(credResult, describe(err), 'err');
  }
});

$('cred-delete').addEventListener('click', async () => {
  const s = await settingsStore.get();
  if (s.credential && s.sidecarUrl) {
    // Hard revoke on the sidecar, not just forgetting the handle locally.
    await clientFor(s).deleteCredential(s.credential.handle).catch(() => {});
  }
  paint(await settingsStore.patch({ credential: null }));
  show(credResult, 'Disconnected. The sidecar has deleted its copy.', 'ok');
});

settingsStore.subscribe(paint);
void settingsStore.get().then(paint);
