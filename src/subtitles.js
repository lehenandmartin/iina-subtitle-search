"use strict";

/*
 * Subtitle decoding and parsing. Pure JavaScript, no IINA APIs, so the same
 * file runs inside IINA (via its require() polyfill) and under Node for tests.
 *
 * A cue is { start, end, text } with times in seconds on the subtitle's own
 * timeline (i.e. before mpv's sub-delay is applied).
 */

// ---------------------------------------------------------------------------
// Text decoding (JavaScriptCore has no TextDecoder)
// ---------------------------------------------------------------------------

// Windows-1252 code points for bytes 0x80-0x9F; everything else maps 1:1.
var CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

function unitsToString(units, length) {
  var parts = [];
  var CHUNK = 8192;
  for (var i = 0; i < length; i += CHUNK) {
    parts.push(
      String.fromCharCode.apply(null, units.subarray(i, Math.min(i + CHUNK, length))),
    );
  }
  return parts.join("");
}

/** Strict UTF-8 decoder. Returns null when the bytes are not valid UTF-8. */
function decodeUtf8(bytes, offset) {
  var n = bytes.length;
  var out = new Uint16Array(n - offset);
  var o = 0;
  var i = offset;
  while (i < n) {
    var b = bytes[i++];
    if (b < 0x80) {
      out[o++] = b;
      continue;
    }
    var extra, cp, min;
    if (b >= 0xc2 && b <= 0xdf) {
      extra = 1; cp = b & 0x1f; min = 0x80;
    } else if (b >= 0xe0 && b <= 0xef) {
      extra = 2; cp = b & 0x0f; min = 0x800;
    } else if (b >= 0xf0 && b <= 0xf4) {
      extra = 3; cp = b & 0x07; min = 0x10000;
    } else {
      return null;
    }
    if (i + extra > n) return null;
    for (var k = 0; k < extra; k++) {
      var c = bytes[i++];
      if ((c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out[o++] = 0xd800 + (cp >> 10);
      out[o++] = 0xdc00 + (cp & 0x3ff);
    } else {
      out[o++] = cp;
    }
  }
  return unitsToString(out, o);
}

function decodeUtf16(bytes, offset, littleEndian) {
  var count = (bytes.length - offset) >> 1;
  var out = new Uint16Array(count);
  for (var i = 0; i < count; i++) {
    var a = bytes[offset + 2 * i];
    var b = bytes[offset + 2 * i + 1];
    out[i] = littleEndian ? a | (b << 8) : (a << 8) | b;
  }
  return unitsToString(out, count);
}

function decodeWindows1252(bytes) {
  var n = bytes.length;
  var out = new Uint16Array(n);
  for (var i = 0; i < n; i++) {
    var b = bytes[i];
    out[i] = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
  }
  return unitsToString(out, n);
}

/**
 * Decode the raw bytes of a subtitle file.
 * UTF-8 and UTF-16 are detected (with or without BOM); anything else is read
 * as Windows-1252, the usual encoding of legacy Western European subtitles.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeBytes(bytes) {
  var n = bytes.length;
  if (n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    var withBom = decodeUtf8(bytes, 3);
    if (withBom !== null) return withBom;
  }
  if (n >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes, 2, true);
  if (n >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes, 2, false);

  // BOM-less UTF-16: mostly-ASCII text has a NUL in every other byte.
  if (n >= 64) {
    var evenNul = 0;
    var oddNul = 0;
    var sample = Math.min(n & ~1, 512);
    for (var i = 0; i < sample; i += 2) {
      if (bytes[i] === 0) evenNul++;
      if (bytes[i + 1] === 0) oddNul++;
    }
    var pairs = sample / 2;
    if (oddNul > pairs * 0.6 && evenNul < pairs * 0.1) return decodeUtf16(bytes, 0, true);
    if (evenNul > pairs * 0.6 && oddNul < pairs * 0.1) return decodeUtf16(bytes, 0, false);
  }

  var utf8 = decodeUtf8(bytes, 0);
  return utf8 !== null ? utf8 : decodeWindows1252(bytes);
}

// ---------------------------------------------------------------------------
// Text clean-up
// ---------------------------------------------------------------------------

var ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "",
};

function decodeEntities(text) {
  if (text.indexOf("&") === -1) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (whole, name) {
    if (name.charAt(0) === "#") {
      var hex = name.charAt(1) === "x" || name.charAt(1) === "X";
      var code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    var key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : whole;
  });
}

/** Replace unpaired surrogates, which cannot be serialised across the webview bridge. */
function fixSurrogates(text) {
  return text.replace(/([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDFFF]/g, function (m, pair) {
    return pair || "\ufffd";
  });
}

function collapseWhitespace(text) {
  return text
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

/** Remove ASS override blocks ({\i1}, {\an8}, ...) and the vector drawings they switch on. */
function stripAssOverrides(text) {
  if (text.indexOf("{") === -1) return text;
  var out = "";
  var drawing = false;
  var re = /\{([^}]*)\}/g;
  var last = 0;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (!drawing) out += text.slice(last, m.index);
    last = re.lastIndex;
    var block = m[1];
    if (block.indexOf("\\") === -1) {
      // Not an override block: keep "{sic}"-style text as is.
      if (!drawing) out += m[0];
      continue;
    }
    var tagRe = /\\p(\d+)/g;
    var tag;
    while ((tag = tagRe.exec(block)) !== null) drawing = tag[1] !== "0";
  }
  if (!drawing) out += text.slice(last);
  return out;
}

/** Clean the text of an SRT/WebVTT cue: drop markup, decode entities, flatten lines. */
function cleanMarkupText(text) {
  var s = stripAssOverrides(text);
  // HTML-like tags (<i>, <font color=...>, <c.yellow>, <v Speaker>) and WebVTT
  // karaoke timestamps (<00:01.000>). A bare "<" in dialogue is left alone.
  s = s.replace(/<\/?[a-zA-Z][^<>]*>|<\d+:\d\d[^<>]*>/g, "");
  s = decodeEntities(s);
  return fixSurrogates(collapseWhitespace(s));
}

function cleanAssText(text) {
  var s = stripAssOverrides(text);
  s = s.replace(/\\[Nn]/g, " ").replace(/\\h/g, " ");
  return fixSurrogates(collapseWhitespace(s));
}

// ---------------------------------------------------------------------------
// SubRip (.srt) and WebVTT (.vtt)
// ---------------------------------------------------------------------------

var TIMESTAMP = "(?:(\\d+):)?(\\d{1,2}):(\\d{1,2})(?:[.,:](\\d{1,3}))?";
var TIMING_LINE = new RegExp("^\\s*" + TIMESTAMP + "\\s*-->\\s*" + TIMESTAMP);

function toSeconds(h, m, s, frac) {
  var ms = frac ? parseInt((frac + "00").slice(0, 3), 10) : 0;
  return (parseInt(h || "0", 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) + ms / 1000;
}

function parseSrtLike(text) {
  var lines = text.split(/\r\n|\r|\n/);
  var cues = [];
  var i = 0;
  while (i < lines.length) {
    var m = TIMING_LINE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    var start = toSeconds(m[1], m[2], m[3], m[4]);
    var end = toSeconds(m[5], m[6], m[7], m[8]);
    i++;
    var textLines = [];
    while (i < lines.length) {
      var line = lines[i];
      if (line.trim() === "") break;
      if (TIMING_LINE.test(line)) break;
      // A cue number directly followed by a timing line: the blank separator is missing.
      if (/^\s*\d+\s*$/.test(line) && i + 1 < lines.length && TIMING_LINE.test(lines[i + 1])) break;
      textLines.push(line);
      i++;
    }
    var cueText = cleanMarkupText(textLines.join("\n"));
    if (cueText) cues.push({ start: start, end: Math.max(end, start), text: cueText });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// Advanced SubStation Alpha (.ass / .ssa)
// ---------------------------------------------------------------------------

function parseAssTime(value) {
  var m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\s*$/.exec(value);
  if (!m) return NaN;
  return toSeconds(m[1], m[2], m[3], m[4]);
}

function parseAss(text) {
  var lines = text.split(/\r\n|\r|\n/);
  var cues = [];
  var inEvents = false;
  var sawSection = false;
  // Default field order of ASS v4+; SSA v4 has "Marked" in place of "Layer".
  var format = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      sawSection = true;
      inEvents = section[1].trim().toLowerCase() === "events";
      continue;
    }
    if (sawSection && !inEvents) continue;

    var kv = /^\s*(\w+)\s*:\s?(.*)$/.exec(line);
    if (!kv) continue;
    var key = kv[1].toLowerCase();

    if (key === "format") {
      var fields = kv[2].split(",").map(function (f) { return f.trim().toLowerCase(); });
      if (fields.indexOf("text") !== -1 && fields.indexOf("start") !== -1) format = fields;
      continue;
    }
    if (key !== "dialogue") continue;

    var rest = kv[2];
    var values = [];
    for (var f = 0; f < format.length - 1; f++) {
      var comma = rest.indexOf(",");
      if (comma === -1) break;
      values.push(rest.slice(0, comma));
      rest = rest.slice(comma + 1);
    }
    if (values.length !== format.length - 1) continue;
    values.push(rest);

    var start = parseAssTime(values[format.indexOf("start")]);
    var end = parseAssTime(values[format.indexOf("end")]);
    if (isNaN(start)) continue;
    var cueText = cleanAssText(values[format.indexOf("text")] || "");
    if (!cueText) continue;
    cues.push({ start: start, end: isNaN(end) ? start : Math.max(end, start), text: cueText });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Formats this module can parse natively, by lower-case file extension. */
var NATIVE_EXTENSIONS = ["srt", "vtt", "webvtt", "ass", "ssa"];

function detectFormat(text) {
  var head = text.slice(0, 4096);
  if (/^\ufeff?\s*WEBVTT/.test(head)) return "vtt";
  if (/^\s*\[(script info|events|v4\+? styles)\]/im.test(head)) return "ass";
  // Headerless ASS fragment: Dialogue lines and no SRT/WebVTT timing arrows.
  if (/^\s*Dialogue\s*:/m.test(text) && text.indexOf("-->") === -1) return "ass";
  return "srt";
}

/**
 * Parse subtitle text into a sorted, de-duplicated list of cues.
 * The format is sniffed from the content, so the file extension is irrelevant.
 * @param {string} text
 * @returns {{start: number, end: number, text: string}[]}
 */
function parseSubtitles(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  var cues = detectFormat(text) === "ass" ? parseAss(text) : parseSrtLike(text);

  cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });

  // Typeset ASS files repeat a line on several layers; keep one copy.
  var result = [];
  for (var i = 0; i < cues.length; i++) {
    var cue = cues[i];
    var duplicate = false;
    for (var j = result.length - 1; j >= 0 && result[j].start === cue.start; j--) {
      if (result[j].text === cue.text) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) result.push(cue);
  }
  return result;
}

/**
 * Index of the cue displayed at time `t` (seconds), or -1 if none.
 * `cues` must be sorted by start time; overlapping cues resolve to the latest one.
 */
function findCueIndexAt(cues, t) {
  var lo = 0;
  var hi = cues.length - 1;
  var last = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (var i = last; i >= 0 && i > last - 16; i--) {
    if (cues[i].end > t) return i;
  }
  return -1;
}

module.exports = {
  NATIVE_EXTENSIONS: NATIVE_EXTENSIONS,
  decodeBytes: decodeBytes,
  parseSubtitles: parseSubtitles,
  findCueIndexAt: findCueIndexAt,
};
