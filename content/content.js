/**
 * content.js — Main content script orchestrator.
 *
 * Manages the reading session lifecycle:
 *   init → extract → group lines → create engine → start/pause/resume/stop
 *
 * Receives messages from:
 *   - background/service-worker.js (keyboard command relay)
 *   - popup/popup.js (toggle, stop, settings update, status query)
 *   - options/options.js (settings broadcast)
 */

(function () {
  'use strict';

  // One session object lives here for the duration of the tab
  let session = null;

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async function initializeSession() {
    const settings = await StorageUtil.getSettings();

    // Auto-detect dark mode and swap highlight color if needed
    // (content block not yet known here; we'll re-check after extraction)

    // Wait for fonts so getBoundingClientRect() returns correct metrics
    try { await document.fonts.ready; } catch (_) {}

    const extractor = new TextExtractor();
    const wordList  = extractor.extract();

    if (!wordList || wordList.length === 0) {
      const h = new Highlighter(settings);
      h.mount();
      h.showNoContentToast('Speed Reader: No readable text found on this page.');
      setTimeout(() => h.unmount(), 4000);
      return null;
    }

    const wordLines = groupWordsIntoLines(wordList);
    if (wordLines.length === 0) return null;

    // Dark mode detection (use the parent element of first word's text node)
    const firstEl = wordList[0].textNode.parentElement;
    if (firstEl && Highlighter.detectDarkMode(firstEl)) {
      settings.highlightColor = settings.darkHighlightColor || '#6495ED';
    }

    const urlHash      = StorageUtil.hashURL(window.location.href);
    const lastPosition = await StorageUtil.getLastPosition(urlHash);

    const highlighter   = new Highlighter(settings);
    const scrollManager = new ScrollManager(settings);
    const engine        = new EyeMovementEngine(wordLines, settings, highlighter, scrollManager);

    highlighter.mount();

    // When reading completes: clear saved position and show the stats card
    engine._onComplete = async (stats) => {
      await StorageUtil.clearLastPosition(urlHash);
      highlighter.showCompletionCard(stats);
    };

    return {
      engine,
      highlighter,
      scrollManager,
      settings,
      urlHash,
      totalWords: wordList.length,
      startPosition: lastPosition || 0
    };
  }

  async function startReading() {
    if (session && session.engine.state === 'reading') return;

    if (!session) {
      session = await initializeSession();
      if (!session) return;
    }

    session.engine.start(session.startPosition);
  }

  function pauseReading() {
    session?.engine.pause();
  }

  function resumeReading() {
    session?.engine.resume();
  }

  async function stopReading() {
    if (!session) return;
    const pos = session.engine.globalWordIndex;
    try { await StorageUtil.saveLastPosition(session.urlHash, pos); } catch (_) {}
    session.engine.stop();
    session.highlighter.unmount();
    session = null;
  }

  async function toggleReading() {
    if (!session) {
      await startReading();
      return;
    }
    const state = session.engine.state;
    if (state === 'reading')     pauseReading();
    else if (state === 'paused') resumeReading();
    else if (state === 'idle' || state === 'done') {
      // Re-initialize (article may have changed or was completed)
      session.engine.stop();
      session.highlighter.unmount();
      session = null;
      await startReading();
    }
  }

  // -------------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'TOGGLE_READING':
        toggleReading();
        break;

      case 'START_READING':
        startReading();
        break;

      case 'PAUSE_READING':
        pauseReading();
        break;

      case 'RESUME_READING':
        resumeReading();
        break;

      case 'STOP_READING':
        stopReading();
        break;

      case 'UPDATE_SETTINGS':
        if (session) {
          session.settings = { ...session.settings, ...msg.settings };
          session.engine.applySettings(msg.settings);
        }
        // Also persist to storage
        StorageUtil.saveSettings(msg.settings).catch(() => {});
        break;

      case 'GET_STATUS':
        sendResponse({
          state:    session?.engine.state || 'idle',
          progress: session?.engine.globalWordIndex || 0,
          total:    session?.totalWords || 0
        });
        return true; // async response

      default:
        break;
    }
  });

  // -------------------------------------------------------------------------
  // Keyboard shortcuts (content-script fallback + Space intercept)
  //
  //  Alt+R — toggle (start / pause / resume)   [also handled by commands API]
  //  Alt+S — stop and save position            [also handled by commands API]
  //  Space — pause / resume ONLY while reading (never stolen from normal page use)
  // -------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    // Never intercept when typing in an input / textarea / contenteditable
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' ||
        document.activeElement?.isContentEditable) return;

    if (e.altKey && e.key === 'r') {
      e.preventDefault();
      toggleReading();
      return;
    }

    if (e.altKey && e.key === 's') {
      e.preventDefault();
      stopReading();
      return;
    }

    // Space: only intercept if reading is active (avoid breaking page scroll)
    if (e.key === ' ' && session) {
      const state = session.engine.state;
      if (state === 'reading' || state === 'paused' ||
          state === 'line-pause' || state === 'return-sweep' || state === 'page-turn') {
        e.preventDefault();
        if (state === 'reading') pauseReading();
        else resumeReading();
      }
    }
  });

})();
