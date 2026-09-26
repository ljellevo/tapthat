import type { CommentRecord } from '../../types';
import { el, getHost } from './host';

interface Pin {
  record: CommentRecord;
  node: HTMLDivElement;
  target: Element | null;
}

let pins: Pin[] = [];
let rafId = 0;
let listening = false;
let onPinClick: ((record: CommentRecord, target: Element | null) => void) | null = null;

export function setClickHandler(fn: (record: CommentRecord, target: Element | null) => void) {
  onPinClick = fn;
}

function resolve(record: CommentRecord): Element | null {
  try {
    return document.querySelector(record.selector);
  } catch {
    return null;
  }
}

function place(pin: Pin) {
  if (!pin.target?.isConnected) {
    pin.node.style.display = 'none';
    return;
  }
  const r = pin.target.getBoundingClientRect();
  // Off-screen or collapsed elements: hide rather than stack pins at 0,0.
  if (r.width === 0 && r.height === 0) {
    pin.node.style.display = 'none';
    return;
  }
  if (r.bottom < -30 || r.top > innerHeight + 30) {
    pin.node.style.display = 'none';
    return;
  }
  pin.node.style.display = 'flex';
  pin.node.style.left = `${Math.max(2, Math.min(r.left - 9, innerWidth - 26))}px`;
  pin.node.style.top = `${Math.max(2, Math.min(r.top - 9, innerHeight - 26))}px`;
}

function tick() {
  rafId = 0;
  for (const pin of pins) place(pin);
}

function schedule() {
  if (!rafId) rafId = requestAnimationFrame(tick);
}

let resizeObserver: ResizeObserver | null = null;

function startListening() {
  if (listening) return;
  listening = true;
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(document.documentElement);
}

function stopListening() {
  if (!listening) return;
  listening = false;
  window.removeEventListener('scroll', schedule, { capture: true });
  window.removeEventListener('resize', schedule);
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/** Rebuild all pins from the current comment list. Returns the ids that no longer resolve. */
export function render(records: CommentRecord[]): Set<string> {
  // Don't create the shadow host just to render nothing — on pages with no
  // comments and no launcher, the extension should leave no trace in the DOM.
  if (!records.length && !pins.length) {
    stopListening();
    return new Set();
  }

  const { layer } = getHost();
  for (const pin of pins) pin.node.remove();
  pins = [];

  const stale = new Set<string>();

  for (const record of records) {
    const target = resolve(record);
    if (!target) stale.add(record.id);

    const node = el('div', target ? 'pin' : 'pin stale', String(record.n));
    node.title = target
      ? record.comment
      : `${record.comment}\n\n(element not found on this page)`;
    node.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPinClick?.(record, target);
    });
    node.addEventListener('mousedown', (e) => e.stopPropagation());
    layer.appendChild(node);

    const pin: Pin = { record, node, target };
    pins.push(pin);
    place(pin);
  }

  if (pins.length) startListening();
  else stopListening();

  return stale;
}

export function destroy() {
  stopListening();
  for (const pin of pins) pin.node.remove();
  pins = [];
}
