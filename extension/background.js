// Service worker: opens the translator, issues tab-capture stream ids,
// manages the offscreen audio document and the opt-in "all sites" script.

const ALL_SITES = ['https://*/*', 'http://*/*'];
const ALL_SITES_SCRIPT_ID = 'all-sites';
const MEETING_HOSTS = [
  'https://meet.google.com/*',
  'https://teams.microsoft.com/*',
  'https://teams.live.com/*',
  'https://teams.cloud.microsoft/*',
  'https://*.zoom.us/wc/*',
];

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: 'welcome.html' });
  await syncAllSitesScript();
});

chrome.permissions.onAdded.addListener(syncAllSitesScript);
chrome.permissions.onRemoved.addListener(syncAllSitesScript);

// Floating button on every site is opt-in because it needs broad host access.
async function syncAllSitesScript() {
  const granted = await chrome.permissions.contains({ origins: ALL_SITES });
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_SCRIPT_ID] });
  if (granted && !existing.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: ALL_SITES_SCRIPT_ID,
        matches: ALL_SITES,
        excludeMatches: MEETING_HOSTS,
        js: ['content.js'],
        runAt: 'document_idle',
      },
    ]);
  } else if (!granted && existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_SCRIPT_ID] });
  }
}

// Toolbar click / Alt+Shift+T. This is also the "extension invocation" that
// chrome.tabCapture requires before it will capture this tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'open' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'open' });
    } catch {
      // Restricted page (chrome://, Web Store, PDF viewer...). Offer the standalone window.
      await openWindow(null);
      return;
    }
  }
  chrome.runtime.sendMessage({ type: 'tab-invoked', tabId: tab.id }).catch(() => {});
});

async function openWindow(tabId) {
  const query = tabId != null ? `?mode=window&tab=${tabId}` : '?mode=window';
  await chrome.windows.create({
    url: chrome.runtime.getURL(`sidebar.html${query}`),
    type: 'popup',
    width: 420,
    height: 780,
    focused: true,
  });
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'close-panel' }).catch(() => {});
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen ||= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture and transcribe tab audio the user asked to translate, and keep it audible.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

function explainCaptureError(message = '') {
  if (/not been invoked|activeTab/i.test(message)) {
    return {
      code: 'not-invoked',
      error:
        'Chrome only allows tab-audio capture after you click the extension\u2019s toolbar icon (or press Alt+Shift+T) on this tab. Do that, then press Start again.',
    };
  }
  if (/active stream/i.test(message)) {
    return { code: 'busy', error: 'This tab is already being captured (by this or another extension).' };
  }
  if (/chrome:\/\/|Chrome pages|cannot be captured/i.test(message)) {
    return { code: 'restricted', error: 'Chrome does not allow capturing this page.' };
  }
  return { code: 'capture-failed', error: message || 'Tab audio capture failed.' };
}

async function startTabAudio({ tabId, lang, processLocally }) {
  if (tabId == null) return { code: 'no-tab', error: 'No target tab is associated with this translator window.' };
  // Chrome refuses a new stream id while a previous capture of the tab is live.
  await stopTabAudio(tabId);
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    return explainCaptureError(err?.message);
  }
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'tab-audio:start',
    tabId,
    streamId,
    lang,
    processLocally,
  });
  return res || { error: 'The audio worker did not respond.' };
}

async function stopTabAudio(tabId) {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) return;
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'tab-audio:stop', tabId }).catch(() => {});
}

async function setStatus(tabId, active, label) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
    await chrome.action.setBadgeText({ tabId, text: active ? 'ON' : '' });
  } catch {
    /* tab gone */
  }
  chrome.tabs.sendMessage(tabId, { type: 'status', active, label }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  switch (msg.type) {
    case 'whoami':
      sendResponse({ tabId: sender.tab?.id ?? null });
      return;
    case 'popout':
      openWindow(msg.tabId ?? sender.tab?.id ?? null).then(() => sendResponse({ ok: true }));
      return true;
    case 'status':
      setStatus(msg.tabId ?? sender.tab?.id, !!msg.active, msg.label || '');
      return;
    case 'tab-audio:start':
      startTabAudio(msg).then(sendResponse, (err) => sendResponse({ error: err?.message || String(err) }));
      return true;
    case 'tab-audio:stop':
      stopTabAudio(msg.tabId).finally(() => sendResponse({ ok: true }));
      return true;
    case 'offscreen:idle':
      chrome.offscreen.closeDocument().catch(() => {});
      return;
  }
});
