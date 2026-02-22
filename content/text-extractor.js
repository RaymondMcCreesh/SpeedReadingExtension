/**
 * text-extractor.js — Heuristic body-text detection.
 *
 * Identifies the single dominant content block on the page using a scoring
 * pipeline (semantic tags, area, font size, text density, link ratio, etc.)
 * then extracts an ordered word list with DOM position metadata for the
 * highlighter and eye-movement engine.
 */

class TextExtractor {
  constructor() {
    // Tags whose entire subtrees are excluded from word extraction
    this.EXCLUDED_TAGS = new Set([
      'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
      'nav', 'header', 'footer', 'aside', 'form', 'button',
      'select', 'input', 'textarea', 'pre', 'code',
      'figure', 'figcaption', 'table'
    ]);

    // Semantic selectors checked in priority order
    this.SEMANTIC_SELECTORS = [
      'article',
      '[role="article"]',
      'main',
      '[role="main"]',
      '.post-content',
      '.article-body',
      '.article-content',
      '.entry-content',
      '.post-body',
      '.story-body',
      '.story-content',
      '.content-body',
      '#article-body',
      '#post-content',
      '#main-content',
      '#content'
    ];

    this.MIN_FONT_SIZE_PX = 13;
    this.MIN_AREA_PX2 = 30000;     // ~175×175 px
    this.MIN_WORD_COUNT = 80;
    this.MIN_SCORE = 40;            // Reject candidates below this score
    this.LINE_TOLERANCE_PX = 5;    // Vertical grouping tolerance for line detection
  }

  /**
   * Main entry point.
   * @returns {Array<WordMeta>|null} Ordered word list, or null if no content found.
   *   WordMeta: { text, textNode, charOffset, charLength }
   */
  extract() {
    const candidates = this._collectCandidates();
    if (candidates.length === 0) return null;

    const scored = candidates
      .map(el => ({ element: el, score: this._scoreElement(el) }))
      .filter(c => c.score >= this.MIN_SCORE)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    // Deduplication: if top candidate is ancestor of second, prefer the more specific child
    // if the child's score is at least 70% of the parent's
    let best = scored[0];
    if (scored.length > 1) {
      const second = scored[1];
      if (best.element.contains(second.element) && second.score >= best.score * 0.70) {
        best = second;
      }
    }

    return this._buildWordList(best.element);
  }

  // ---------------------------------------------------------------------------
  // Private — candidate collection
  // ---------------------------------------------------------------------------

  _collectCandidates() {
    const seen = new Set();
    const candidates = [];

    const add = (el) => {
      if (!el || seen.has(el)) return;
      if (!this._isVisible(el)) return;
      seen.add(el);
      candidates.push(el);
    };

    // Priority 1: known semantic selectors
    for (const sel of this.SEMANTIC_SELECTORS) {
      try {
        document.querySelectorAll(sel).forEach(add);
      } catch (_) { /* invalid selector in edge cases */ }
    }

    // Priority 2: divs / sections with enough area and words
    document.querySelectorAll('div, section, [class*="content"], [class*="article"], [class*="post"], [class*="story"]').forEach(el => {
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area >= this.MIN_AREA_PX2) add(el);
    });

    // Filter: must have minimum word count
    return candidates.filter(el => {
      const wc = (el.textContent || '').trim().split(/\s+/).length;
      return wc >= this.MIN_WORD_COUNT;
    });
  }

  _isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    // Allow elements slightly above viewport (user may have scrolled)
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private — scoring
  // ---------------------------------------------------------------------------

  _scoreElement(el) {
    let score = 0;
    const rect = el.getBoundingClientRect();
    const computed = window.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const text = el.textContent || '';
    const htmlLen = el.innerHTML.length;

    // --- Semantic tag bonus ---
    const tagBonus = { article: 40, main: 35, section: 15, div: 5, span: 0 };
    score += tagBonus[tag] || 0;

    // --- Role / id / class bonuses ---
    const role = el.getAttribute('role') || '';
    if (role === 'main' || role === 'article') score += 30;

    const idClass = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
    if (/\b(content|article|post|story|body|text|entry|main)\b/.test(idClass)) score += 18;

    // --- Area ---
    const area = rect.width * rect.height;
    if (area >= this.MIN_AREA_PX2) score += Math.min(25, area / 12000);

    // --- Font size ---
    const fontSize = parseFloat(computed.fontSize) || 0;
    if (fontSize >= this.MIN_FONT_SIZE_PX) score += 10;
    if (fontSize >= 16) score += 5;

    // --- Text density (textContent / innerHTML ratio) ---
    const density = htmlLen > 0 ? text.length / htmlLen : 0;
    score += Math.min(20, density * 25);

    // --- Word count ---
    const wordCount = text.trim().split(/\s+/).length;
    score += Math.min(30, wordCount / 25);

    // --- Paragraph density ---
    const paraCount = el.querySelectorAll('p').length;
    score += Math.min(20, paraCount * 2.5);

    // --- Link density penalty ---
    const links = el.querySelectorAll('a');
    const linkTextLen = Array.from(links).reduce((s, a) => s + (a.textContent || '').length, 0);
    const linkRatio = text.length > 0 ? linkTextLen / text.length : 0;
    if (linkRatio > 0.5) score -= 30;
    else if (linkRatio > 0.3) score -= 10;

    // --- Position penalties ---
    const position = computed.position;
    if (position === 'fixed' || position === 'sticky') score -= 60;
    if (position === 'absolute') score -= 20;

    // --- z-index penalty (overlays, modals) ---
    const zIndex = parseInt(computed.zIndex, 10);
    if (!isNaN(zIndex) && zIndex > 100) score -= 20;

    // --- Tag / class / id penalties ---
    if (tag === 'aside') score -= 35;
    if (tag === 'nav' || tag === 'header' || tag === 'footer') score -= 60;
    if (/\b(sidebar|nav|menu|ad|banner|promo|footer|header|widget|related|comment|toc|breadcrumb)\b/.test(idClass)) score -= 45;

    return score;
  }

  // ---------------------------------------------------------------------------
  // Private — word list construction
  // ---------------------------------------------------------------------------

  /**
   * Walk the DOM tree of the content block, collecting text nodes.
   * Returns an array of WordMeta objects (no cached rects — computed lazily).
   *
   * @param {Element} rootElement
   * @returns {Array<WordMeta>}
   */
  _buildWordList(rootElement) {
    const words = [];

    // Detect RTL direction on the content block
    const dir = window.getComputedStyle(rootElement).direction;
    const isRTL = dir === 'rtl' || rootElement.getAttribute('dir') === 'rtl';

    const walker = document.createTreeWalker(
      rootElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // Skip if inside an excluded tag subtree
          let ancestor = node.parentElement;
          while (ancestor && ancestor !== rootElement) {
            if (this.EXCLUDED_TAGS.has(ancestor.tagName.toLowerCase())) {
              return NodeFilter.FILTER_REJECT;
            }
            ancestor = ancestor.parentElement;
          }
          // Skip whitespace-only nodes
          if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      // Match all non-whitespace tokens (words, punctuation attached to words)
      const matches = [...text.matchAll(/\S+/g)];
      for (const match of matches) {
        // Skip pure reference numbers like [1], [23] (Wikipedia footnotes)
        if (/^\[\d+\]$/.test(match[0])) continue;
        words.push({
          text: match[0],
          textNode: node,
          charOffset: match.index,
          charLength: match[0].length,
          isRTL
        });
      }
    }

    return words;
  }
}

/**
 * Group a flat word list into visual lines based on getBoundingClientRect().
 * Words within LINE_TOLERANCE_PX vertical range share a line.
 *
 * IMPORTANT: Call this after document.fonts.ready to avoid fallback-font metrics.
 *
 * @param {Array<WordMeta>} wordList
 * @param {number} [tolerance=5] Vertical px tolerance for grouping
 * @returns {Array<Array<WordMeta>>} Lines of words
 */
function groupWordsIntoLines(wordList, tolerance = 5) {
  if (!wordList || wordList.length === 0) return [];

  // Compute rect for each word lazily using a Range
  const getRect = (word) => {
    const range = document.createRange();
    range.setStart(word.textNode, word.charOffset);
    range.setEnd(word.textNode, word.charOffset + word.charLength);
    return range.getBoundingClientRect();
  };

  const lines = [];
  let currentLine = [];
  let currentLineTop = null;

  for (const word of wordList) {
    let rect;
    try {
      rect = getRect(word);
    } catch (_) {
      continue; // Text node may have been removed from DOM
    }

    // Skip zero-size rects (hidden elements that slipped through)
    if (rect.width === 0 && rect.height === 0) continue;

    const top = window.scrollY + rect.top; // absolute page position

    if (currentLineTop === null || Math.abs(rect.top - (currentLineTop - window.scrollY)) <= tolerance) {
      currentLine.push(word);
      if (currentLineTop === null) currentLineTop = top;
    } else {
      if (currentLine.length > 0) {
        // Sort by left position within line (important for RTL and multi-column)
        currentLine.sort((a, b) => {
          const ra = getRect(a);
          const rb = getRect(b);
          return a.isRTL ? rb.left - ra.left : ra.left - rb.left;
        });
        lines.push([...currentLine]);
      }
      currentLine = [word];
      currentLineTop = top;
    }
  }

  if (currentLine.length > 0) {
    currentLine.sort((a, b) => {
      const ra = getRect(a);
      const rb = getRect(b);
      return a.isRTL ? rb.left - ra.left : ra.left - rb.left;
    });
    lines.push(currentLine);
  }

  return lines;
}
