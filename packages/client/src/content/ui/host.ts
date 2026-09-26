import { LAUNCHER_STYLES } from './launcher';

const HOST_TAG = 'tapthat-root';

const STYLES = `
:host { all: initial; }

* { box-sizing: border-box; }

.layer {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: var(--av-text);
  -webkit-font-smoothing: antialiased;
}

.layer > * { pointer-events: auto; }
.layer > .highlight, .layer > .chip { pointer-events: none; }

/* ---------- highlight ---------- */

.highlight {
  position: fixed;
  border: 2px solid var(--av-blue);
  background: var(--av-blue-fill);
  border-radius: 2px;
  transition: all 70ms cubic-bezier(0.2, 0, 0, 1);
  display: none;
}

.highlight.instant { transition: none; }

.highlight.locked {
  background: transparent;
  border-color: var(--av-blue);
  box-shadow: 0 0 0 1px var(--av-blue-soft), 0 0 0 9999px rgba(15, 23, 42, 0.18);
  transition: none;
}

.chip {
  position: fixed;
  display: none;
  align-items: center;
  gap: 6px;
  padding: 3px 7px;
  background: var(--av-blue);
  color: #fff;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

.chip .dim { opacity: 0.72; font-weight: 400; }

/* ---------- composer ---------- */

.composer {
  position: fixed;
  width: 370px;
  max-width: calc(100vw - 16px);
  background: var(--av-surface);
  border: 1px solid var(--av-border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.24), 0 2px 6px rgba(15, 23, 42, 0.12);
  padding: 10px;
  display: none;
  flex-direction: column;
  gap: 8px;
}

.composer.open { display: flex; }

.composer .target {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--av-blue);
  background: var(--av-blue-fill);
  padding: 3px 6px;
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.composer textarea {
  width: 100%;
  min-height: 76px;
  max-height: 220px;
  resize: vertical;
  border: 1px solid var(--av-border);
  border-radius: 6px;
  padding: 7px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--av-text);
  background: var(--av-input);
  outline: none;
}

.composer textarea:focus { border-color: var(--av-blue); box-shadow: 0 0 0 3px var(--av-blue-fill); }
.composer textarea::placeholder { color: var(--av-muted); }

.row { display: flex; align-items: center; gap: 6px; }
.spacer { flex: 1; }

button {
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  background: transparent;
  color: var(--av-text);
  white-space: nowrap;
  flex: none;
}

button:hover { background: var(--av-hover); }

button.primary {
  background: var(--av-blue);
  color: #fff;
}
button.primary:hover { background: var(--av-blue-dark); }
button.primary:disabled { opacity: 0.45; cursor: default; background: var(--av-blue); }

button.ghost { border-color: var(--av-border); }
button.danger:hover { background: var(--av-danger-fill); color: var(--av-danger); }

.hint {
  font-size: 11px;
  color: var(--av-muted);
  margin-top: -2px;
}

/* ---------- pins ---------- */

.pin {
  position: fixed;
  width: 22px;
  height: 22px;
  border-radius: 50% 50% 50% 3px;
  background: var(--av-blue);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.35);
  border: 1.5px solid #fff;
  user-select: none;
}

.pin:hover { transform: scale(1.12); }
.pin.stale { background: var(--av-muted); }

/* ---------- panel ---------- */

.panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  /* Wide enough for Clear all · Resolved · Apply to dev · Export on one row. */
  width: 364px;
  max-width: calc(100vw - 32px);
  max-height: 70vh;
  background: var(--av-surface);
  border: 1px solid var(--av-border);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.26), 0 2px 8px rgba(15, 23, 42, 0.12);
  display: none;
  flex-direction: column;
  overflow: hidden;
}

.panel.open { display: flex; }

.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--av-border);
  cursor: grab;
  user-select: none;
}

.panel-head.dragging { cursor: grabbing; }

.panel-title { font-weight: 600; font-size: 13px; }
.panel-help {
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--av-border);
  font-weight: 600;
  color: var(--av-muted);
}
.panel-help:hover { color: var(--av-blue); border-color: var(--av-blue); }
.panel-count { color: var(--av-muted); font-size: 12px; }

.panel-list {
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.empty {
  padding: 20px 14px;
  text-align: center;
  color: var(--av-muted);
  font-size: 12px;
  white-space: pre-line;
}

.item {
  display: flex;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 7px;
  cursor: pointer;
}

.item:hover { background: var(--av-hover); }

.item-n {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--av-blue);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.item.stale .item-n { background: var(--av-muted); }

.item-body { flex: 1; min-width: 0; }

.item-target {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  color: var(--av-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-text {
  font-size: 12.5px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.item-act {
  flex: none;
  opacity: 0;
  padding: 2px 5px;
  font-size: 13px;
  line-height: 1;
  color: var(--av-muted);
  border-radius: 4px;
  align-self: flex-start;
}

.item:hover .item-act { opacity: 1; }
.item-act:hover { background: var(--av-hover); color: var(--av-text); }
.item-del:hover { background: var(--av-danger-fill); color: var(--av-danger); }

.item.resolved .item-n { background: var(--av-muted); }
.item.resolved .item-text { text-decoration: line-through; color: var(--av-muted); }

button.active {
  background: var(--av-blue-fill);
  border-color: var(--av-blue);
  color: var(--av-blue);
}

button.danger-armed {
  background: var(--av-danger-fill);
  border-color: var(--av-danger);
  color: var(--av-danger);
}

button:disabled { opacity: 0.4; cursor: default; }
button:disabled:hover { background: transparent; }
/* A disabled filled button keeps its fill on hover, or its white label vanishes. */
button.primary:disabled:hover { background: var(--av-blue); }

.panel-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--av-border);
}

/* ---------- full mode ---------- */

.pill {
  display: inline-block;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 999px;
  margin-right: 5px;
  vertical-align: 1px;
  background: var(--av-hover);
  color: var(--av-muted);
}
.pill-editing, .pill-queued { background: var(--av-blue-fill); color: var(--av-blue); }
.pill-live, .pill-committed { background: var(--av-ok-fill); color: var(--av-ok); }
/* Applied but the build is broken: amber, distinct from success and from failure. */
.pill-unverified { background: var(--av-warn-fill); color: var(--av-warn); }
.pill-failed { background: var(--av-danger-fill); color: var(--av-danger); }

.batch {
  border-top: 1px solid var(--av-border);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 40vh;
  overflow-y: auto;
}
.batch[hidden] { display: none; }
.batch-head { display: flex; align-items: center; gap: 4px; }
.batch-title { flex: 1; min-width: 0; font-size: 12px; font-weight: 500; }
.batch-close { opacity: 1; }
.batch-progress { font-size: 11.5px; color: var(--av-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.batch-editing .batch-progress::before, .batch-queued .batch-progress::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 6px;
  background: var(--av-blue);
  animation: av-pulse 1.1s ease-in-out infinite;
}
@keyframes av-pulse { 50% { opacity: 0.25; } }
.batch-summary { font-size: 12px; white-space: pre-line; }
.batch-files {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  color: var(--av-muted);
  white-space: pre-line;
}
.batch-output {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 140px;
  overflow: auto;
  padding: 6px 7px;
  border-radius: 6px;
  background: var(--av-hover);
  user-select: text;
}
.batch-actions { justify-content: flex-end; }

.panel-status {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  padding: 5px 10px;
  border-top: 1px solid var(--av-border);
  color: var(--av-muted);
}
.panel-status[hidden] { display: none; }
.panel-status.tone-warn { color: var(--av-warn); background: var(--av-warn-fill); }
.panel-status.tone-error { color: var(--av-danger); background: var(--av-danger-fill); }

/* ---------- playground session ---------- */

.session {
  border-top: 1px solid var(--av-border);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.session[hidden] { display: none; }
.session-head { display: flex; align-items: center; gap: 4px; }
.session-title { flex: 1; font-size: 12px; font-weight: 600; }
.session-detail { font-size: 11.5px; color: var(--av-muted); }
.session-lines {
  font-size: 11.5px;
  white-space: pre-line;
  max-height: 120px;
  overflow-y: auto;
}
.session-active { background: var(--av-blue-fill); }
.session-done { background: var(--av-ok-fill); }
.session-failed { background: var(--av-danger-fill); }
.session-failed .session-detail { color: var(--av-danger); }
.session-bar { height: 4px; border-radius: 2px; background: var(--av-border); overflow: hidden; }
.session-bar-fill { height: 100%; background: var(--av-blue); transition: width 300ms ease; }
.session-busy .session-title::before {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 6px;
  background: var(--av-blue);
  animation: av-pulse 1.1s ease-in-out infinite;
}
.session-actions { justify-content: flex-end; }
button.armed { background: var(--av-blue-dark); }

/* Commit to dev ships to the shared environment: green, bolder, never mistaken for Apply. */
button.commit,
button.commit:disabled,
button.commit:disabled:hover { background: var(--av-commit); color: #fff; }
button.commit { font-weight: 600; padding: 6px 14px; }
button.commit::before { content: '✓ '; }
button.commit:hover,
button.commit.armed { background: var(--av-commit-dark); }
button.commit.armed { box-shadow: 0 0 0 3px var(--av-ok-fill); }

/* ---------- connect sheet ---------- */

.sheet {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 340px;
  max-width: calc(100vw - 32px);
  background: var(--av-surface);
  border: 1px solid var(--av-border);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.3);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sheet h2 { margin: 0; font-size: 14px; font-weight: 600; }
.sheet p { margin: 0; font-size: 12px; color: var(--av-muted); }
.sheet input {
  width: 100%;
  font: inherit;
  font-size: 12.5px;
  padding: 7px 8px;
  border: 1px solid var(--av-border);
  border-radius: 6px;
  background: var(--av-input);
  color: var(--av-text);
  outline: none;
}
.sheet input:focus { border-color: var(--av-blue); box-shadow: 0 0 0 3px var(--av-blue-fill); }
.sheet .error { color: var(--av-danger); font-size: 12px; }
.sheet a { color: var(--av-blue); font-size: 12px; cursor: pointer; }

/* ---------- toast ---------- */

.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%) translateY(8px);
  background: var(--av-toast);
  color: #fff;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 500;
  opacity: 0;
  transition: opacity 140ms ease, transform 140ms ease;
  pointer-events: none;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.3);
}

.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
`;

const TOKENS_LIGHT = `
  --av-blue: #2563eb;
  --av-blue-dark: #1d4ed8;
  --av-blue-fill: rgba(37, 99, 235, 0.09);
  --av-blue-soft: rgba(37, 99, 235, 0.28);
  --av-surface: #ffffff;
  --av-input: #ffffff;
  --av-border: #e2e8f0;
  --av-hover: #f1f5f9;
  --av-text: #0f172a;
  --av-muted: #64748b;
  --av-danger: #dc2626;
  --av-danger-fill: rgba(220, 38, 38, 0.1);
  --av-ok: #15803d;
  --av-ok-fill: rgba(22, 163, 74, 0.12);
  --av-commit: #16a34a;
  --av-commit-dark: #15803d;
  --av-warn: #b45309;
  --av-warn-fill: rgba(217, 119, 6, 0.12);
  --av-toast: #0f172a;
`;

const TOKENS_DARK = `
  --av-blue: #3b82f6;
  --av-blue-dark: #2563eb;
  --av-blue-fill: rgba(59, 130, 246, 0.14);
  --av-blue-soft: rgba(59, 130, 246, 0.3);
  --av-surface: #1e293b;
  --av-input: #0f172a;
  --av-border: #334155;
  --av-hover: #334155;
  --av-text: #f1f5f9;
  --av-muted: #94a3b8;
  --av-danger: #f87171;
  --av-danger-fill: rgba(248, 113, 113, 0.14);
  --av-ok: #4ade80;
  --av-ok-fill: rgba(74, 222, 128, 0.14);
  --av-commit: #16a34a;
  --av-commit-dark: #15803d;
  --av-warn: #fbbf24;
  --av-warn-fill: rgba(251, 191, 36, 0.14);
  --av-toast: #334155;
`;

export interface UiHost {
  layer: HTMLDivElement;
  destroy(): void;
}

let host: HTMLElement | null = null;
let ui: UiHost | null = null;

/**
 * Closed shadow root on documentElement: page CSS, page scripts and Arc Boosts
 * can neither restyle nor query our UI.
 */
export function getHost(): UiHost {
  if (ui) return ui;

  host = document.createElement(HOST_TAG);
  host.style.cssText = 'all: initial; position: static;';
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { ${TOKENS_LIGHT} }
    @media (prefers-color-scheme: dark) { :host { ${TOKENS_DARK} } }
    ${STYLES}
    ${LAUNCHER_STYLES}
  `;
  root.appendChild(style);

  const layer = document.createElement('div');
  layer.className = 'layer';
  root.appendChild(layer);

  document.documentElement.appendChild(host);

  ui = {
    layer,
    destroy() {
      host?.remove();
      host = null;
      ui = null;
    },
  };
  return ui;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;

export function toast(message: string) {
  const { layer } = getHost();
  if (!toastEl) {
    toastEl = el('div', 'toast');
    layer.appendChild(toastEl);
  }
  toastEl.textContent = message;
  // Force reflow so the transition replays on repeated toasts.
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('show'), 2200);
}
