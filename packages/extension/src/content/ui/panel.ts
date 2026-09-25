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
  /** Full mode only. */
  onApply?(): void;
  onBatchAction?(action: BatchAction, batchId: string): void;
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
 * Light ↔ Full. In Full, Apply is the primary action and Export demotes to a
 * ghost button — but stays, because the clipboard is the fallback whenever the
 * sidecar is down.
 */
export function setMode(mode: Mode) {
  if (!applyBtn || !exportBtn) return;
  const full = mode === 'full';
  applyBtn.hidden = !full;
  exportBtn.classList.toggle('primary', !full);
  exportBtn.classList.toggle('ghost', full);
  if (!full) {
    if (statusEl) statusEl.hidden = true;
    if (batchEl) batchEl.hidden = true;
  }
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
  statusEl = null;
  batchEl = null;
  clearBtn = null;
  options = null;
}
