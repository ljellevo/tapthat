import { shortLabel } from '../capture';
import { el, getHost } from './host';

const WIDTH = 300;
const GAP = 10;

export interface ComposerOptions {
  target: Element;
  /** Existing text when editing an already-saved comment. */
  initial?: string;
  mode: 'create' | 'edit';
  onSave(text: string): void;
  onCancel(): void;
  onDelete?(): void;
  onResolve?(): void;
}

let node: HTMLDivElement | null = null;
let current: ComposerOptions | null = null;

function ensure(): HTMLDivElement {
  if (node) return node;
  const { layer } = getHost();
  node = el('div', 'composer');
  layer.appendChild(node);
  return node;
}

/** Place next to the element, flipping/clamping so it always stays on screen. */
function position(target: Element, box: HTMLDivElement) {
  const r = target.getBoundingClientRect();
  const h = box.offsetHeight || 150;

  let top = r.bottom + GAP;
  if (top + h > innerHeight - 8) {
    const above = r.top - h - GAP;
    top = above >= 8 ? above : Math.max(8, innerHeight - h - 8);
  }

  const left = Math.max(8, Math.min(r.left, innerWidth - WIDTH - 8));
  box.style.top = `${top}px`;
  box.style.left = `${left}px`;
}

export function open(opts: ComposerOptions) {
  const box = ensure();
  current = opts;
  box.textContent = '';

  const target = el('div', 'target', shortLabel(opts.target));
  box.appendChild(target);

  const textarea = el('textarea');
  textarea.placeholder = 'What should change here?';
  textarea.value = opts.initial ?? '';
  box.appendChild(textarea);

  const row = el('div', 'row');
  const hint = el('span', 'hint', '⌘↵ to save');
  row.appendChild(hint);
  row.appendChild(el('span', 'spacer'));

  if (opts.mode === 'edit' && opts.onDelete) {
    const del = el('button', 'danger', 'Delete');
    del.addEventListener('click', () => {
      opts.onDelete?.();
      close();
    });
    row.appendChild(del);
  }

  if (opts.mode === 'edit' && opts.onResolve) {
    const resolve = el('button', 'ghost', 'Resolve');
    resolve.title = 'Mark done and hide from the page';
    resolve.addEventListener('click', () => {
      opts.onResolve?.();
      close();
    });
    row.appendChild(resolve);
  }

  const cancel = el('button', 'ghost', 'Cancel');
  cancel.addEventListener('click', () => {
    opts.onCancel();
    close();
  });
  row.appendChild(cancel);

  const save = el('button', 'primary', opts.mode === 'edit' ? 'Save' : 'Add comment');
  save.disabled = textarea.value.trim().length === 0;
  save.addEventListener('click', () => commit());
  row.appendChild(save);

  box.appendChild(row);

  function commit() {
    const text = textarea.value.trim();
    if (!text) return;
    opts.onSave(text);
    close();
  }

  textarea.addEventListener('input', () => {
    save.disabled = textarea.value.trim().length === 0;
  });

  // Keys are handled here and stopped so the global suppressor and the page
  // never see typing inside the composer.
  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      opts.onCancel();
      close();
    }
  });

  box.classList.add('open');
  position(opts.target, box);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
}

let scrollRaf = 0;
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    reposition();
  });
}

export function close() {
  node?.classList.remove('open');
  current = null;
  window.removeEventListener('scroll', onScroll, { capture: true });
  window.removeEventListener('resize', onScroll);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
}

export function reposition() {
  if (node && current?.target.isConnected) position(current.target, node);
}

export function destroy() {
  node?.remove();
  node = null;
  current = null;
}
