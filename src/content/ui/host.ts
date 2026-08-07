import { LAUNCHER_STYLES } from './launcher';

const HOST_TAG = 'agentivision-root';

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
  width: 320px;
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

.panel-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--av-border);
}

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
