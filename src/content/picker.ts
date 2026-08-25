import * as highlight from './ui/highlight';

const HOST_TAG = 'TAPTHAT-ROOT';

export interface PickerOptions {
  onPick(target: Element): void;
  onExit(): void;
}

let active = false;
let opts: PickerOptions | null = null;

/** Element directly under the cursor, before any ↑/↓ walking. */
let hovered: Element | null = null;
/** Element actually highlighted (hovered, walked up/down). */
let selected: Element | null = null;
let depth = 0;
let frozen = false;
let rafId = 0;
let pendingEvent: MouseEvent | null = null;

const STYLE_ID = 'tapthat-cursor-style';
let styleEl: HTMLStyleElement | null = null;

function isOurs(e: Event): boolean {
  return e.composedPath().some((n) => n instanceof Element && n.tagName === HOST_TAG);
}

function elementFromEvent(e: MouseEvent): Element | null {
  // composedPath()[0] pierces open shadow roots, so web-component pages resolve
  // to the real inner element rather than the host.
  const first = e.composedPath()[0];
  if (first instanceof Element && first.tagName !== HOST_TAG) return first;
  const fallback = document.elementFromPoint(e.clientX, e.clientY);
  return fallback && fallback.tagName !== HOST_TAG ? fallback : null;
}

function isPickable(el: Element | null): el is Element {
  if (!el) return false;
  if (el === document.documentElement || el === document.body) return false;
  if (el.tagName === HOST_TAG) return false;
  return true;
}

function applyWalk(base: Element, levels: number): Element {
  let node = base;
  for (let i = 0; i < levels; i++) {
    const parent = node.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    node = parent;
  }
  return node;
}

function refresh(instant = false) {
  if (!selected?.isConnected) return;
  highlight.show(selected, { depth, locked: frozen, instant });
}

function onMouseMove(e: MouseEvent) {
  if (!active || frozen || isOurs(e)) return;
  pendingEvent = e;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const ev = pendingEvent;
    pendingEvent = null;
    if (!ev) return;

    const target = elementFromEvent(ev);
    if (!isPickable(target) || target === hovered) return;

    hovered = target;
    depth = 0; // a real mouse move resets any ↑/↓ walking
    selected = target;
    highlight.show(selected, { depth });
  });
}

function onKeyDown(e: KeyboardEvent) {
  if (!active) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    opts?.onExit();
    return;
  }

  if (frozen || !hovered) return;

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const next = applyWalk(hovered, depth + 1);
    if (next !== selected) {
      depth++;
      selected = next;
      refresh();
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (depth > 0) {
      depth--;
      selected = applyWalk(hovered, depth);
      refresh();
    }
  }
}

function onClick(e: MouseEvent) {
  if (!active || isOurs(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (frozen || !selected) return;

  frozen = true;
  highlight.show(selected, { locked: true });
  opts?.onPick(selected);
}

/**
 * Blanket suppression of page interaction while picking. Without this, a click
 * lands on a link and navigates away before the composer can open.
 */
function suppress(e: Event) {
  if (!active || isOurs(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

function onScroll() {
  if (!active || !selected) return;
  refresh(true);
}

const SUPPRESSED = ['mousedown', 'mouseup', 'dblclick', 'contextmenu', 'submit', 'touchstart'] as const;

export function start(options: PickerOptions) {
  if (active) return;
  active = true;
  frozen = false;
  depth = 0;
  hovered = null;
  selected = null;
  opts = options;

  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  for (const type of SUPPRESSED) window.addEventListener(type, suppress, true);

  styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = `
    *, *::before, *::after {
      cursor: crosshair !important;
      user-select: none !important;
      -webkit-user-select: none !important;
    }
    tapthat-root, tapthat-root * { cursor: auto !important; user-select: auto !important; }
  `;
  document.head.appendChild(styleEl);
}

export function stop() {
  if (!active) return;
  active = false;
  frozen = false;
  hovered = null;
  selected = null;
  opts = null;

  window.removeEventListener('mousemove', onMouseMove, true);
  window.removeEventListener('click', onClick, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('scroll', onScroll, true);
  for (const type of SUPPRESSED) window.removeEventListener(type, suppress, true);

  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  styleEl?.remove();
  styleEl = null;
  highlight.hide();
}

/** Release the frozen selection and resume hover tracking. */
export function resume() {
  frozen = false;
  hovered = null;
  selected = null;
  highlight.hide();
}

export function isActive(): boolean {
  return active;
}
