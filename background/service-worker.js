/**
 * service-worker.js — MV3 background service worker.
 *
 * Responsibilities:
 *   - Set default settings on first install
 *   - Relay keyboard commands (Alt+R) to the active tab's content script
 *   - Route messages between popup and content script
 *
 * The content script is the source of truth for reading state.
 * The service worker does NOT track per-tab state — it only relays messages.
 * This is intentional: MV3 service workers can be terminated at any time.
 */

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // storage.js is not available in the service worker context,
    // so we replicate DEFAULTS inline here.
    const DEFAULTS = {
      wpm: 300,
      chunkSize: 3,
      chunkOverlap: 1,
      lineEndPause: 400,
      returnSweepSpeed: 150,
      highlightColor: '#FFEB3B',
      highlightOpacity: 0.6,
      scrollMode: 'mixed',
      eyeJumpLines: 3,
      complexityAdapt: true,
      progressIndicator: true,
      darkHighlightColor: '#6495ED',
      includeComments: false,
      schemaVersion: 1
    };

    // Only write keys that don't already exist
    chrome.storage.sync.get(Object.keys(DEFAULTS), (existing) => {
      const missing = {};
      for (const [k, v] of Object.entries(DEFAULTS)) {
        if (!(k in existing)) missing[k] = v;
      }
      if (Object.keys(missing).length > 0) {
        chrome.storage.sync.set(missing);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Keyboard command relay
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const msgType = command === 'toggle-reading' ? 'TOGGLE_READING'
                : command === 'stop-reading'   ? 'STOP_READING'
                : null;
  if (!msgType) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: msgType });
  } catch (_) {
    // Content script not injected on this page (chrome://, about:, etc.)
  }
});

// ---------------------------------------------------------------------------
// Message routing (popup ↔ content script)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages from the popup don't have a tab associated with the sender.
  // Messages from content scripts DO have sender.tab.
  // We relay popup→content messages by querying the active tab.

  if (msg.type === 'POPUP_TO_CONTENT') {
    // Popup sends { type: 'POPUP_TO_CONTENT', payload: { type, ...data } }
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) { sendResponse({ error: 'No active tab' }); return; }
      try {
        const response = await chrome.tabs.sendMessage(tab.id, msg.payload);
        sendResponse(response);
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true; // async response
  }

  // Messages from content script arriving at the service worker
  // (e.g., READING_COMPLETE) — no action needed currently
  if (msg.type === 'READING_COMPLETE') {
    // Could update extension badge here in future
  }
});
