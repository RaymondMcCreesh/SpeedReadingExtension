/**
 * highlighter.js — Fixed-position overlay renderer.
 *
 * Renders a moving highlight rectangle on top of page text without
 * modifying the page's DOM structure or text nodes. The highlight is
 * positioned using Range.getBoundingClientRect() on the current word chunk.
 *
 * Key design choices:
 * - Overlay appended to <body> (not inside transformed containers) so it
 *   is never trapped by CSS stacking contexts created by article elements.
 * - pointer-events:none on all extension elements — clicks pass through.
 * - Rects computed lazily per render (not cached) to handle lazy-loaded
 *   image layout shifts gracefully.
 * - ResizeObserver debounced at 100ms to reposition on layout changes.
 */
class Highlighter {
  constructor(settings) {
    this.settings = settings;
    this._overlayEl = null;
    this._rectEl = null;
    this._progressEl = null;
    this._badgeEl = null;
    this._currentWords = [];
    this._resizeObserver = null;
    this._resizeTimer = null;
    this._badgeTimer = null;
    this._mounted = false;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  mount() {
    if (this._mounted) return;

    // Overlay container (fixed, full viewport, pointer-events:none)
    this._overlayEl = document.createElement('div');
    this._overlayEl.id = 'sr-highlight-overlay';
    document.body.appendChild(this._overlayEl);

    // Highlight rectangle
    this._rectEl = document.createElement('div');
    this._rectEl.className = 'sr-highlight-rect';
    this._applyColor();
    this._overlayEl.appendChild(this._rectEl);

    // Progress bar
    this._progressEl = document.createElement('div');
    this._progressEl.id = 'sr-progress-bar';
    this._progressEl.setAttribute('role', 'progressbar');
    this._progressEl.setAttribute('aria-valuemin', '0');
    this._progressEl.setAttribute('aria-valuemax', '100');
    this._progressEl.setAttribute('aria-valuenow', '0');
    document.body.appendChild(this._progressEl);

    // Status badge (Paused / Done)
    this._badgeEl = document.createElement('div');
    this._badgeEl.id = 'sr-status-badge';
    document.body.appendChild(this._badgeEl);

    // Watch for layout changes (responsive reflow, font load, image load)
    this._resizeObserver = new ResizeObserver(() => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        if (this._currentWords.length > 0) {
          this._renderRect(this._currentWords);
        }
      }, 100);
    });
    this._resizeObserver.observe(document.body);

    this._mounted = true;
  }

  unmount() {
    if (!this._mounted) return;
    this._resizeObserver?.disconnect();
    clearTimeout(this._resizeTimer);
    clearTimeout(this._badgeTimer);
    this._overlayEl?.remove();
    this._progressEl?.remove();
    this._badgeEl?.remove();
    this._overlayEl = null;
    this._rectEl = null;
    this._progressEl = null;
    this._badgeEl = null;
    this._currentWords = [];
    this._mounted = false;
  }

  // ---------------------------------------------------------------------------
  // Highlight rendering
  // ---------------------------------------------------------------------------

  /**
   * Highlight the given chunk of word objects.
   * @param {Array<WordMeta>} words
   */
  highlight(words) {
    if (!this._mounted || !words || words.length === 0) return;
    this._currentWords = words;
    this._rectEl.classList.remove('sr-return-sweep');
    this._renderRect(words);
    this._rectEl.style.display = 'block';
  }

  hide() {
    if (!this._mounted) return;
    this._rectEl.style.display = 'none';
    this._currentWords = [];
  }

  // ---------------------------------------------------------------------------
  // Return sweep animation
  // ---------------------------------------------------------------------------

  /**
   * Animate highlight from the end of the current line to the start of the
   * next line, simulating the eye's return sweep.
   *
   * @param {Array<WordMeta>} currentLineWords - Words in the line just finished
   * @param {Array<WordMeta>} nextLineWords    - Words in the next line
   * @param {number} duration                 - Sweep duration in ms
   * @returns {Promise<void>} Resolves when the sweep animation completes
   */
  applyReturnSweepAnimation(currentLineWords, nextLineWords, duration) {
    return new Promise((resolve) => {
      if (!this._mounted) { resolve(); return; }
      if (!nextLineWords || nextLineWords.length === 0) { resolve(); return; }

      // Step 1: Suppress ALL transitions and jump the rect instantly to the
      // start of the next line. This prevents any cross-line sliding animation.
      this._rectEl.style.transition = 'none';
      this._renderRect(nextLineWords.slice(0, 1));

      // Step 2: Force a reflow so the browser registers the instant position
      // change before we restore transitions and trigger the fade-in.
      void this._rectEl.offsetWidth;

      // Step 3: Apply sweep class (dims opacity) and set fade duration.
      // The rect is already at the correct position — only opacity animates.
      this._rectEl.style.setProperty('--sr-sweep-duration', `${duration}ms`);
      this._rectEl.style.transition = '';   // restore CSS-defined transitions
      this._rectEl.classList.add('sr-return-sweep');

      // Step 4: After sweep duration, remove class — opacity fades back to full.
      // Guard against unmount() nulling _rectEl before the timer fires.
      setTimeout(() => {
        if (!this._rectEl) { resolve(); return; }
        this._rectEl.classList.remove('sr-return-sweep');
        this._rectEl.style.removeProperty('--sr-sweep-duration');
        resolve();
      }, duration);
    });
  }

  // ---------------------------------------------------------------------------
  // Progress & status
  // ---------------------------------------------------------------------------

  updateProgress(currentIndex, totalWords) {
    if (!this._mounted || !this.settings.progressIndicator) return;
    const pct = totalWords > 0 ? Math.min(100, Math.round((currentIndex / totalWords) * 100)) : 0;
    this._progressEl.style.width = `${pct}%`;
    this._progressEl.setAttribute('aria-valuenow', pct);
  }

  showBadge(text, autoDismissMs = 0) {
    if (!this._mounted) return;
    clearTimeout(this._badgeTimer);
    this._badgeEl.textContent = text;
    this._badgeEl.classList.add('sr-visible');
    if (autoDismissMs > 0) {
      this._badgeTimer = setTimeout(() => this.hideBadge(), autoDismissMs);
    }
  }

  hideBadge() {
    this._badgeEl?.classList.remove('sr-visible');
  }

  /**
   * Flash the highlight on/off N times over a word to help the reader
   * reacquire position after a page-turn scroll. Returns a Promise that
   * resolves when all flashes are complete.
   *
   * @param {Array<WordMeta>} words    - Words to flash (typically start of new line)
   * @param {number} count             - Number of flashes (default 3)
   * @param {number} intervalMs        - On+off cycle duration in ms (default 180)
   */
  flashWords(words, count = 3, intervalMs = 180) {
    return new Promise((resolve) => {
      if (!this._mounted || !words || words.length === 0) { resolve(); return; }

      // Position rect at the words without transition
      this._rectEl.style.transition = 'none';
      this._renderRect(words);
      void this._rectEl.offsetWidth;
      this._rectEl.style.transition = '';
      this._rectEl.style.display = 'block';

      let flashed = 0;
      const half = intervalMs / 2;

      const tick = () => {
        if (!this._rectEl) { resolve(); return; }
        if (flashed >= count) {
          // End with highlight fully visible
          this._rectEl.style.opacity = this.settings.highlightOpacity;
          resolve();
          return;
        }
        // Off
        this._rectEl.style.opacity = '0';
        setTimeout(() => {
          if (!this._rectEl) { resolve(); return; }
          // On
          this._rectEl.style.opacity = this.settings.highlightOpacity;
          flashed++;
          setTimeout(tick, half);
        }, half);
      };

      tick();
    });
  }

  /**
   * Show the reading-complete stats card — a fixed overlay card in the
   * bottom-right corner with words read, time, WPM, and comparison to average.
   *
   * @param {{ wordsRead: number, elapsedMs: number, actualWPM: number }} stats
   */
  showCompletionCard(stats) {
    // Remove any existing card
    document.getElementById('sr-completion-card')?.remove();

    const AVERAGE_WPM = 238; // generally accepted average adult silent reading speed

    const { wordsRead, elapsedMs, totalElapsedMs, actualWPM } = stats;

    // Format pure reading time (excludes line-end pauses and manual pauses)
    const fmt = (ms) => {
      const s   = Math.round(ms / 1000);
      const min = Math.floor(s / 60);
      const sec = s % 60;
      return min > 0 ? `${min}m ${sec.toString().padStart(2, '0')}s` : `${s}s`;
    };

    const readingTimeStr = fmt(elapsedMs);
    // Total session time includes line-break training pauses (what the user actually sat there for)
    const totalTimeStr   = fmt(totalElapsedMs);
    const showTotal      = Math.abs(totalElapsedMs - elapsedMs) > 2000; // only show if meaningfully different

    const pctFaster    = Math.round(((actualWPM - AVERAGE_WPM) / AVERAGE_WPM) * 100);
    const fasterStr    = pctFaster > 0
      ? `${pctFaster}% faster than average`
      : pctFaster < 0
        ? `${Math.abs(pctFaster)}% slower than average`
        : 'exactly average speed';

    // Time saved vs what an average reader would have taken (using reading time, not wall-clock)
    const avgTimeMs    = (wordsRead / AVERAGE_WPM) * 60000;
    const savedMs      = avgTimeMs - elapsedMs;
    const savedStr     = fmt(Math.abs(savedMs));
    const savedLabel   = savedMs > 0 ? `${savedStr} saved vs average` : `${savedStr} more than average`;

    const card = document.createElement('div');
    card.id = 'sr-completion-card';
    card.innerHTML = `
      <div class="sr-card-header">
        <span class="sr-card-icon">⚡</span>
        <span class="sr-card-title">Reading complete</span>
        <button class="sr-card-close" aria-label="Close">✕</button>
      </div>
      <div class="sr-card-stats">
        <div class="sr-stat">
          <span class="sr-stat-value">${wordsRead.toLocaleString()}</span>
          <span class="sr-stat-label">words read</span>
        </div>
        <div class="sr-stat">
          <span class="sr-stat-value">${readingTimeStr}</span>
          <span class="sr-stat-label">reading time${showTotal ? `<br><span style="font-size:9px;color:#bbb">${totalTimeStr} total</span>` : ''}</span>
        </div>
        <div class="sr-stat">
          <span class="sr-stat-value">${actualWPM.toLocaleString()}</span>
          <span class="sr-stat-label">words / min</span>
        </div>
      </div>
      <div class="sr-card-comparison">
        <div class="sr-comparison-bar-wrap">
          <div class="sr-comparison-label">You</div>
          <div class="sr-comparison-bar sr-bar-you" style="width:${Math.min(100, Math.round((actualWPM / Math.max(actualWPM, AVERAGE_WPM)) * 100))}%"></div>
          <div class="sr-comparison-wpm">${actualWPM} wpm</div>
        </div>
        <div class="sr-comparison-bar-wrap">
          <div class="sr-comparison-label">Avg</div>
          <div class="sr-comparison-bar sr-bar-avg" style="width:${Math.min(100, Math.round((AVERAGE_WPM / Math.max(actualWPM, AVERAGE_WPM)) * 100))}%"></div>
          <div class="sr-comparison-wpm">${AVERAGE_WPM} wpm</div>
        </div>
        <div class="sr-card-footer-text">${fasterStr} · ${savedLabel}</div>
      </div>
    `;

    document.body.appendChild(card);

    // Animate in
    requestAnimationFrame(() => card.classList.add('sr-card-visible'));

    // Close button
    card.querySelector('.sr-card-close').addEventListener('click', () => {
      card.classList.remove('sr-card-visible');
      setTimeout(() => card.remove(), 300);
    });

    // Auto-dismiss after 12 seconds
    setTimeout(() => {
      if (!card.isConnected) return;
      card.classList.remove('sr-card-visible');
      setTimeout(() => card.remove(), 300);
    }, 12000);
  }

  showNoContentToast(message) {
    const toast = document.createElement('div');
    toast.id = 'sr-no-content-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('sr-visible'));
    setTimeout(() => {
      toast.classList.remove('sr-visible');
      setTimeout(() => toast.remove(), 400);
    }, 3500);
  }

  // ---------------------------------------------------------------------------
  // Settings update
  // ---------------------------------------------------------------------------

  applySettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this._applyColor();
    if (this._currentWords.length > 0) {
      this._renderRect(this._currentWords);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  _applyColor() {
    if (!this._rectEl) return;
    this._rectEl.style.backgroundColor = this.settings.highlightColor;
    this._rectEl.style.opacity = this.settings.highlightOpacity;
  }

  /**
   * Position the highlight rect to cover the union bounding box of all words.
   * Rects are computed fresh each call (no caching) to handle layout shifts.
   */
  _renderRect(words) {
    const rects = [];
    for (const word of words) {
      try {
        const range = document.createRange();
        range.setStart(word.textNode, word.charOffset);
        range.setEnd(word.textNode, word.charOffset + word.charLength);
        const r = range.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) rects.push(r);
      } catch (_) {
        // Text node removed from DOM; skip
      }
    }

    if (rects.length === 0) return;

    const PAD = 3;
    const top    = Math.min(...rects.map(r => r.top))    - PAD;
    const bottom = Math.max(...rects.map(r => r.bottom)) + PAD;
    const left   = Math.min(...rects.map(r => r.left))   - PAD;
    const right  = Math.max(...rects.map(r => r.right))  + PAD;

    // Use fixed positioning (viewport-relative) so it tracks with scroll automatically
    Object.assign(this._rectEl.style, {
      top:    `${top}px`,
      left:   `${left}px`,
      width:  `${right - left}px`,
      height: `${bottom - top}px`
    });
  }

  /**
   * Detect whether the page is in dark mode based on content block background.
   * @param {Element} contentEl
   * @returns {boolean}
   */
  static detectDarkMode(contentEl) {
    const bg = window.getComputedStyle(contentEl).backgroundColor;
    const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) {
      // No background — check body/html
      const bodyBg = window.getComputedStyle(document.body).backgroundColor;
      const bm = bodyBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!bm) return false;
      const [, r, g, b] = bm.map(Number);
      // Relative luminance
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return lum < 128;
    }
    const [, r, g, b] = match.map(Number);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum < 128;
  }
}
