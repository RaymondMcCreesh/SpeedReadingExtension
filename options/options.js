'use strict';

const DEFAULTS = {
  wpm: 300,
  chunkSize: 3,
  chunkOverlap: 1,
  lineEndPause: 400,
  returnSweepSpeed: 150,
  highlightColor: '#FFEB3B',
  darkHighlightColor: '#6495ED',
  highlightOpacity: 0.6,
  scrollMode: 'mixed',
  eyeJumpLines: 3,
  complexityAdapt: true,
  progressIndicator: true
};

// Sliders with live value badges
const SLIDERS = [
  { id: 'wpm',              badge: 'wpm-badge',              format: v => v },
  { id: 'chunkSize',        badge: 'chunkSize-badge',        format: v => v },
  { id: 'chunkOverlap',     badge: 'chunkOverlap-badge',     format: v => v },
  { id: 'lineEndPause',     badge: 'lineEndPause-badge',     format: v => v },
  { id: 'returnSweepSpeed', badge: 'returnSweepSpeed-badge', format: v => v },
  { id: 'highlightOpacity', badge: 'highlightOpacity-badge', format: v => parseFloat(v).toFixed(2) },
  { id: 'eyeJumpLines',     badge: 'eyeJumpLines-badge',     format: v => v }
];

// ── Load settings ──────────────────────────────────────────────────────────
chrome.storage.sync.get(DEFAULTS, (settings) => {
  // Populate sliders
  for (const { id, badge, format } of SLIDERS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = settings[id];
    document.getElementById(badge).textContent = format(settings[id]);
  }

  // Colour pickers
  document.getElementById('highlightColor').value     = settings.highlightColor;
  document.getElementById('darkHighlightColor').value = settings.darkHighlightColor;

  // Select
  document.getElementById('scrollMode').value = settings.scrollMode;

  // Checkboxes
  document.getElementById('complexityAdapt').checked    = settings.complexityAdapt;
  document.getElementById('progressIndicator').checked  = settings.progressIndicator;

  // Show/hide eyeJumpLines row based on scroll mode
  toggleEyeJumpRow(settings.scrollMode);
});

// ── Live slider badges ─────────────────────────────────────────────────────
for (const { id, badge, format } of SLIDERS) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('input', (e) => {
    document.getElementById(badge).textContent = format(e.target.value);
  });
}

// ── Scroll mode toggle ─────────────────────────────────────────────────────
document.getElementById('scrollMode').addEventListener('change', (e) => {
  toggleEyeJumpRow(e.target.value);
});

function toggleEyeJumpRow(mode) {
  const row = document.getElementById('eyeJumpLines-row');
  row.classList.toggle('hidden', mode !== 'mixed');
}

// ── Save ───────────────────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', async () => {
  const updated = {};

  for (const { id } of SLIDERS) {
    const el = document.getElementById(id);
    if (!el) continue;
    // Parse as float for opacity, int for everything else
    updated[id] = id === 'highlightOpacity'
      ? parseFloat(el.value)
      : parseInt(el.value, 10);
  }

  updated.highlightColor     = document.getElementById('highlightColor').value;
  updated.darkHighlightColor = document.getElementById('darkHighlightColor').value;
  updated.scrollMode         = document.getElementById('scrollMode').value;
  updated.complexityAdapt    = document.getElementById('complexityAdapt').checked;
  updated.progressIndicator  = document.getElementById('progressIndicator').checked;

  await new Promise(resolve => chrome.storage.sync.set(updated, resolve));

  // Broadcast to all tabs with active sessions
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SETTINGS', settings: updated });
    } catch (_) { /* tab may not have content script */ }
  }

  const msg = document.getElementById('save-msg');
  msg.textContent = '✓ Settings saved.';
  setTimeout(() => { msg.textContent = ''; }, 2500);
});

// ── Reset ──────────────────────────────────────────────────────────────────
document.getElementById('btn-reset').addEventListener('click', async () => {
  if (!confirm('Reset all settings to defaults?')) return;

  await new Promise(resolve => chrome.storage.sync.set(DEFAULTS, resolve));

  // Re-populate UI
  for (const { id, badge, format } of SLIDERS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = DEFAULTS[id];
    document.getElementById(badge).textContent = format(DEFAULTS[id]);
  }
  document.getElementById('highlightColor').value     = DEFAULTS.highlightColor;
  document.getElementById('darkHighlightColor').value = DEFAULTS.darkHighlightColor;
  document.getElementById('scrollMode').value         = DEFAULTS.scrollMode;
  document.getElementById('complexityAdapt').checked  = DEFAULTS.complexityAdapt;
  document.getElementById('progressIndicator').checked = DEFAULTS.progressIndicator;
  toggleEyeJumpRow(DEFAULTS.scrollMode);

  const msg = document.getElementById('save-msg');
  msg.textContent = '✓ Reset to defaults.';
  setTimeout(() => { msg.textContent = ''; }, 2500);
});
