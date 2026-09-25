import type { BatchRequest, Health, SessionResponse } from '@tapthat/shared';
import * as settingsStore from '../settings';
import type { Settings } from '../settings';
import { createClient, SidecarError, type Client } from '../sidecar/client';
import {
  applyEvent,
  applyStatus,
  commentPhases,
  isFinished,
  phaseOf,
  track,
  type TrackedBatch,
} from '../sidecar/tracked';
import * as batches from './batches';
import { copyToClipboard } from './export';
import { modeFor, type Mode } from './mode';
import { pageContext } from './page';
import * as store from './store';
import * as connect from './ui/connect';
import { toast } from './ui/host';
import * as panel from './ui/panel';
import type { BatchAction, BatchView, SessionAction, SessionView } from './ui/panel';

/**
 * TapThat Full, in the page: Apply, live status, undo. Everything here is
 * inert in Light mode — with default settings no client is created and no
 * request is ever made, which is the whole Light guarantee.
 */

const HEALTH_EVERY_MS = 20_000;

let settings: Settings = { ...settingsStore.DEFAULTS };
let mode: Mode = 'light';
let client: Client | null = null;
let health: Health | null = null;
let healthError: string | null = null;
let trouble = false;
let submitting = false;
let healthTimer: number | undefined;
/** Session mode only: the playground session, and the last Commit or Discard. */
let session: SessionResponse | null = null;
let sessionTimer: number | undefined;
let sessionBusy: SessionAction | null = null;
let dismissedOutcome: string | null = null;
const watchers = new Map<string, () => void>();
const modeListeners = new Set<(mode: Mode) => void>();

export function currentMode(): Mode {
  return mode;
}

export function onModeChange(fn: (mode: Mode) => void): void {
  modeListeners.add(fn);
}

/**
 * Where the workspace stands: one head, or `app:a1b2,api:c3d4` across several
 * repos — a change to any of them can change what the reviewer is looking at.
 */
function workspaceKey(h: Health | null): string | undefined {
  if (!h) return undefined;
  if ((h.repos?.length ?? 0) > 1) return h.repos.map((r) => `${r.name}:${r.head ?? '?'}`).join(',');
  return h.repo.head ?? undefined;
}

/** Stamped on comments made in Full mode, so the panel can warn when the branch moves under them. */
export function baseShaForNewComment(): string | undefined {
  return mode === 'full' ? workspaceKey(health) : undefined;
}

function sessionMode(): boolean {
  return health?.mode === 'session';
}

function applySettings(next: Settings) {
  settings = next;
  const nextMode = modeFor(settings, location.origin);
  client = nextMode === 'full' && settings.sidecarUrl
    ? createClient({ baseUrl: settings.sidecarUrl, token: settings.token })
    : null;
  const changed = nextMode !== mode;
  mode = nextMode;
  if (changed) {
    for (const fn of modeListeners) fn(mode);
    if (mode === 'light') stopAllWatchers();
  }
  render();
}

export async function init(): Promise<void> {
  settingsStore.subscribe((next) => {
    applySettings(next);
    if (mode === 'full') void refreshHealth();
  });
  applySettings(await settingsStore.get());
  if (mode === 'full') await reload();
}

/** SPA navigation: batches are tracked per page, like comments. */
export async function onNavigate(): Promise<void> {
  stopAllWatchers();
  if (mode === 'full') await reload();
  else render();
}

async function reload(): Promise<void> {
  await batches.load();
  for (const batch of batches.list()) {
    if (!isFinished(batch)) watchBatch(batch);
  }
  render();
}

export function onPanelOpen(): void {
  if (mode !== 'full') return;
  void refreshHealth();
  clearInterval(healthTimer);
  healthTimer = window.setInterval(() => void refreshHealth(), HEALTH_EVERY_MS);
}

export function onPanelClose(): void {
  clearInterval(healthTimer);
  healthTimer = undefined;
}

async function refreshHealth(): Promise<void> {
  if (!client) return;
  try {
    health = await client.health();
    healthError = null;
  } catch (err) {
    health = null;
    healthError = err instanceof SidecarError ? err.message : String(err);
  }
  render();
  if (sessionMode()) await refreshSession();
}

const SESSION_BUSY = new Set(['starting', 'committing', 'discarding']);

/** Polls quickly while a session step runs, so its progress is visible. */
async function refreshSession(): Promise<void> {
  if (!client) return;
  clearTimeout(sessionTimer);
  try {
    session = await client.session();
  } catch {
    // The status line already reports an unreachable sidecar.
  }
  render();
  if (session?.session && SESSION_BUSY.has(session.session.state)) {
    sessionTimer = window.setTimeout(() => void refreshSession(), 1500);
  }
}

// ── session actions ──────────────────────────────────────────────────────────

export async function sessionAction(action: SessionAction): Promise<void> {
  if (!client) return;
  if (action === 'dismiss') {
    dismissedOutcome = session?.last?.id ?? null;
    render();
    return;
  }
  if (sessionBusy) return;
  sessionBusy = action;
  render();
  const who = settings.reviewerName;
  try {
    if (action === 'start') {
      session = await client.startSession(who);
      toast('Starting a session — copying the latest from dev');
    } else if (action === 'commit') {
      const outcome = await client.commitSession(who);
      toast(`Sent to dev: ${outcome.commits.map((c) => c.repo).join(', ')}`);
      await retireSessionBatches();
    } else {
      await client.discardSession(who);
      toast('Session discarded — code and data are back to dev');
      await retireSessionBatches();
    }
  } catch (err) {
    toast(err instanceof SidecarError ? err.message : `Failed: ${String(err)}`);
  } finally {
    sessionBusy = null;
    await refreshSession();
    void refreshHealth();
  }
}

/** After Commit or Discard the session branch is gone, so its batches can no longer be undone. */
async function retireSessionBatches(): Promise<void> {
  for (const b of batches.list()) {
    if (!b.dismissed && isFinished(b)) await batches.put({ ...b, dismissed: true });
  }
}

// ── apply ────────────────────────────────────────────────────────────────────

export async function apply(): Promise<void> {
  if (!client || submitting) return;
  const records = store.open();
  if (!records.length) {
    toast('No open comments to apply');
    return;
  }

  submitting = true;
  render();
  try {
    let handle = settings.credential?.handle ?? null;
    if (!handle) {
      const h = health ?? (await client.health().catch(() => null));
      if (!h?.agent.envCredential) {
        handle = await connectFlow();
        if (!handle) return;
      }
    }

    const request: BatchRequest = {
      batchId: crypto.randomUUID(),
      credentialHandle: handle,
      page: pageContext(),
      comments: records.map(({ stale: _stale, ...rest }) => rest),
      client: { name: 'tapthat-extension', version: chrome.runtime.getManifest().version },
      reviewer: settings.reviewerName ?? undefined,
    };

    let accepted;
    try {
      accepted = await client.submit(request);
    } catch (err) {
      if (err instanceof SidecarError && (err.code === 'credential_invalid' || err.code === 'no_credential')) {
        await settingsStore.patch({ credential: null });
        toast(err.code === 'credential_invalid' ? 'Your saved key no longer works — paste it again' : 'Connect a Claude credential first');
        const fresh = await connectFlow();
        if (!fresh) return;
        accepted = await client.submit({ ...request, batchId: crypto.randomUUID(), credentialHandle: fresh });
      } else {
        throw err;
      }
    }

    const batch = track(accepted, records.map((r) => r.id));
    await batches.put(batch);
    watchBatch(batch);
    toast(`Sent ${records.length} comment${records.length === 1 ? '' : 's'} to the agent`);
  } catch (err) {
    toast(submitError(err));
  } finally {
    submitting = false;
    render();
  }
}

function submitError(err: unknown): string {
  if (!(err instanceof SidecarError)) return `Apply failed: ${String(err)}`;
  switch (err.code) {
    case 'network':
      return "Can't reach the sidecar — Export still works";
    case 'unauthorized':
      return 'The sidecar rejected the token — check the extension settings';
    case 'no_session':
      return 'Start a session first — it copies the latest from dev';
    case 'session_busy':
    case 'rate_limited':
    case 'kill_switch':
    case 'page_not_allowed':
    case 'origin_not_allowed':
      return err.message;
    default:
      return `Apply failed: ${err.message}`;
  }
}

/** Collects a credential in the page. Returns the new handle, or null if the reviewer backed out. */
async function connectFlow(): Promise<string | null> {
  let handle: string | null = null;
  const ok = await connect.open({
    onSubmit: async (credential) => {
      try {
        const info = await client!.saveCredential(credential);
        await settingsStore.patch({
          credential: { handle: info.handle, fingerprint: info.fingerprint, kind: info.kind },
        });
        handle = info.handle;
        return null;
      } catch (err) {
        return err instanceof SidecarError ? err.message : String(err);
      }
    },
    onOpenSettings: () => {
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {});
    },
    onOpenHelp: () => {
      chrome.runtime.sendMessage({ type: 'OPEN_HELP', section: 'key' }).catch(() => {});
    },
  });
  return ok ? handle : null;
}

// ── watching ─────────────────────────────────────────────────────────────────

function watchBatch(batch: TrackedBatch): void {
  if (!client || watchers.has(batch.batchId)) return;
  const id = batch.batchId;
  // Events arrive one at a time; persisting each keeps a mid-run reload honest.
  const update = (fn: (b: TrackedBatch) => TrackedBatch) => {
    const current = batches.get(id);
    if (!current) return;
    void batches.put(fn(current)).then(render);
  };

  const stop = client.watch(
    id,
    batch.eventsToken,
    {
      onEvent: (event) => update((b) => applyEvent(b, event)),
      onDone: (status) => {
        watchers.delete(id);
        update((b) => applyStatus(b, status));
        void refreshHealth();
        const phase = status.state;
        if (phase === 'committed' || phase === 'applied') toast('Change applied — check the page');
        else if (phase === 'applied-unverified') toast('Applied, but the build is broken');
        else if (phase === 'failed') toast('The agent could not apply this batch');
      },
      onTrouble: (error) => {
        trouble = !!error && error.code !== 'not_found';
        if (error?.code === 'not_found') {
          watchers.delete(id);
          update((b) => ({ ...b, state: 'failed', error: { kind: 'lost', message: error.message } }));
        }
        render();
      },
    },
    { afterSeq: batch.lastSeq },
  );
  watchers.set(id, stop);
}

function stopAllWatchers(): void {
  for (const stop of watchers.values()) stop();
  watchers.clear();
}

// ── batch actions ────────────────────────────────────────────────────────────

export async function batchAction(action: BatchAction, batchId: string): Promise<void> {
  const batch = batches.get(batchId);
  if (!batch) return;

  if (action === 'dismiss') {
    await batches.put({ ...batch, dismissed: true });
    render();
    return;
  }

  if (action === 'copy') {
    const text = batch.verifyOutput ?? batch.error?.message ?? '';
    toast((await copyToClipboard(text)) ? 'Copied' : 'Copy failed');
    return;
  }

  if (action === 'resolve') {
    const open = new Set(store.open().map((c) => c.id));
    const ids = batch.commentIds.filter((id) => open.has(id));
    for (const id of ids) await store.setResolved(id, true);
    await batches.put({ ...batch, dismissed: true });
    toast(`Resolved ${ids.length} comment${ids.length === 1 ? '' : 's'}`);
    render();
    return;
  }

  if (action === 'undo' && client) {
    try {
      await client.revert(batchId);
      const status = await client.get(batchId);
      await batches.put(applyStatus(batch, status));
      toast('Undone — the page will update');
    } catch (err) {
      const conflicts = err instanceof SidecarError ? err.body?.conflicts : undefined;
      toast(
        err instanceof SidecarError
          ? `${err.message}${conflicts?.length ? ` (${conflicts.join(', ')})` : ''}`
          : `Undo failed: ${String(err)}`,
      );
    }
    void refreshHealth();
    render();
  }
}

// ── rendering ────────────────────────────────────────────────────────────────

function viewOf(batch: TrackedBatch): BatchView {
  const phase = phaseOf(batch);
  const n = batch.commentIds.length;
  const openIds = new Set(store.open().map((c) => c.id));
  const resolvable = batch.commentIds.filter((id) => openIds.has(id)).length;
  const sha = batch.sha ? batch.sha.slice(0, 7) : '';
  const push = batch.pushed === 'yes' ? ' · pushed' : batch.pushed === 'failed' ? ' · push failed' : '';

  switch (phase) {
    case 'queued':
      return {
        batchId: batch.batchId, phase,
        title: batch.ahead ? `Queued — ${batch.ahead} job${batch.ahead === 1 ? '' : 's'} ahead` : 'Queued',
        progress: 'Waiting for the agent…', actions: [],
      };
    case 'editing':
      return {
        batchId: batch.batchId, phase,
        title: `Applying ${n} comment${n === 1 ? '' : 's'}…`,
        progress: batch.progress ?? 'Starting…', actions: [],
      };
    case 'live':
      if (!isFinished(batch)) {
        return {
          batchId: batch.batchId, phase, title: 'Live — checking and committing…',
          files: batch.filesChanged, actions: [],
        };
      }
      return {
        batchId: batch.batchId, phase, title: 'Applied — not committed',
        summary: batch.summary, files: batch.filesChanged,
        output: batch.error?.message ?? null,
        actions: [...(resolvable ? (['resolve'] as const) : []), ...(batch.error ? (['copy'] as const) : []), 'dismiss'],
        resolveCount: resolvable,
      };
    case 'committed':
      return {
        batchId: batch.batchId, phase,
        title: sessionMode()
          ? `Applied in this session${commitsLabel(batch)}`
          : `Committed ${(batch.commits ?? []).length > 1 ? commitsLabel(batch).slice(3) : sha}${push}`,
        summary: batch.summary, files: batch.filesChanged,
        actions: [...(resolvable ? (['resolve'] as const) : []), 'undo', 'dismiss'],
        resolveCount: resolvable,
      };
    case 'unverified':
      return {
        batchId: batch.batchId, phase,
        title: 'Applied, but the build is broken',
        summary: 'The edit is on disk and nothing was committed. Comment again to fix it, or fix it in the code.',
        files: batch.filesChanged, output: batch.verifyOutput,
        actions: ['copy', 'dismiss'],
      };
    case 'failed':
      return {
        batchId: batch.batchId, phase, title: 'Failed — nothing was changed',
        output: batch.error?.message ?? 'The agent stopped without a message.',
        actions: ['copy', 'dismiss'],
      };
    case 'reverted':
      return { batchId: batch.batchId, phase, title: 'Undone', actions: ['dismiss'] };
  }
}

/** ` · api a1b2c3d · app 9f8e7d6` for a batch that committed in several repos. */
function commitsLabel(batch: TrackedBatch): string {
  const commits = batch.commits ?? [];
  if (commits.length < 2) return '';
  return ` · ${commits.map((c) => `${c.repo} ${c.sha.slice(0, 7)}`).join(' · ')}`;
}

function sessionView(): SessionView | null {
  if (!sessionMode()) return null;
  const s = session?.session ?? null;
  const last = session?.last ?? null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (!s) {
    const recent = last && last.id !== dismissedOutcome && Date.now() - Date.parse(last.at) < 30 * 60_000;
    const start = { action: 'start' as const, label: sessionBusy === 'start' ? 'Starting…' : 'Start session', primary: true, disabled: !!sessionBusy };
    if (recent && last.outcome === 'committed') {
      return {
        tone: 'done',
        title: 'Sent to dev',
        detail: `${last.commits.map((c) => `${c.repo} ${c.sha}`).join(' · ')}${last.by ? ` · by ${last.by}` : ''}. The dev environment deploys it from here.`,
        lines: last.notices.map((n) => `⚠ ${n}`),
        actions: [start, { action: 'dismiss', label: 'Dismiss' }],
      };
    }
    if (recent && last.outcome === 'discarded') {
      return {
        tone: 'idle',
        title: 'Session discarded',
        detail: 'The code and data are back to dev.',
        actions: [start, { action: 'dismiss', label: 'Dismiss' }],
      };
    }
    return {
      tone: 'idle',
      title: 'No session',
      detail: 'Start a session to apply changes here. It copies the latest code and data from dev into this playground, which takes a few minutes.',
      actions: [start],
    };
  }

  const lastEvent = s.events.at(-1);
  if (SESSION_BUSY.has(s.state)) {
    const titles: Record<string, string> = { starting: 'Starting a session…', committing: 'Sending to dev…', discarding: 'Discarding…' };
    return {
      tone: 'busy',
      title: titles[s.state]!,
      detail: `${lastEvent?.message ?? ''}${s.startedBy && s.state === 'starting' ? ` · started by ${s.startedBy}` : ''}`,
      progress: lastEvent?.steps ? { step: lastEvent.step ?? 0, steps: lastEvent.steps } : null,
      actions: [],
    };
  }

  if (s.state === 'failed') {
    return {
      tone: 'failed',
      title: 'The session failed',
      detail: s.error ?? 'Unknown error.',
      actions: [{ action: 'discard', label: 'Discard', confirm: 'Discard it?', disabled: !!sessionBusy }],
    };
  }

  const files = s.repos.reduce((n, r) => n + r.files.length, 0);
  const n = s.pending.length;
  return {
    tone: 'active',
    title: n ? `Session · ${plural(n, 'change')} ready for dev` : 'Session · no changes yet',
    detail: [
      n ? `${s.repos.map((r) => r.name).join(', ')} · ${plural(files, 'file')}` : 'Apply comments; they stay here until you send them.',
      s.startedBy ? `started by ${s.startedBy}` : null,
    ].filter(Boolean).join(' · '),
    lines: s.pending.map((p) => `• ${(p.comments[0] ?? p.summary).split('\n')[0]}${p.reviewer ? ` — ${p.reviewer}` : ''}`),
    actions: [
      {
        action: 'discard',
        label: sessionBusy === 'discard' ? 'Discarding…' : 'Discard all',
        confirm: 'Discard all, data too?',
        disabled: !!sessionBusy,
      },
      {
        action: 'commit',
        label: sessionBusy === 'commit' ? 'Sending…' : 'Commit to dev',
        confirm: `Send ${plural(n, 'change')} to dev?`,
        primary: true,
        disabled: !!sessionBusy || n === 0,
      },
    ],
  };
}

function statusLine(): { text: string | null; tone: 'info' | 'warn' | 'error' } {
  if (trouble) return { text: 'Lost contact with the sidecar — retrying…', tone: 'error' };
  if (healthError) return { text: 'Sidecar unreachable — Export still works', tone: 'error' };
  if (!health) return { text: null, tone: 'info' };
  if (health.killSwitch) return { text: 'Paused by the operator — Export still works', tone: 'warn' };

  const head = workspaceKey(health);
  // Comments captured against an older HEAD may describe an element that has
  // since changed. The only honest answer with two reviewers on one tree.
  const settled = new Set(
    batches.list().filter((b) => b.state === 'committed').flatMap((b) => b.commentIds),
  );
  const drifted = store.open().some((c) => c.baseSha && head && c.baseSha !== head && !settled.has(c.id));
  if (drifted) return { text: 'The page changed since you commented — re-check before applying', tone: 'warn' };

  const branchLabel = (b: string | null) => (b?.startsWith('tapthat/session-') ? 'session' : (b ?? '?'));
  let text =
    (health.repos?.length ?? 0) > 1
      ? health.repos.map((r) => `${r.name} ${branchLabel(r.branch)}@${r.head ?? '?'}`).join(' · ')
      : `${branchLabel(health.repo.branch)} @ ${health.repo.head ?? '?'}`;
  const mine = batches.list().some((b) => !isFinished(b));
  if (health.queue.depth > 0 && !mine) text += ` · ${health.queue.depth} job${health.queue.depth === 1 ? '' : 's'} ahead`;
  if (!health.devServer.reachable) return { text: `${text} · dev server not responding`, tone: 'warn' };
  return { text, tone: 'info' };
}

export function render(): void {
  panel.setMode(mode);
  if (mode !== 'full') {
    panel.setStatuses(new Map());
    return;
  }
  const list = batches.list();
  panel.setStatuses(commentPhases(list));
  const latest = batches.latest();
  panel.setBatch(latest ? viewOf(latest) : null);
  const line = statusLine();
  panel.setStatusLine(line.text, line.tone);
  panel.setApplyBusy(submitting || list.some((b) => !isFinished(b)));
  panel.setSession(sessionView());
  // In a playground, Apply waits for Start session.
  panel.setApplyAllowed(!sessionMode() || session?.session?.state === 'active');
}
