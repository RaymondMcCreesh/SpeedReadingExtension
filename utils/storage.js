/**
 * storage.js — chrome.storage.sync wrapper with defaults, LRU position cache,
 * and Firefox < 132 fallback for chrome.storage.session.
 */

var StorageUtil = (() => {
  const DEFAULTS = {
    wpm: 300,
    chunkSize: 3,
    chunkOverlap: 1,
    lineEndPause: 400,
    returnSweepSpeed: 150,
    highlightColor: '#FFEB3B',
    highlightOpacity: 0.6,
    scrollMode: 'mixed',       // 'eye-only' | 'auto-scroll' | 'mixed'
    eyeJumpLines: 3,
    complexityAdapt: true,
    progressIndicator: true,
    darkHighlightColor: '#6495ED',
    includeComments: false,
    schemaVersion: 1
  };

  const MAX_POSITIONS = 20;
  const POSITIONS_KEY = 'urlPositions'; // stored as [{hash, index}] array

  // Session storage: chrome.storage.session (Chrome 102+) or local fallback (Firefox < 132)
  const sessionStore = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session)
    ? chrome.storage.session
    : chrome.storage.local;

  async function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (items) => {
        resolve({ ...DEFAULTS, ...items });
      });
    });
  }

  async function saveSettings(partial) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.set(partial, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
  }

  async function resetToDefaults() {
    return saveSettings(DEFAULTS);
  }

  /**
   * Get the saved word index for a URL hash, or null if not found.
   */
  async function getLastPosition(urlHash) {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ [POSITIONS_KEY]: [] }, (items) => {
        const positions = items[POSITIONS_KEY];
        const entry = positions.find(p => p.hash === urlHash);
        resolve(entry ? entry.index : null);
      });
    });
  }

  /**
   * Save the current reading position for a URL hash.
   * Maintains an LRU list capped at MAX_POSITIONS entries.
   */
  async function saveLastPosition(urlHash, wordIndex) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get({ [POSITIONS_KEY]: [] }, (items) => {
        let positions = items[POSITIONS_KEY];
        // Remove existing entry for this hash
        positions = positions.filter(p => p.hash !== urlHash);
        // Prepend new entry
        positions.unshift({ hash: urlHash, index: wordIndex });
        // Evict oldest beyond cap
        if (positions.length > MAX_POSITIONS) {
          positions = positions.slice(0, MAX_POSITIONS);
        }
        chrome.storage.sync.set({ [POSITIONS_KEY]: positions }, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
    });
  }

  /**
   * Clear saved position for a URL hash (e.g. on reading completion).
   */
  async function clearLastPosition(urlHash) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get({ [POSITIONS_KEY]: [] }, (items) => {
        const positions = items[POSITIONS_KEY].filter(p => p.hash !== urlHash);
        chrome.storage.sync.set({ [POSITIONS_KEY]: positions }, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
    });
  }

  /**
   * Subscribe to settings changes. Returns an unsubscribe function.
   */
  function onSettingsChanged(callback) {
    const listener = (changes, area) => {
      if (area !== 'sync') return;
      const updated = {};
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (key in DEFAULTS) updated[key] = newValue;
      }
      if (Object.keys(updated).length > 0) callback(updated);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  /**
   * Write defaults for any keys not already set (called on extension install).
   */
  async function initDefaults() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(Object.keys(DEFAULTS), (existing) => {
        const missing = {};
        for (const [k, v] of Object.entries(DEFAULTS)) {
          if (!(k in existing)) missing[k] = v;
        }
        if (Object.keys(missing).length === 0) { resolve(); return; }
        chrome.storage.sync.set(missing, resolve);
      });
    });
  }

  /**
   * Simple djb2 hash of a URL string → base-36 string (compact storage key).
   */
  function hashURL(url) {
    let hash = 5381;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) + hash) + url.charCodeAt(i);
      hash |= 0; // force 32-bit int
    }
    return (hash >>> 0).toString(36);
  }

  return {
    DEFAULTS,
    getSettings,
    saveSettings,
    resetToDefaults,
    getLastPosition,
    saveLastPosition,
    clearLastPosition,
    onSettingsChanged,
    initDefaults,
    hashURL,
    sessionStore
  };
})();
