import type { CommentRecord } from '../types';
import { buildRecord } from './capture';
import { buildMarkdown, copyToClipboard } from './export';
import * as full from './full';
import { pageContext } from './page';
import * as picker from './picker';
import * as store from './store';
import * as composer from './ui/composer';
import * as highlight from './ui/highlight';
import { toast } from './ui/host';
import * as launcher from './ui/launcher';
import * as panel from './ui/panel';
import * as pins from './ui/pins';

let active = false;
let mounted = false;

// ---------------------------------------------------------------- rendering

function refreshPins() {
  // Resolved comments leave the page entirely — no pin, no badge count.
  const open = store.open();
  const stale = pins.render(open);
  if (stale.size) store.markStale(stale);
  panel.render(store.list());
  launcher.setCount(open.length);
  full.render();
}

// ---------------------------------------------------------------- mode

async function ensureMounted() {
  if (mounted) return;
  mounted = true;

  await panel.mount({
    onSelect: (record) => focusComment(record),
    onDelete: (record) => void store.remove(record.id).then(refreshPins),
    onResolve: (record, resolved) => {
      void store.setResolved(record.id, resolved).then(() => {
        refreshPins();
        toast(resolved ? `#${record.n} resolved` : `#${record.n} reopened`);
      });
    },
    onExport: () => void doExport(),
    onClear: () => void store.clear().then(refreshPins),
    onClose: () => deactivate(),
    onHelp: () => {
      chrome.runtime.sendMessage({ type: 'OPEN_HELP' }).catch(() => {});
    },
    onSettings: () => {
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {});
    },
    onApply: () => void full.apply(),
    onBatchAction: (action, batchId) => void full.batchAction(action, batchId),
    onSessionAction: (action) => void full.sessionAction(action),
  });
  full.render();

  pins.setClickHandler((record, target) => {
    if (!target) {
      toast(`#${record.n}: element not found on this page`);
      return;
    }
    editComment(record, target);
  });
}

async function activate() {
  if (active) return;
  active = true;
  await ensureMounted();

  panel.open();
  full.onPanelOpen();
  launcher.setActive(true);
  chrome.runtime.sendMessage({ type: 'ACTIVE', active: true }).catch(() => {});

  picker.start({
    onPick: (target) => openComposerFor(target),
    onExit: () => deactivate(),
  });

  refreshPins();
}

function deactivate() {
  if (!active) return;
  active = false;
  picker.stop();
  composer.close();
  panel.close();
  full.onPanelClose();
  highlight.hide();
  launcher.setActive(false);
  chrome.runtime.sendMessage({ type: 'ACTIVE', active: false }).catch(() => {});
  refreshPins();
}

function toggle() {
  if (active) deactivate();
  else void activate();
}

// ---------------------------------------------------------------- comments

function openComposerFor(target: Element) {
  composer.open({
    target,
    mode: 'create',
    onSave: (text) => {
      const record = buildRecord(target, text, store.nextNumber());
      const baseSha = full.baseShaForNewComment();
      if (baseSha) record.baseSha = baseSha;
      void store.add(record).then(() => {
        picker.resume();
        refreshPins();
      });
    },
    onCancel: () => {
      picker.resume();
    },
  });
}

function editComment(record: CommentRecord, target: Element) {
  highlight.show(target, { locked: true });
  composer.open({
    target,
    mode: 'edit',
    initial: record.comment,
    onSave: (text) => {
      void store.update(record.id, { comment: text }).then(refreshPins);
      if (active) picker.resume();
      else highlight.hide();
    },
    onDelete: () => {
      void store.remove(record.id).then(refreshPins);
      if (active) picker.resume();
      else highlight.hide();
    },
    onResolve: record.resolved
      ? undefined
      : () => {
          void store.setResolved(record.id, true).then(() => {
            refreshPins();
            toast(`#${record.n} resolved`);
          });
          if (active) picker.resume();
          else highlight.hide();
        },
    onCancel: () => {
      if (active) picker.resume();
      else highlight.hide();
    },
  });
}

function focusComment(record: CommentRecord) {
  let target: Element | null = null;
  try {
    target = document.querySelector(record.selector);
  } catch {
    target = null;
  }
  if (!target) {
    toast(`#${record.n}: element not found on this page`);
    return;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  editComment(record, target);
  // Re-place highlight and composer once the smooth scroll settles.
  setTimeout(() => {
    if (target?.isConnected) highlight.show(target, { locked: true });
    composer.reposition();
  }, 340);
}

async function doExport() {
  const records = store.open();
  if (!records.length) {
    toast(store.list().length ? 'All comments are resolved' : 'No comments to export');
    return;
  }
  const markdown = buildMarkdown(records, pageContext());
  const ok = await copyToClipboard(markdown);
  toast(
    ok
      ? `Copied ${records.length} comment${records.length === 1 ? '' : 's'} to clipboard`
      : 'Copy failed — check clipboard permissions',
  );
}

// ---------------------------------------------------------------- lifecycle

let currentKey = store.pageKey();

async function rehydrate() {
  await store.load();
  refreshPins();
}

async function mountLauncher() {
  await launcher.mount({ onToggle: toggle });
  launcher.setCount(store.open().length);
  launcher.setActive(active);
}

/**
 * SPA route changes don't reload the page, so storage key and pin anchors have
 * to be recomputed. Patching the history methods is the only reliable signal
 * alongside popstate.
 */
function watchNavigation() {
  const fire = () => {
    const key = store.pageKey();
    if (key === currentKey) return;
    currentKey = key;
    composer.close();
    if (active) picker.resume();
    void rehydrate().then(() => full.onNavigate());
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      queueMicrotask(fire);
      return result;
    };
  }
  window.addEventListener('popstate', () => queueMicrotask(fire));

  // Client routers often re-render asynchronously; re-anchor pins once the DOM
  // settles so selectors resolve against the new tree.
  const observer = new MutationObserver(() => {
    if (!store.list().length) return;
    schedulePinRefresh();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

let pinRefreshTimer: number | undefined;
function schedulePinRefresh() {
  clearTimeout(pinRefreshTimer);
  pinRefreshTimer = window.setTimeout(refreshPins, 400);
}

store.subscribe(() => {
  panel.render(store.list());
  launcher.setCount(store.open().length);
});

chrome.runtime.onMessage.addListener((msg: { type: string }) => {
  if (msg.type === 'TOGGLE') toggle();
});

async function init() {
  await rehydrate();
  watchNavigation();
  await full.init();

  // On local dev hosts — and on any site configured for Full, which is a dev
  // environment by definition — the extension is always one click away.
  if (launcher.isLocalHost() || full.currentMode() === 'full') await mountLauncher();
  full.onModeChange((mode) => {
    if (mode === 'full') void mountLauncher();
  });
}

void init();
