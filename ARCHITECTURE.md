# Architecture

This is a Manifest V3 Chrome extension. It has no build step — all files are plain JavaScript loaded directly by the browser.

---

## Directory layout

```
speedReading/
├── manifest.json            Extension entry point (MV3)
├── background/
│   └── service-worker.js    MV3 background worker
├── content/
│   ├── content.js           Session orchestrator (injected into every page)
│   ├── text-extractor.js    DOM → word list
│   ├── highlighter.js       Overlay renderer
│   ├── scroll-manager.js    Viewport scroll strategy
│   └── eye-movement.js      Timing engine + state machine
├── popup/
│   ├── popup.html/css/js    Extension toolbar popup
├── options/
│   ├── options.html/css/js  Full settings page
├── utils/
│   ├── storage.js           chrome.storage wrapper + defaults
│   └── complexity.js        Word complexity scoring
├── styles/
│   └── overlay.css          Highlight rect + progress bar + badges
├── icons/
│   └── icon{16,48,128}.png
└── tests/
    ├── index.html           In-browser test runner
    └── fixtures/            Sample HTML pages for manual testing
```

---

## Data flow

```
User action (Alt+R / popup button)
        │
        ▼
service-worker.js  ──sendMessage──►  content.js
                                          │
                              ┌───────────┴───────────┐
                              │                       │
                        TextExtractor          (settings from
                              │                 storage.js)
                              ▼
                        word list  ──groupWordsIntoLines()──►  line array
                              │
                              ▼
                      EyeMovementEngine
                       ├── ScrollManager  (decides when/how to scroll)
                       ├── Highlighter    (renders the rect on screen)
                       └── ComplexityUtil (adapts chunk size per word)
```

---

## Component responsibilities

### `content.js` — Session orchestrator

The single content script injected into every page. It:

- Creates and owns `TextExtractor`, `Highlighter`, `ScrollManager`, and `EyeMovementEngine`
- Listens for messages from the service worker (`TOGGLE_READING`, `STOP_READING`, `UPDATE_SETTINGS`, `GET_STATUS`)
- Saves and restores reading position via `StorageUtil`
- Waits for `document.fonts.ready` before calling `groupWordsIntoLines()` to avoid fallback-font layout errors

Only one session runs at a time. Starting while one is active stops the previous session first.

### `text-extractor.js` — DOM → word list

**`TextExtractor.extract()`** identifies the main content block and returns a flat `WordMeta[]`.

Content detection is a scoring pipeline:

1. Collect candidates: semantic selectors first (`article`, `main`, `[role=article]`, common class names), then any large `div`/`section`
2. Filter by minimum word count (80 words)
3. Score each candidate on: tag type, ARIA role, id/class names, area, font size, text density (text/HTML ratio), paragraph count, link density, positioning, z-index
4. Take the highest scorer; if the top candidate contains the second and the second scores ≥ 70%, prefer the more specific child

**`groupWordsIntoLines(wordList)`** groups the flat word list into visual lines by comparing `getBoundingClientRect().top` values, using a 5 px tolerance. This produces the `line[][]` structure the engine iterates over.

`WordMeta` shape:
```js
{
  text: string,        // raw token
  textNode: Text,      // DOM text node
  charOffset: number,  // start index within textNode.textContent
  charLength: number,  // token length
  isRTL: boolean       // direction detected from content block
}
```

### `eye-movement.js` — Timing engine

`EyeMovementEngine` is a state machine:

```
idle → reading → line-pause → return-sweep → reading  (normal loop)
reading → paused → reading
reading/paused → idle  (stop)
reading → done
```

**Timing** uses `requestAnimationFrame` + `performance.now()` with additive scheduling (`nextChunkTime += msPerChunk`). This prevents drift — the engine never resets the clock to `now()` mid-session. A 500 ms burst guard resets the clock after tab suspension to prevent word avalanches on resume.

**Per-chunk sequence:**
1. Compute adaptive chunk size via `ComplexityUtil`
2. Slice `chunkSize` words from the current line
3. Call `highlighter.highlight(chunk)` and `highlighter.updateProgress()`
4. Advance word index; schedule next chunk

**Line-end sequence:**
1. Display final chunk for its full duration, then enter `line-pause` state
2. After `lineEndPause` ms, enter `return-sweep` state and call `highlighter.applyReturnSweepAnimation()`
3. Call `scrollManager.onLineAdvance()` — may trigger a scroll
4. If mixed mode and a scroll occurred, call `highlighter.flashWords()` to anchor the eye
5. Reset clock and resume reading

**Page-turn sequence** (page-turn scroll mode only):
1. `scrollManager.executePageTurn()` — instant hard scroll to top of viewport
2. `highlighter.flashWords()` — 3 flashes to help eye reacquire position
3. Resume reading

**Session timing** tracks pure reading time by subtracting manual pauses (`_totalPausedMs`) and line-break dead time (`_totalLineBreakMs`) from wall-clock elapsed. This is what the completion card reports as WPM.

### `scroll-manager.js` — Scroll strategy

Called by the engine after each line advance. Returns `true` if a scroll was performed (engine uses this to trigger a post-scroll highlight re-render).

| Mode | Behaviour |
|------|-----------|
| `eye-only` | `_ensureLineVisible()` only — scrolls if the line is within 80 px of viewport edge |
| `auto-scroll` | `_scrollToLine()` every line — keeps reading line at 38% from top |
| `mixed` | `_scrollToLine()` every N lines; `_ensureLineVisible()` otherwise |
| `page-turn` | Safety `_ensureLineVisible()` only; hard scroll handled by the engine |

All scrolls use `behavior: 'instant'`. Smooth scrolling is intentionally avoided: `getBoundingClientRect()` returns viewport-relative coordinates that shift every frame during animation. Instant scroll means `scrollY` settles synchronously before the next `_renderRect()` call.

### `highlighter.js` — Overlay renderer

Appends three fixed-position elements to `<body>`:

- `#sr-highlight-overlay` → `div.sr-highlight-rect` — the moving highlight rectangle
- `#sr-progress-bar` — thin bar at top of viewport
- `#sr-status-badge` — toast for Paused / error messages

The rect is positioned with `position: fixed` (viewport-relative), computed fresh each render from `Range.getBoundingClientRect()` — never cached — so layout shifts (lazy images, responsive reflow) are handled automatically.

A `ResizeObserver` on `document.body` (debounced 100 ms) repositions the rect on layout changes.

`pointer-events: none` on all extension elements ensures clicks pass through to the page.

Key methods:
- `highlight(words)` — renders rect over the union bounding box of the chunk
- `applyReturnSweepAnimation(currentLine, nextLine, duration)` — instantly repositions rect to line start, then dims via CSS class for `duration` ms
- `flashWords(words, count, intervalMs)` — pulses rect on/off N times to anchor eye after a scroll
- `showCompletionCard(stats)` — fixed card in bottom-right with WPM, words read, time, comparison to 238 wpm average

### `complexity.js` — Adaptive chunk sizing

Scores each word by `(length × 0.4) + (syllables × 0.6)` where syllables are counted with an English vowel-group heuristic (~85% accuracy). A 10-word look-ahead window is averaged to decide whether to widen or narrow the current chunk:

| Avg score | Adjustment |
|-----------|-----------|
| < 3.5 | +1 (easy text) |
| 3.5 – 5.0 | 0 (normal) |
| 5.0 – 7.0 | −1 (complex) |
| ≥ 7.0 | −2 (very complex) |

Result is clamped to `[1, chunkSize + 1]`.

### `storage.js` — Settings persistence

Thin wrapper around `chrome.storage.sync`. Provides:
- `getSettings()` — reads all keys with defaults applied
- `saveSettings(partial)` — writes a partial update
- `onSettingsChanged(callback)` — subscribes to live changes (used by the options page to broadcast to active sessions)
- URL position LRU cache — stores the last `globalWordIndex` per URL hash, capped at 20 entries, using `chrome.storage.sync` (falls back to `chrome.storage.local` on Firefox < 132)

### `service-worker.js` — Background worker

Minimal MV3 service worker. Does not hold per-tab state (service workers can be terminated at any time):

- On install: writes default settings if not already present
- Relays keyboard commands (`Alt+R` → `TOGGLE_READING`, `Alt+S` → `STOP_READING`) to the active tab's content script
- Routes `POPUP_TO_CONTENT` messages (popup cannot message content scripts directly in MV3)

---

## Message protocol

All messages are plain objects `{ type: string, ...payload }`.

| Type | Direction | Payload |
|------|-----------|---------|
| `TOGGLE_READING` | SW → content | — |
| `STOP_READING` | SW → content | — |
| `GET_STATUS` | popup → SW → content | — |
| `UPDATE_SETTINGS` | popup/options → content | `{ settings: {...} }` |
| `POPUP_TO_CONTENT` | popup → SW → content | `{ payload: { type, ... } }` |
| `READING_COMPLETE` | content → SW | `{ stats: { wordsRead, elapsedMs, actualWPM } }` |

---

## Design constraints and decisions

**No DOM mutation.** Text nodes are never modified. The highlight is a separate overlay. This means the extension works on any page regardless of content security policy or framework.

**No Shadow DOM for the overlay.** The overlay is appended directly to `<body>`. Shadow DOM would isolate styles cleanly but makes accessing `getBoundingClientRect()` relative to the host element more complex. Direct append is simpler and the CSS is scoped by `sr-` prefixes.

**Instant scroll only.** Smooth scroll breaks `getBoundingClientRect()` mid-animation. Instant scroll is synchronous, so highlight position is always correct on first render.

**No caching of word rects.** Layout shifts (images loading, responsive breakpoints) would silently corrupt a rect cache. Fresh computation per render is slightly more expensive but always correct.

**Content script loaded at `document_idle`.** This ensures the DOM is ready before extraction runs. The `document.fonts.ready` wait in `content.js` further ensures line grouping uses final font metrics rather than fallback-font metrics that would give wrong `top` values.
