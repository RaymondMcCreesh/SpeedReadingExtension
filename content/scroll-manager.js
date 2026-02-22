/**
 * scroll-manager.js — Viewport scroll strategy.
 *
 * Decides when and how to scroll the page to keep the reading position
 * visible, based on the user's scrollMode setting:
 *
 *   'eye-only'   — Never auto-scroll. Eye jumps down lines; only scrolls
 *                  if the next line is outside the viewport margin.
 *   'auto-scroll'— Scroll after every line to keep highlight centered.
 *   'mixed'      — Eye jumps for N lines (eyeJumpLines), then auto-scrolls.
 *                  Trains the eye to jump down while preventing the reader
 *                  from reaching the bottom of the visible area.
 *
 * IMPORTANT — scroll behaviour: all scrolls use behavior:'instant'.
 *
 * smooth scrolling is intentionally avoided because getBoundingClientRect()
 * returns viewport-relative coords that shift every frame during a smooth
 * scroll. If the engine renders the next highlight chunk while a smooth scroll
 * is still animating, the highlight lands at the mid-scroll viewport position
 * and then visually jumps when the scroll finishes. Instant scroll means
 * scrollY settles synchronously before the next _renderRect call, so the
 * highlight is always positioned correctly on the first try.
 */
class ScrollManager {
  constructor(settings) {
    this.settings = settings;

    // Where to place the reading line within the viewport (0=top, 1=bottom).
    // 0.38 keeps the active line in the upper-middle — comfortable for reading.
    this.VIEWPORT_TARGET_RATIO = 0.38;

    // Margin in px: trigger a safety scroll if the next line is this close
    // to the viewport edge (prevents reading off-screen).
    this.VIEWPORT_MARGIN_PX = 80;

    // Callback invoked after every scroll so the engine can re-render the
    // highlight at the new (post-scroll) viewport coordinates.
    this.onAfterScroll = null;
  }

  applySettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }

  /**
   * Called by EyeMovementEngine after advancing to a new line.
   * Returns true if a scroll was performed (engine should re-render highlight).
   *
   * @param {number} lineIndex        - 0-based index of the new current line
   * @param {number} totalEyeJumps    - Total lines traversed since last scroll
   * @param {Array<WordMeta>} lineWords - Words in the new current line
   * @returns {boolean} whether a scroll occurred
   */
  onLineAdvance(lineIndex, totalEyeJumps, lineWords) {
    const mode = this.settings.scrollMode;

    if (mode === 'eye-only') {
      return this._ensureLineVisible(lineWords);
    }

    if (mode === 'auto-scroll') {
      return this._scrollToLine(lineWords);
    }

    if (mode === 'page-turn') {
      // Page-turn is handled directly by the engine via needsPageTurn().
      // Here we only do a safety scroll if the line has drifted out of view.
      return this._ensureLineVisible(lineWords);
    }

    // 'mixed': scroll every N eye-jump lines
    if (totalEyeJumps > 0 && totalEyeJumps % this.settings.eyeJumpLines === 0) {
      return this._scrollToLine(lineWords);
    } else {
      return this._ensureLineVisible(lineWords);
    }
  }

  /**
   * Page-turn mode: returns true if the next line is below the viewport
   * bottom margin, meaning a page-turn scroll should be triggered.
   *
   * @param {Array<WordMeta>} lineWords
   * @returns {boolean}
   */
  needsPageTurn(lineWords) {
    const rect = this._getFirstWordRect(lineWords);
    if (!rect) return false;
    return rect.top > window.innerHeight - this.VIEWPORT_MARGIN_PX;
  }

  /**
   * Execute a page-turn: scroll instantly so the current bottom line of text
   * becomes the top line of the viewport. Returns the new scrollY.
   *
   * @param {Array<WordMeta>} lineWords - The line that was at the bottom
   */
  executePageTurn(lineWords) {
    const rect = this._getFirstWordRect(lineWords);
    if (!rect) return;

    // Place the new line just below any sticky/fixed header, plus a small gap
    const TOP_MARGIN_PX = 20 + this._getStickyHeaderHeight();
    const target = window.scrollY + rect.top - TOP_MARGIN_PX;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const clamped = Math.max(0, Math.min(maxScroll, target));

    window.scrollTo({ top: clamped, behavior: 'instant' });
    if (this.onAfterScroll) this.onAfterScroll();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Scroll instantly so the given line sits at VIEWPORT_TARGET_RATIO,
   * offset below any sticky/fixed header so the line is never obscured.
   * Returns true if the scroll position actually changed.
   */
  _scrollToLine(lineWords) {
    const rect = this._getFirstWordRect(lineWords);
    if (!rect) return false;

    const headerHeight = this._getStickyHeaderHeight();
    const usableHeight = window.innerHeight - headerHeight;
    const target = window.scrollY + rect.top - headerHeight - (usableHeight * this.VIEWPORT_TARGET_RATIO);
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const clamped = Math.max(0, Math.min(maxScroll, target));

    // Only scroll if the difference is meaningful (> 2px) to avoid no-op redraws
    if (Math.abs(clamped - window.scrollY) < 2) return false;

    // Instant scroll: scrollY settles synchronously so the very next
    // getBoundingClientRect() call returns correct post-scroll coordinates.
    window.scrollTo({ top: clamped, behavior: 'instant' });

    if (this.onAfterScroll) this.onAfterScroll();
    return true;
  }

  /**
   * Only scroll if the line is within VIEWPORT_MARGIN_PX of the viewport edge,
   * or hidden behind a sticky/fixed header at the top.
   * Returns true if a scroll occurred.
   */
  _ensureLineVisible(lineWords) {
    const rect = this._getFirstWordRect(lineWords);
    if (!rect) return false;

    const safeTop    = this.VIEWPORT_MARGIN_PX + this._getStickyHeaderHeight();
    const nearTop    = rect.top < safeTop;
    const nearBottom = rect.bottom > window.innerHeight - this.VIEWPORT_MARGIN_PX;

    if (nearTop || nearBottom) {
      return this._scrollToLine(lineWords);
    }
    return false;
  }

  /**
   * Measure the height of any fixed or sticky elements anchored to the top of
   * the viewport (e.g. site navigation bars, cookie banners).
   * Returns 0 if none found. Result is not cached — call site decides frequency.
   */
  _getStickyHeaderHeight() {
    let maxHeight = 0;
    const candidates = document.querySelectorAll(
      'header, nav, [role="banner"], [role="navigation"]'
    );
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      // Only count elements that are genuinely at the top of the viewport
      if (rect.top <= 10 && rect.height > 0) {
        maxHeight = Math.max(maxHeight, rect.bottom);
      }
    }
    return maxHeight;
  }

  _getFirstWordRect(lineWords) {
    if (!lineWords || lineWords.length === 0) return null;
    const word = lineWords[0];
    try {
      const range = document.createRange();
      range.setStart(word.textNode, word.charOffset);
      range.setEnd(word.textNode, word.charOffset + word.charLength);
      return range.getBoundingClientRect();
    } catch (_) {
      return null;
    }
  }
}
