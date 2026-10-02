import type { CommentRecord } from '../../types';
import type { Phase } from '../../sidecar/tracked';
import type { Mode } from '../mode';
import { el, getHost } from './host';
import { makeDraggable, clampToViewport } from './drag';

const POS_KEY = 'av:panel-pos';

export interface PanelOptions {
  onSelect(record: CommentRecord): void;
  onDelete(record: CommentRecord): void;
  onResolve(record: CommentRecord, resolved: boolean): void;
  onExport(): void;
  onClear(): void;
  onClose(): void;
  onHelp?(): void;
  onSettings?(): void;
  /** Full mode only. */
  onApply?(): void;
  onBatchAction?(action: BatchAction, batchId: string): void;
  onSessionAction?(action: SessionAction): void;
}

export type SessionAction = 'start' | 'commit' | 'discard' | 'wake' | 'sleep';

/**
 * The playground session strip (git.mode "session"). Like BatchView, a view
 * model: what to say and which buttons to offer, nothing about the sidecar.
 */
export interface SessionView {
  tone: 'idle' | 'busy' | 'active' | 'done' | 'failed';
  title: string;
  detail?: string | null;
  lines?: string[];
  progress?: { step: number; steps: number } | null;
  actions: Array<{
    action: SessionAction;
    label: string;
    /** Two-click actions: the label shown while armed. */
    confirm?: string;
    primary?: boolean;
    disabled?: boolean;
  }>;
}

export type BatchAction = 'resolve' | 'undo' | 'dismiss' | 'copy';

/** A view model: the panel renders it and knows nothing about the sidecar. */
export interface BatchView {
  batchId: string;
  phase: Phase;
  title: string;
  progress?: string | null;
  summary?: string | null;
  files?: string[];
  /** Error or compiler output, shown verbatim with a copy button. */
  output?: string | null;
  actions: BatchAction[];
  resolveCount?: number;
}

const PHASE_LABEL: Record<Phase, string> = {
  queued: 'queued',
  editing: 'editing',
  live: 'live',
  committed: 'committed',
  unverified: 'build broken',
  failed: 'failed',
  reverted: 'undone',
};

let node: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let countEl: HTMLSpanElement | null = null;
let exportBtn: HTMLButtonElement | null = null;
let applyBtn: HTMLButtonElement | null = null;
let statusEl: HTMLDivElement | null = null;
let batchEl: HTMLDivElement | null = null;
let sessionEl: HTMLDivElement | null = null;
/** Session mode without an active session: Apply waits for Start session. */
let applyAllowed = true;
let fullMode = false;
/** Full mode only: the sidecar is down or paused, so Export comes back as the way out. */
let exportFallback = false;
let clearBtn: HTMLButtonElement | null = null;
let resolvedBtn: HTMLButtonElement | null = null;
let teardownDrag: (() => void) | null = null;
let options: PanelOptions | null = null;

/** Which list the panel is showing. Resolved comments live behind the toggle. */
let view: 'open' | 'resolved' = 'open';
let lastRecords: CommentRecord[] = [];
let statuses = new Map<string, Phase>();
let applyBusy = false;
/** Clear all is destructive and unrecoverable, so it takes two clicks. */
let clearArmed = false;

async function loadPosition(): Promise<{ left: number; top: number } | null> {
  try {
    const bag = await chrome.storage.local.get(POS_KEY);
    return bag[POS_KEY] ?? null;
  } catch {
    return null;
  }
}

export async function mount(opts: PanelOptions) {
  if (node) return;
  options = opts;
  const { layer } = getHost();

  node = el('div', 'panel');

  const head = el('div', 'panel-head');
  head.appendChild(el('span', 'panel-title', 'TapThat'));
  countEl = el('span', 'panel-count', '0');
  head.appendChild(countEl);
  head.appendChild(el('span', 'spacer'));
  // Always there, Light or Full: the help page explains both, in plain language.
  const help = el('button', 'panel-help', '?');
  help.title = 'Help: how TapThat works and how to set it up';
  help.setAttribute('aria-label', 'Help');
  help.addEventListener('click', () => opts.onHelp?.());
  help.addEventListener('pointerdown', (e) => e.stopPropagation());
  head.appendChild(help);
  const settings = el('button', 'panel-help panel-settings', '⚙');
  settings.title = 'Settings';
  settings.setAttribute('aria-label', 'Settings');
  settings.addEventListener('click', () => opts.onSettings?.());
  settings.addEventListener('pointerdown', (e) => e.stopPropagation());
  head.appendChild(settings);
  const close = el('button', undefined, '✕');
  close.title = 'Exit annotation mode (Esc)';
  close.addEventListener('click', () => opts.onClose());
  close.addEventListener('pointerdown', (e) => e.stopPropagation());
  head.appendChild(close);
  node.appendChild(head);

  listEl = el('div', 'panel-list');
  node.appendChild(listEl);

  // Full mode chrome, hidden in Light: the last batch, then the branch line.
  batchEl = el('div', 'batch');
  batchEl.hidden = true;
  node.appendChild(batchEl);
  sessionEl = el('div', 'session');
  sessionEl.hidden = true;
  node.appendChild(sessionEl);
  statusEl = el('div', 'panel-status');
  statusEl.hidden = true;
  node.appendChild(statusEl);

  const foot = el('div', 'panel-foot');

  clearBtn = el('button', 'ghost', 'Clear all');
  clearBtn.addEventListener('click', () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn!.textContent = 'Sure?';
      clearBtn!.classList.add('danger-armed');
      setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    opts.onClear();
  });
  foot.appendChild(clearBtn);

  resolvedBtn = el('button', 'ghost', 'Resolved');
  resolvedBtn.addEventListener('click', () => {
    view = view === 'open' ? 'resolved' : 'open';
    render(lastRecords);
  });
  foot.appendChild(resolvedBtn);

  foot.appendChild(el('span', 'spacer'));
  applyBtn = el('button', 'primary', 'Apply to dev');
  applyBtn.title = 'Send the open comments to the agent on your dev environment';
  applyBtn.hidden = true;
  applyBtn.addEventListener('click', () => opts.onApply?.());
  foot.appendChild(applyBtn);
  exportBtn = el('button', 'primary', 'Export');
  exportBtn.addEventListener('click', () => opts.onExport());
  foot.appendChild(exportBtn);
  node.appendChild(foot);

  layer.appendChild(node);

  const saved = await loadPosition();
  if (saved) {
    const { left, top } = clampToViewport(node, saved.left, saved.top);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.right = 'auto';
    node.style.bottom = 'auto';
  }

  teardownDrag = makeDraggable({
    node,
    handle: head,
    onEnd: (pos) => chrome.storage.local.set({ [POS_KEY]: pos }).catch(() => {}),
  });
}

function disarmClear() {
  if (!clearBtn || !clearArmed) return;
  clearArmed = false;
  clearBtn.textContent = 'Clear all';
  clearBtn.classList.remove('danger-armed');
}

export function render(records: CommentRecord[]) {
  if (!listEl || !countEl) return;
  lastRecords = records;

  const open = records.filter((r) => !r.resolved);
  const done = records.filter((r) => r.resolved);

  // Nothing to show behind the toggle means no reason to sit in that view.
  if (view === 'resolved' && done.length === 0) view = 'open';

  const shown = view === 'open' ? open : done;

  countEl.textContent = view === 'open' ? String(open.length) : `${done.length} resolved`;
  if (exportBtn) exportBtn.disabled = open.length === 0;
  if (applyBtn) {
    applyBtn.disabled = open.length === 0 || applyBusy;
    applyBtn.textContent = applyBusy ? 'Applying…' : 'Apply to dev';
  }
  if (clearBtn) clearBtn.disabled = records.length === 0;
  if (resolvedBtn) {
    resolvedBtn.textContent = view === 'open' ? `Resolved (${done.length})` : 'Back';
    resolvedBtn.disabled = done.length === 0 && view === 'open';
    resolvedBtn.classList.toggle('active', view === 'resolved');
  }

  listEl.textContent = '';

  if (shown.length === 0) {
    listEl.appendChild(
      el(
        'div',
        'empty',
        view === 'open'
          ? 'Hover an element and click it to leave a comment.\n↑ / ↓ selects a parent or child.'
          : 'No resolved comments yet.',
      ),
    );
    return;
  }

  for (const record of [...shown].sort((a, b) => a.n - b.n)) {
    listEl.appendChild(buildItem(record));
  }
}

function buildItem(record: CommentRecord): HTMLDivElement {
  const classes = ['item'];
  if (record.stale) classes.push('stale');
  if (record.resolved) classes.push('resolved');
  const item = el('div', classes.join(' '));

  item.appendChild(el('div', 'item-n', String(record.n)));

  const body = el('div', 'item-body');
  const label = record.stale
    ? `${record.selector} · not found`
    : record.text
      ? `${record.tagName} · "${record.text.slice(0, 40)}"`
      : record.selector;
  const target = el('div', 'item-target', label);
  const phase = statuses.get(record.id);
  if (phase) {
    const pill = el('span', `pill pill-${phase}`, PHASE_LABEL[phase]);
    target.prepend(pill);
  }
  body.appendChild(target);
  body.appendChild(el('div', 'item-text', record.comment));
  item.appendChild(body);

  const toggle = el('button', 'item-act', record.resolved ? '↩' : '✓');
  toggle.title = record.resolved ? 'Reopen comment' : 'Mark resolved';
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    options?.onResolve(record, !record.resolved);
  });
  item.appendChild(toggle);

  const del = el('button', 'item-act item-del', '✕');
  del.title = 'Delete comment';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    options?.onDelete(record);
  });
  item.appendChild(del);

  item.addEventListener('click', () => options?.onSelect(record));
  return item;
}

/**
 * Light ↔ Full. In Full, Apply is the primary action and Export is hidden —
 * it only comes back, as a ghost button, while the sidecar is down or paused.
 */
export function setMode(mode: Mode) {
  fullMode = mode === 'full';
  syncFootButtons();
  if (!fullMode) {
    if (statusEl) statusEl.hidden = true;
    if (batchEl) batchEl.hidden = true;
    if (sessionEl) sessionEl.hidden = true;
  }
}

/** Hides Apply while a playground has no active session; Start session sits in the strip. */
export function setApplyAllowed(allowed: boolean) {
  applyAllowed = allowed;
  syncFootButtons();
}

/** Full mode: show Export while the clipboard is the only way out. */
export function setExportFallback(show: boolean) {
  exportFallback = show;
  syncFootButtons();
}

function syncFootButtons() {
  if (!applyBtn || !exportBtn) return;
  applyBtn.hidden = !fullMode || !applyAllowed;
  exportBtn.hidden = fullMode && !exportFallback;
  exportBtn.classList.toggle('primary', !fullMode);
  exportBtn.classList.toggle('ghost', fullMode);
}

let armed: { action: SessionAction; timer: number } | null = null;

export function setSession(view: SessionView | null) {
  if (!sessionEl) return;
  sessionEl.textContent = '';
  sessionEl.hidden = !view;
  if (!view) return;
  sessionEl.className = `session session-${view.tone}`;

  // No close button: in a playground the session strip is always the thing to act on.
  const head = el('div', 'session-head');
  head.appendChild(el('span', 'session-title', view.title));
  sessionEl.appendChild(head);
  if (view.detail) sessionEl.appendChild(el('div', 'session-detail', view.detail));
  if (view.progress && view.progress.steps > 0) {
    const bar = el('div', 'session-bar');
    const fill = el('div', 'session-bar-fill');
    fill.style.width = `${Math.round((view.progress.step / view.progress.steps) * 100)}%`;
    bar.appendChild(fill);
    sessionEl.appendChild(bar);
  }
  if (view.lines?.length) sessionEl.appendChild(el('div', 'session-lines', view.lines.join('\n')));

  const buttons = view.actions;
  if (!buttons.length) return;
  const row = el('div', 'row session-actions');
  for (const spec of buttons) {
    const isArmed = armed?.action === spec.action;
    const btn = el(
      'button',
      [
        spec.primary ? 'primary' : 'ghost',
        // Commit ships to the shared dev environment; it must not read as another Apply.
        spec.action === 'commit' ? 'commit' : '',
        isArmed ? (spec.primary ? 'armed' : 'danger-armed') : '',
      ].filter(Boolean).join(' '),
      isArmed && spec.confirm ? spec.confirm : spec.label,
    );
    btn.disabled = !!spec.disabled;
    btn.addEventListener('click', () => {
      // Commit and Cancel session are not undoable from here, so they take two clicks,
      // the same way Clear all does.
      if (spec.confirm && armed?.action !== spec.action) {
        if (armed) clearTimeout(armed.timer);
        armed = { action: spec.action, timer: window.setTimeout(() => { armed = null; setSession(view); }, 4000) };
        setSession(view);
        return;
      }
      if (armed) clearTimeout(armed.timer);
      armed = null;
      options?.onSessionAction?.(spec.action);
    });
    row.appendChild(btn);
  }
  sessionEl.appendChild(row);
}

export function setStatuses(next: Map<string, Phase>) {
  statuses = next;
  render(lastRecords);
}

export function setApplyBusy(busy: boolean) {
  applyBusy = busy;
  render(lastRecords);
}

/** The branch/drift line: which branch Apply will touch, before it is clicked. */
export function setStatusLine(text: string | null, tone: 'info' | 'warn' | 'error' = 'info') {
  if (!statusEl) return;
  statusEl.hidden = !text;
  statusEl.textContent = text ?? '';
  statusEl.className = `panel-status tone-${tone}`;
}

export function setBatch(view: BatchView | null) {
  if (!batchEl) return;
  batchEl.textContent = '';
  batchEl.hidden = !view;
  if (!view) return;
  batchEl.className = `batch batch-${view.phase}`;

  const head = el('div', 'batch-head');
  head.appendChild(el('span', `pill pill-${view.phase}`, PHASE_LABEL[view.phase]));
  head.appendChild(el('span', 'batch-title', view.title));
  if (view.actions.includes('dismiss')) {
    const close = el('button', 'item-act batch-close', '✕');
    close.title = 'Dismiss';
    close.addEventListener('click', () => options?.onBatchAction?.('dismiss', view.batchId));
    head.appendChild(close);
  }
  batchEl.appendChild(head);

  if (view.progress) batchEl.appendChild(el('div', 'batch-progress', view.progress));
  if (view.summary) batchEl.appendChild(el('div', 'batch-summary', view.summary));
  if (view.files?.length) {
    batchEl.appendChild(el('div', 'batch-files', view.files.join('\n')));
  }
  if (view.output) {
    const pre = el('pre', 'batch-output', view.output);
    batchEl.appendChild(pre);
  }

  const actions = view.actions.filter((a) => a !== 'dismiss');
  if (actions.length) {
    const row = el('div', 'row batch-actions');
    for (const action of actions) {
      const label =
        action === 'resolve'
          ? `Resolve ${view.resolveCount ?? ''} comment${view.resolveCount === 1 ? '' : 's'}`.replace('  ', ' ')
          : action === 'undo'
            ? 'Undo (best-effort)'
            : 'Copy error';
      const btn = el('button', action === 'resolve' ? 'primary' : 'ghost', label);
      if (action === 'undo') {
        btn.title = 'Reverts this batch\'s commit. Refused if later changes touched the same lines.';
      }
      btn.addEventListener('click', () => options?.onBatchAction?.(action, view.batchId));
      row.appendChild(btn);
    }
    batchEl.appendChild(row);
  }
}

export function open() {
  if (!node) return;
  node.classList.add('open');
  // The saved position was applied while the panel was hidden (zero size), so
  // clamp again now that it actually measures.
  if (node.style.left) {
    const r = node.getBoundingClientRect();
    const { left, top } = clampToViewport(node, r.left, r.top);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }
}

export function close() {
  node?.classList.remove('open');
}

export function destroy() {
  teardownDrag?.();
  teardownDrag = null;
  node?.remove();
  node = null;
  listEl = null;
  countEl = null;
  exportBtn = null;
  applyBtn = null;
  fullMode = false;
  exportFallback = false;
  statusEl = null;
  batchEl = null;
  sessionEl = null;
  clearBtn = null;
  options = null;
}
