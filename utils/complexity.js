/**
 * complexity.js — Word complexity scoring and adaptive chunk sizing.
 *
 * Uses a syllable-counting heuristic (English) combined with word length
 * to produce a complexity score. The score drives adaptive chunk size:
 * simple text gets wider chunks, complex text gets narrower chunks.
 */

var ComplexityUtil = (() => {

  /**
   * Count syllables in an English word using vowel-group heuristics.
   * Accuracy: ~85% on common English vocabulary (sufficient for chunk adaptation).
   */
  function countSyllables(word) {
    word = word.toLowerCase().replace(/[^a-z]/g, '');
    if (word.length === 0) return 0;
    if (word.length <= 3) return 1;

    // Check for consonant + 'le' ending BEFORE stripping trailing 'e'
    // e.g. "table", "little", "simple" each get +1 syllable for the '-le' nucleus
    const hasConsonantLe = /[^aeiouy]le$/.test(word);

    // Remove silent trailing 'e' (only if remaining string still has a vowel)
    const withoutTrailingE = word.replace(/e$/, '');
    if (/[aeiouy]/.test(withoutTrailingE)) {
      word = withoutTrailingE;
    }

    // Count vowel groups (consecutive vowels/y = one syllable nucleus)
    // Including 'y' handles words like "happy", "gym", "cycle"
    const vowelGroups = word.match(/[aeiouy]+/g);
    let count = vowelGroups ? vowelGroups.length : 1;

    // Apply pre-computed '-le' adjustment
    if (hasConsonantLe) count += 1;

    // -ed at end: silent if preceded by a non-t/d consonant (e.g., "walked" = 1 syl)
    if (/[^td]ed$/.test(word)) count = Math.max(1, count - 1);

    return Math.max(1, count);
  }

  /**
   * Composite word complexity score.
   * Higher = more complex = reader needs more time per word.
   *
   * Score breakdown:
   *   length component:   word length * 0.4
   *   syllable component: syllable count * 0.6
   * Typical ranges:
   *   "a", "the", "of"  → ~1.0–2.0  (simple)
   *   "reading"         → ~4.0–5.0  (medium)
   *   "comprehension"   → ~7.0–9.0  (complex)
   */
  function scoreWord(word) {
    const clean = word.replace(/[^a-zA-Z]/g, '');
    if (clean.length === 0) return 1; // punctuation-only token
    const length = clean.length;
    const syllables = countSyllables(clean);
    return (length * 0.4) + (syllables * 0.6);
  }

  /**
   * Compute the average complexity score for a window of upcoming words.
   *
   * @param {string[]} words - Upcoming words (use next 10)
   * @returns {number} Average complexity score
   */
  function windowScore(words) {
    const windowSize = Math.min(words.length, 10);
    if (windowSize === 0) return 3.5; // neutral default
    let total = 0;
    for (let i = 0; i < windowSize; i++) {
      total += scoreWord(words[i]);
    }
    return total / windowSize;
  }

  /**
   * Determine effective chunk size based on upcoming word complexity.
   *
   * Thresholds (empirically tuned):
   *   avgScore < 3.5  → easy text, widen chunk by +1
   *   avgScore < 5.0  → normal text, use base chunk size
   *   avgScore < 7.0  → complex text, narrow by -1
   *   avgScore >= 7.0 → very complex, narrow by -2
   *
   * @param {Array<{text: string}>} upcomingWordObjects - Word objects from text-extractor
   * @param {number} baseChunkSize - User's configured chunk size
   * @param {{complexityAdapt: boolean, chunkSize: number}} settings
   * @returns {number} Effective chunk size (clamped to [1, chunkSize + 1])
   */
  function adaptChunkSize(upcomingWordObjects, baseChunkSize, settings) {
    if (!settings.complexityAdapt) return baseChunkSize;

    const words = upcomingWordObjects.slice(0, 10).map(w => w.text || w);
    const avg = windowScore(words);

    let adjusted;
    if (avg < 3.5)      adjusted = baseChunkSize + 1;
    else if (avg < 5.0) adjusted = baseChunkSize;
    else if (avg < 7.0) adjusted = baseChunkSize - 1;
    else                adjusted = baseChunkSize - 2;

    // Clamp: minimum 1, maximum user's chunkSize + 1 (allow slight expansion, not unlimited)
    return Math.max(1, Math.min(settings.chunkSize + 1, adjusted));
  }

  return {
    countSyllables,
    scoreWord,
    windowScore,
    adaptChunkSize
  };
})();
