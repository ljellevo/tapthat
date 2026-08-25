import type { CommentRecord } from '../../types';
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
}

let node: HTMLDivElement | null = null;
let listEl: HTMLDivElement | null = null;
let countEl: HTMLSpanElement | null = null;
let exportBtn: HTMLButtonElement | null = null;
let clearBtn: HTMLButtonElement | null = null;
let resolvedBtn: HTMLButtonElement | null = null;
let teardownDrag: (() => void) | null = null;
let options: PanelOptions | null = null;

/** Which list the panel is showing. Resolved comments live behind the toggle. */
let view: 'open' | 'resolved' = 'open';
let lastRecords: CommentRecord[] = [];
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
  body.appendChild(el('div', 'item-target', label));
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
  clearBtn = null;
  options = null;
}
