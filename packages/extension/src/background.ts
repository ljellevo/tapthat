import type { ContentMessage } from './types';

const BADGE_ACTIVE = '#2563eb';
const BADGE_IDLE = '#64748b';

async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE' });
  } catch {
    // No content script on this page (chrome://, arc://, the web store, PDFs).
    // Nothing useful to do — the extension simply doesn't apply here.
  }
}

chrome.action.onClicked.addListener(toggleActiveTab);

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-annotate') void toggleActiveTab();
});

chrome.runtime.onMessage.addListener((msg: ContentMessage, sender) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (msg.type === 'COUNT') {
    void chrome.action.setBadgeText({
      tabId,
      text: msg.count > 0 ? String(msg.count) : '',
    });
  } else if (msg.type === 'ACTIVE') {
    void chrome.action.setBadgeBackgroundColor({
      tabId,
      color: msg.active ? BADGE_ACTIVE : BADGE_IDLE,
    });
  }
});
