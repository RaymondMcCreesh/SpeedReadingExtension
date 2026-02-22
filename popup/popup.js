'use strict';

(async () => {
  // ── Helpers ──────────────────────────────────────────────────────────────

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToContent(payload) {
    const tab = await getActiveTab();
    if (!tab?.id) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, payload);
    } catch (_) {
      return null;
    }
  }

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const btnToggle    = document.getElementById('btn-toggle');
  const btnStop      = document.getElementById('btn-stop');
  const statusDot    = document.getElementById('status-dot');
  const statusText   = document.getElementById('status-text');
  const progressText = document.getElementById('progress-text');
  const wpmSlider    = document.getElementById('wpm-slider');
  const wpmValue     = document.getElementById('wpm-value');
  const chunkSlider  = document.getElementById('chunk-slider');
  const chunkValue   = document.getElementById('chunk-value');
  const scrollMode   = document.getElementById('scroll-mode');
  const openOptions  = document.getElementById('open-options');

  // ── Load settings ────────────────────────────────────────────────────────
  const settings = await new Promise(resolve =>
    chrome.storage.sync.get({
      wpm: 300, chunkSize: 3, scrollMode: 'mixed'
    }, resolve)
  );

  wpmSlider.value   = settings.wpm;
  wpmValue.textContent = settings.wpm;
  chunkSlider.value = settings.chunkSize;
  chunkValue.textContent = settings.chunkSize;
  scrollMode.value  = settings.scrollMode;

  // ── Fetch current status from content script ──────────────────────────────
  function renderStatus(status) {
    const state    = status?.state || 'idle';
    const progress = status?.progress || 0;
    const total    = status?.total || 0;

    statusDot.className = `dot dot-${state === 'done' ? 'done' : state}`;

    const labels = { idle: 'Ready', reading: 'Reading', paused: 'Paused', done: 'Done', 'line-pause': 'Reading', 'return-sweep': 'Reading' };
    statusText.textContent = labels[state] || 'Ready';

    if (total > 0 && progress > 0) {
      const pct = Math.round((progress / total) * 100);
      progressText.textContent = `${pct}%`;
    } else {
      progressText.textContent = '';
    }

    const isActive = state === 'reading' || state === 'line-pause' || state === 'return-sweep';
    const isPaused = state === 'paused';
    const isDone   = state === 'done';

    btnToggle.textContent = isActive ? '⏸ Pause' : (isPaused ? '▶ Resume' : '▶ Start');
    btnToggle.disabled    = isDone;
    btnStop.disabled      = state === 'idle' || isDone;
  }

  const status = await sendToContent({ type: 'GET_STATUS' });
  renderStatus(status);

  // Poll status while popup is open
  const pollInterval = setInterval(async () => {
    const s = await sendToContent({ type: 'GET_STATUS' });
    renderStatus(s);
  }, 1500);

  window.addEventListener('unload', () => clearInterval(pollInterval));

  // ── Controls ──────────────────────────────────────────────────────────────
  btnToggle.addEventListener('click', async () => {
    await sendToContent({ type: 'TOGGLE_READING' });
    setTimeout(async () => {
      const s = await sendToContent({ type: 'GET_STATUS' });
      renderStatus(s);
    }, 150);
  });

  btnStop.addEventListener('click', async () => {
    await sendToContent({ type: 'STOP_READING' });
    renderStatus({ state: 'idle', progress: 0, total: 0 });
  });

  openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // ── Settings sliders (debounced) ──────────────────────────────────────────
  wpmSlider.addEventListener('input', debounce(async (e) => {
    const wpm = parseInt(e.target.value, 10);
    wpmValue.textContent = wpm;
    await chrome.storage.sync.set({ wpm });
    sendToContent({ type: 'UPDATE_SETTINGS', settings: { wpm } });
  }, 200));

  chunkSlider.addEventListener('input', debounce(async (e) => {
    const chunkSize = parseInt(e.target.value, 10);
    chunkValue.textContent = chunkSize;
    await chrome.storage.sync.set({ chunkSize });
    sendToContent({ type: 'UPDATE_SETTINGS', settings: { chunkSize } });
  }, 200));

  scrollMode.addEventListener('change', async (e) => {
    const mode = e.target.value;
    await chrome.storage.sync.set({ scrollMode: mode });
    sendToContent({ type: 'UPDATE_SETTINGS', settings: { scrollMode: mode } });
  });

})();
