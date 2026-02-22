/**
 * eye-movement.js — Drift-free rAF timing engine with saccade sequencing.
 *
 * State machine:
 *   idle → reading → line-pause → return-sweep → reading (loops)
 *   reading → paused → reading
 *   reading/paused → idle (stop)
 *   reading → done
 *
 * Timing:
 *   Uses requestAnimationFrame + performance.now() for drift-free scheduling.
 *   nextChunkTime += msPerChunk (additive, not reset to now()) prevents
 *   cumulative drift. A burst guard resets the clock after > 500ms gap
 *   (tab suspend, visibilitychange) to prevent word avalanches.
 */
class EyeMovementEngine {
  /**
   * @param {Array<Array<WordMeta>>} wordLines - From groupWordsIntoLines()
   * @param {object} settings                  - From StorageUtil.getSettings()
   * @param {Highlighter} highlighter
   * @param {ScrollManager} scrollManager
   */
  constructor(wordLines, settings, highlighter, scrollManager) {
    this.wordLines     = wordLines;
    this.settings      = settings;
    this.highlighter   = highlighter;
    this.scrollManager = scrollManager;

    this.currentLineIndex = 0;
    this.currentWordIndex = 0;   // index within current line
    this.globalWordIndex  = 0;   // absolute index across all words
    this.totalWords       = wordLines.reduce((s, l) => s + l.length, 0);
    this._eyeJumpCount    = 0;   // lines traversed since last page scroll

    this._state             = 'idle'; // 'idle'|'reading'|'paused'|'line-pause'|'return-sweep'|'page-turn'|'done'
    this._rafId             = null;
    this._nextChunkTime     = 0;
    this._currentChunkWords = [];    // last rendered chunk — for post-scroll re-render

    // Session timing — tracks active reading time, excluding all non-reading gaps
    this._sessionStartTime  = 0;     // performance.now() when start() was called
    this._pausedAt          = 0;     // performance.now() when pause() was called
    this._totalPausedMs     = 0;     // cumulative ms spent in manual pause
    this._lineBreakStartAt  = 0;     // performance.now() when line-end pause began
    this._totalLineBreakMs  = 0;     // cumulative ms spent in line-end pauses + sweeps
    this._wordsReadAtStart  = 0;     // globalWordIndex at session start (for resume)

    this._onComplete    = null;   // optional callback: (stats) => {}

    this._boundVisibility = this._onVisibilityChange.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** @param {number} fromWordIndex - Global word index to start from (resume) */
  start(fromWordIndex = 0) {
    if (this._state === 'reading') return;
    this._seekToWord(fromWordIndex);
    this._state = 'reading';
    this._nextChunkTime    = performance.now();
    this._sessionStartTime = performance.now();
    this._pausedAt         = 0;
    this._totalPausedMs    = 0;
    this._lineBreakStartAt = 0;
    this._totalLineBreakMs = 0;
    this._wordsReadAtStart = fromWordIndex;
    document.addEventListener('visibilitychange', this._boundVisibility);
    this._scheduleNextChunk();
  }

  pause() {
    if (this._state !== 'reading') return;
    this._state   = 'paused';
    this._pausedAt = performance.now();
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this.highlighter.showBadge('⏸  Paused — Space or Alt+R to resume');
  }

  resume() {
    if (this._state !== 'paused') return;
    if (this._pausedAt > 0) {
      this._totalPausedMs += performance.now() - this._pausedAt;
      this._pausedAt = 0;
    }
    this._state = 'reading';
    this._nextChunkTime = performance.now(); // reset clock — no burst catchup
    this.highlighter.hideBadge();
    this._scheduleNextChunk();
  }

  stop() {
    this._state = 'idle';
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
    document.removeEventListener('visibilitychange', this._boundVisibility);
    this.highlighter.hide();
    this.highlighter.hideBadge();
  }

  /** Toggle between reading and paused. */
  toggle() {
    if (this._state === 'reading')      this.pause();
    else if (this._state === 'paused')  this.resume();
  }

  get state() { return this._state; }

  applySettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this.scrollManager.applySettings(newSettings);
    this.highlighter.applySettings(newSettings);
  }

  // ---------------------------------------------------------------------------
  // Timing loop
  // ---------------------------------------------------------------------------

  _scheduleNextChunk() {
    this._rafId = requestAnimationFrame((timestamp) => {
      if (this._state !== 'reading') return;

      // Burst guard: if more than 500ms behind schedule (tab was hidden/suspended),
      // reset the clock to avoid reading a burst of words instantly.
      if (timestamp - this._nextChunkTime > 500) {
        this._nextChunkTime = timestamp;
      }

      if (timestamp >= this._nextChunkTime) {
        this._advanceChunk();
      } else {
        this._scheduleNextChunk();
      }
    });
  }

  _advanceChunk() {
    const line = this.wordLines[this.currentLineIndex];
    if (!line) {
      this._onReadingComplete();
      return;
    }

    // Adaptive chunk size based on upcoming word complexity
    const upcomingWords = this._getUpcomingWords(10);
    const effectiveChunkSize = ComplexityUtil.adaptChunkSize(
      upcomingWords,
      this.settings.chunkSize,
      this.settings
    );

    const lineLen = line.length;
    const remaining = lineLen - this.currentWordIndex;

    if (remaining <= 0) {
      // Shouldn't happen, but guard against it
      this._onLineEnd();
      return;
    }

    // Take min(chunkSize, remaining words on this line)
    const takeCount = Math.min(effectiveChunkSize, remaining);
    const chunkWords = line.slice(this.currentWordIndex, this.currentWordIndex + takeCount);

    // Highlight — store ref so onAfterScroll can re-render if a scroll fires
    this._currentChunkWords = chunkWords;
    this.highlighter.highlight(chunkWords);
    this.highlighter.updateProgress(this.globalWordIndex, this.totalWords);

    // Advance position (overlap: re-read N words on next chunk)
    const overlap = Math.min(this.settings.chunkOverlap, takeCount - 1);
    const advance = takeCount - overlap;

    this.currentWordIndex += advance;
    this.globalWordIndex  += advance;

    // Compute how long to display this chunk at the configured WPM
    const msPerChunk = (takeCount / this.settings.wpm) * 60000;
    this._nextChunkTime += msPerChunk;

    // Check if we've consumed this line
    if (this.currentWordIndex >= lineLen) {
      // Display the final chunk for its full duration, then trigger line-end.
      // Use setTimeout so the chunk stays visible for msPerChunk before the
      // line-end pause begins — avoids double-counting display + pause time.
      const displayRemaining = Math.max(0, this._nextChunkTime - performance.now());
      setTimeout(() => {
        if (this._state === 'reading') this._onLineEnd();
      }, displayRemaining);
      return;
    }

    // Schedule next chunk (additive timing — no drift)
    this._scheduleNextChunk();
  }

  // ---------------------------------------------------------------------------
  // Line-end sequence
  // ---------------------------------------------------------------------------

  _onLineEnd() {
    this._state = 'line-pause';
    this._lineBreakStartAt = performance.now(); // start of non-reading dead time

    setTimeout(async () => {
      if (this._state !== 'line-pause') return; // was stopped externally

      this._state = 'return-sweep';
      const currentLine = this.wordLines[this.currentLineIndex];
      const nextLine    = this.wordLines[this.currentLineIndex + 1];

      await this.highlighter.applyReturnSweepAnimation(
        currentLine,
        nextLine,
        this.settings.returnSweepSpeed
      );

      this._advanceToNextLine();

    }, this.settings.lineEndPause);
  }

  async _advanceToNextLine() {
    // Close the line-break timer — everything from _onLineEnd() to here
    // (lineEndPause + returnSweepSpeed + page-turn flash) is non-reading time
    if (this._lineBreakStartAt > 0) {
      this._totalLineBreakMs += performance.now() - this._lineBreakStartAt;
      this._lineBreakStartAt = 0;
    }

    this.currentLineIndex++;
    this.currentWordIndex = 0;
    this._eyeJumpCount++;

    if (this.currentLineIndex >= this.wordLines.length) {
      this._onReadingComplete();
      return;
    }

    const nextLine = this.wordLines[this.currentLineIndex];

    // Wire up the post-scroll re-render callback.
    this.scrollManager.onAfterScroll = () => {
      if (this._currentChunkWords && this._currentChunkWords.length > 0) {
        this.highlighter.highlight(this._currentChunkWords);
      }
    };

    // Page-turn mode: if the next line is off the bottom of the viewport,
    // perform a hard page scroll then flash the start word before resuming.
    if (this.settings.scrollMode === 'page-turn' &&
        this.scrollManager.needsPageTurn(nextLine)) {
      this._doPageTurn(nextLine);
      return; // _doPageTurn resumes the engine when ready
    }

    const scrolled = this.scrollManager.onLineAdvance(
      this.currentLineIndex,
      this._eyeJumpCount,
      nextLine
    );

    // Mixed mode: after a scroll the viewport has jumped, so flash the first
    // word of the new line to give the eye an anchor and prevent disorientation.
    if (scrolled && this.settings.scrollMode === 'mixed') {
      const flashStart = performance.now();
      await this.highlighter.flashWords(nextLine.slice(0, 1), 2, 150);
      this._totalLineBreakMs += performance.now() - flashStart;
      if (this._state === 'idle' || this._state === 'done') return; // stopped during flash
    }

    this._state = 'reading';
    // Reset clock after the line-end pause + sweep so WPM stays accurate.
    this._nextChunkTime = performance.now();
    this._scheduleNextChunk();
  }

  // ---------------------------------------------------------------------------
  // Page-turn mode
  // ---------------------------------------------------------------------------

  /**
   * Execute a page-turn:
   *   1. Scroll instantly so the new line is at the top of the viewport
   *   2. Flash the first word of the line 3× so the reader reacquires position
   *   3. Resume reading
   *
   * @param {Array<WordMeta>} nextLine
   */
  async _doPageTurn(nextLine) {
    this._state = 'page-turn';

    // 1. Hard scroll — instant, so getBoundingClientRect() is correct immediately
    this.scrollManager.executePageTurn(nextLine);

    // 2. Flash the start word — track this as non-reading dead time
    const flashStart = performance.now();
    await this.highlighter.flashWords(nextLine.slice(0, 1), 3, 200);
    this._totalLineBreakMs += performance.now() - flashStart;

    // 3. Guard: might have been stopped during the flash
    if (this._state !== 'page-turn') return;

    this._state = 'reading';
    this._nextChunkTime = performance.now();
    this._scheduleNextChunk();
  }

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  _onReadingComplete() {
    this._state = 'done';
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
    document.removeEventListener('visibilitychange', this._boundVisibility);
    this.highlighter.hide();
    this.highlighter.updateProgress(this.totalWords, this.totalWords);

    // Compute session stats — exclude manual pauses AND line-end training pauses
    // so the reported WPM reflects actual reading throughput, not wall-clock time.
    const totalNonReadingMs = this._totalPausedMs + this._totalLineBreakMs;
    const elapsedMs         = performance.now() - this._sessionStartTime - totalNonReadingMs;
    const wordsRead         = this.globalWordIndex - this._wordsReadAtStart;
    const elapsedMinutes    = elapsedMs / 60000;
    const actualWPM         = elapsedMinutes > 0 ? Math.round(wordsRead / elapsedMinutes) : this.settings.wpm;

    // Total wall-clock time (what the reader experienced, including pauses)
    const totalElapsedMs    = Math.round(performance.now() - this._sessionStartTime - this._totalPausedMs);

    const stats = {
      wordsRead,
      elapsedMs:      Math.round(elapsedMs),   // pure reading time
      totalElapsedMs,                           // wall-clock reading session time
      actualWPM
    };

    if (this._onComplete) this._onComplete(stats);
    try {
      chrome.runtime.sendMessage({ type: 'READING_COMPLETE', stats });
    } catch (_) { /* popup may be closed */ }
  }

  // ---------------------------------------------------------------------------
  // Seek / resume
  // ---------------------------------------------------------------------------

  _seekToWord(globalIndex) {
    if (globalIndex <= 0) {
      this.currentLineIndex = 0;
      this.currentWordIndex = 0;
      this.globalWordIndex  = 0;
      this._eyeJumpCount    = 0;
      return;
    }
    let count = 0;
    for (let li = 0; li < this.wordLines.length; li++) {
      const line = this.wordLines[li];
      if (count + line.length > globalIndex) {
        this.currentLineIndex = li;
        this.currentWordIndex = globalIndex - count;
        this.globalWordIndex  = globalIndex;
        return;
      }
      count += line.length;
    }
    // globalIndex beyond end — start at last line
    this.currentLineIndex = this.wordLines.length - 1;
    this.currentWordIndex = 0;
    this.globalWordIndex  = count;
  }

  _getUpcomingWords(n) {
    const result = [];
    let li = this.currentLineIndex;
    let wi = this.currentWordIndex;
    while (result.length < n && li < this.wordLines.length) {
      const line = this.wordLines[li];
      while (wi < line.length && result.length < n) {
        result.push(line[wi]);
        wi++;
      }
      li++;
      wi = 0;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Tab visibility
  // ---------------------------------------------------------------------------

  _onVisibilityChange() {
    if (document.hidden) {
      // Tab hidden: don't pause the state machine, but the rAF will naturally
      // stop firing (browsers throttle to 1fps). Burst guard in _scheduleNextChunk
      // handles the clock reset when the tab becomes visible again.
    }
    // On becoming visible: next rAF call will reset nextChunkTime via burst guard
  }
}
