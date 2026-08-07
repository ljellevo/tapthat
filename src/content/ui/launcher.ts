import { el, getHost } from './host';
import { clampToViewport, makeDraggable } from './drag';

const POS_KEY = 'av:launcher-pos';

/**
 * Local development hosts. Covers the usual dev-server addresses plus the
 * `*.localhost` and `*.local` conventions and private-network IPs used when
 * testing from another device on the same LAN.
 */
export function isLocalHost(hostname = location.hostname): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') {
    return true;
  }
  if (hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.test')) {
    return true;
  }
  // 10.x, 192.168.x, 172.16–31.x
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) return true;
  return false;
}

let node: HTMLButtonElement | null = null;
let teardownDrag: (() => void) | null = null;

async function loadPosition(): Promise<{ left: number; top: number } | null> {
  try {
    const bag = await chrome.storage.local.get(POS_KEY);
    return bag[POS_KEY] ?? null;
  } catch {
    return null;
  }
}

function savePosition(pos: { left: number; top: number }) {
  chrome.storage.local.set({ [POS_KEY]: pos }).catch(() => {});
}

export interface LauncherOptions {
  onToggle(): void;
}

export async function mount(opts: LauncherOptions) {
  if (node) return;
  const { layer } = getHost();

  node = el('button', 'launcher');
  node.type = 'button';
  node.title = 'Agentivision — click to comment, drag to move';
  node.setAttribute('aria-label', 'Toggle Agentivision annotation mode');

  const icon = el('span', 'launcher-icon');
  icon.innerHTML = ICON;
  node.appendChild(icon);

  const badge = el('span', 'launcher-badge');
  badge.style.display = 'none';
  node.appendChild(badge);

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
    onClick: opts.onToggle,
    onEnd: savePosition,
    className: 'dragging',
  });
}

export function setActive(active: boolean) {
  node?.classList.toggle('active', active);
}

export function setCount(count: number) {
  if (!node) return;
  const badge = node.querySelector('.launcher-badge') as HTMLElement | null;
  if (!badge) return;
  badge.textContent = String(count);
  badge.style.display = count > 0 ? 'flex' : 'none';
}

export function isMounted(): boolean {
  return !!node;
}

export function destroy() {
  teardownDrag?.();
  teardownDrag = null;
  node?.remove();
  node = null;
}

const ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

export const LAUNCHER_STYLES = `
.launcher {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid var(--av-border);
  background: var(--av-surface);
  color: var(--av-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  padding: 0;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.18), 0 1px 3px rgba(15, 23, 42, 0.1);
  touch-action: none;
  transition: color 120ms ease, background 120ms ease, box-shadow 120ms ease;
}

.launcher:hover { color: var(--av-blue); box-shadow: 0 6px 18px rgba(15, 23, 42, 0.24); }
.launcher.dragging { cursor: grabbing; transition: none; }

.launcher.active {
  background: var(--av-blue);
  border-color: var(--av-blue);
  color: #fff;
  box-shadow: 0 0 0 4px var(--av-blue-fill), 0 4px 14px rgba(37, 99, 235, 0.3);
}

.launcher-icon { display: flex; pointer-events: none; }

.launcher-badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--av-blue);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--av-surface);
  pointer-events: none;
}

.launcher.active .launcher-badge { background: #fff; color: var(--av-blue); }
`;
