/*
 * Search logic for the sidebar. Pure functions, no DOM: loaded with a <script>
 * tag in the webview (as window.SubtitleSearch) and with require() in tests.
 *
 * Matching is case-insensitive and accent-insensitive: "cafe" finds "Café",
 * "coeur" finds "cœur". The query is first looked up as typed; if no line
 * contains it, lines containing all of its words in any order are returned.
 * Double quotes keep words together: "good morning" only matches that phrase.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SubtitleSearch = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Characters that Unicode decomposition does not reduce to a base letter,
  // plus typographic punctuation people type as plain ASCII.
  var SPECIAL = {
    "\u0153": "oe", "\u00e6": "ae", "\u00df": "ss", "\u00f8": "o", "\u0111": "d",
    "\u0142": "l", "\u00f0": "d", "\u00fe": "th", "\u0131": "i",
    "\u2018": "'", "\u2019": "'", "\u02bc": "'", "\u2032": "'", "`": "'", "\u00b4": "'",
    "\u201c": '"', "\u201d": '"', "\u00ab": '"', "\u00bb": '"', "\u201e": '"',
    "\u2013": "-", "\u2014": "-", "\u2010": "-", "\u2011": "-", "\u2212": "-",
    "\u2026": "...",
    "\u00a0": " ", "\u202f": " ", "\u2009": " ", "\u3000": " ",
  };
  var COMBINING_MARKS = /[\u0300-\u036f]/g;

  function foldChar(ch) {
    var lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SPECIAL, lower)) return SPECIAL[lower];
    if (lower.length === 1 && lower.charCodeAt(0) < 0x80) return lower;
    var base = lower.normalize("NFD").replace(COMBINING_MARKS, "");
    if (Object.prototype.hasOwnProperty.call(SPECIAL, base)) return SPECIAL[base];
    // Keep characters that are nothing but a combining mark out of the index.
    return base;
  }

  /**
   * Fold `text` for matching and remember where each folded character came from.
   * `from[k]` / `to[k]` are the offsets in `text` of the source character that
   * produced folded character k, so a match in the folded string can be mapped
   * back to a range of the original text.
   */
  function foldWithMap(text) {
    var norm = "";
    var from = [];
    var to = [];
    var i = 0;
    while (i < text.length) {
      var code = text.charCodeAt(i);
      var size = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? 2 : 1;
      var folded = foldChar(text.substr(i, size));
      for (var k = 0; k < folded.length; k++) {
        from.push(i);
        to.push(i + size);
      }
      norm += folded;
      i += size;
    }
    return { norm: norm, from: from, to: to };
  }

  /** Fold `text` for matching (lower case, no accents, plain punctuation). */
  function fold(text) {
    // Fast path: plain ASCII needs nothing but lower-casing.
    if (/^[\x00-\x5f\x61-\x7f]*$/.test(text)) return text.toLowerCase();
    return foldWithMap(text).norm;
  }

  /**
   * Split a query into folded terms. Double-quoted parts are kept as phrases;
   * everything else is split on whitespace.
   * @returns {string[]}
   */
  function parseQuery(query) {
    var terms = [];
    var folded = fold(query || "");
    var re = /"([^"]*)"?|(\S+)/g;
    var m;
    while ((m = re.exec(folded)) !== null) {
      var term = (m[1] !== undefined ? m[1] : m[2]).replace(/\s+/g, " ").trim();
      if (term && terms.indexOf(term) === -1) terms.push(term);
    }
    return terms;
  }

  function matches(norm, terms) {
    for (var i = 0; i < terms.length; i++) {
      if (norm.indexOf(terms[i]) === -1) return false;
    }
    return true;
  }

  /**
   * Indices of the entries of `norms` (pre-folded cue texts) matching `terms`.
   * @param {string[]} norms
   * @param {string[]} terms
   * @returns {number[]}
   */
  function search(norms, terms) {
    var result = [];
    if (!terms.length) return result;
    for (var i = 0; i < norms.length; i++) {
      if (matches(norms[i], terms)) result.push(i);
    }
    return result;
  }

  /**
   * Run a query against `norms` (pre-folded cue texts).
   * @returns {{terms: string[], rows: number[], anyOrder: boolean}} `terms` are
   *   what matched (for highlighting), `rows` the matching indices, and
   *   `anyOrder` is true when the words were found but not as typed.
   */
  function find(norms, query) {
    var folded = fold(query || "").replace(/\s+/g, " ").trim();
    var terms = parseQuery(folded);
    if (terms.length > 1 && folded.indexOf('"') === -1) {
      var exact = search(norms, [folded]);
      if (exact.length) return { terms: [folded], rows: exact, anyOrder: false };
      return { terms: terms, rows: search(norms, terms), anyOrder: true };
    }
    return { terms: terms, rows: search(norms, terms), anyOrder: false };
  }

  /**
   * Ranges of `text` to highlight for `terms`, as sorted, non-overlapping
   * [start, end) pairs of offsets into the original (unfolded) text.
   */
  function highlightRanges(text, terms) {
    if (!terms.length) return [];
    var folded = foldWithMap(text);
    var ranges = [];
    for (var t = 0; t < terms.length; t++) {
      var term = terms[t];
      var pos = folded.norm.indexOf(term);
      while (pos !== -1) {
        var end = folded.to[pos + term.length - 1];
        // Keep decomposed accents (e + U+0301) attached to their base letter.
        while (end < text.length && /[\u0300-\u036f]/.test(text.charAt(end))) end++;
        ranges.push([folded.from[pos], end]);
        pos = folded.norm.indexOf(term, pos + term.length);
      }
    }
    ranges.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var merged = [];
    for (var i = 0; i < ranges.length; i++) {
      var last = merged[merged.length - 1];
      if (last && ranges[i][0] <= last[1]) {
        last[1] = Math.max(last[1], ranges[i][1]);
      } else {
        merged.push(ranges[i]);
      }
    }
    return merged;
  }

  /** Format seconds as m:ss, or h:mm:ss when `withHours` is set. */
  function formatTime(seconds, withHours) {
    var total = Math.max(0, Math.floor(seconds));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var ss = (s < 10 ? "0" : "") + s;
    if (withHours || h > 0) return h + ":" + (m < 10 ? "0" : "") + m + ":" + ss;
    return m + ":" + ss;
  }

  return {
    fold: fold,
    parseQuery: parseQuery,
    search: search,
    find: find,
    highlightRanges: highlightRanges,
    formatTime: formatTime,
  };
});
