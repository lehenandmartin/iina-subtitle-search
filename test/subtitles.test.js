"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeBytes, parseSubtitles, findCueIndexAt } = require("../src/subtitles.js");

const texts = (cues) => cues.map((c) => c.text);

test("SRT: basic cues, markup, multi-line text and CRLF", () => {
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:03,500",
    "<i>Hello</i>, <font color=\"#ffff00\">world</font>!",
    "",
    "2",
    "00:01:02,250 --> 00:01:04,000",
    "- First speaker.",
    "- Second speaker.",
    "",
    "3",
    "01:00:00,000 --> 01:00:02,000",
    "{\\an8}Top &amp; centre",
    "",
  ].join("\r\n");
  const cues = parseSubtitles(srt);
  assert.deepEqual(cues, [
    { start: 1, end: 3.5, text: "Hello, world!" },
    { start: 62.25, end: 64, text: "- First speaker. - Second speaker." },
    { start: 3600, end: 3602, text: "Top & centre" },
  ]);
});

test("SRT: tolerates a BOM, missing blank lines and unsorted cues", () => {
  const srt =
    "﻿2\n00:00:10,000 --> 00:00:12,000\nSecond\n1\n00:00:01,000 --> 00:00:02,000\nFirst\n" +
    "3\n00:00:20,000 --> 00:00:21,000\n\n4\n00:00:30,000 --> 00:00:31,000\n2 + 2 < 5 > 3\n";
  assert.deepEqual(texts(parseSubtitles(srt)), ["First", "Second", "2 + 2 < 5 > 3"]);
});

test("SRT: a line that is only a number stays part of the text", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHow many?\n42\n\n2\n00:00:03,000 --> 00:00:04,000\nOk\n";
  assert.deepEqual(texts(parseSubtitles(srt)), ["How many? 42", "Ok"]);
});

test("WebVTT: header, notes, cue settings, short timestamps and voice tags", () => {
  const vtt = [
    "WEBVTT - Example",
    "Kind: captions",
    "",
    "NOTE this is a comment",
    "that spans lines",
    "",
    "STYLE",
    "::cue { color: lime }",
    "",
    "intro",
    "00:01.000 --> 00:04.000 line:0 position:20% align:start",
    "<v Roger>Hello <c.loud>there</c></v>",
    "",
    "00:00:05.500 --> 00:00:07.000",
    "Karaoke <00:00:06.000>style&nbsp;text",
    "",
  ].join("\n");
  assert.deepEqual(parseSubtitles(vtt), [
    { start: 1, end: 4, text: "Hello there" },
    { start: 5.5, end: 7, text: "Karaoke style text" },
  ]);
});

test("ASS: format line, commas in text, overrides, drawings and duplicates", () => {
  const ass = [
    "[Script Info]",
    "Title: Example",
    "ScriptType: v4.00+",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize",
    "Style: Default,Arial,20",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Hello{\\i0}, world\\Nsecond line",
    "Dialogue: 1,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Hello{\\i0}, world\\Nsecond line",
    "Comment: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,not shown",
    "Dialogue: 0,0:00:06.00,0:00:07.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}",
    "Dialogue: 0,0:00:08.00,0:00:09.00,Sign,,0,0,0,,{\\p1}m 0 0 l 10 0{\\p0}After\\hdrawing",
    "Dialogue: 0,1:02:03.45,1:02:05.00,Default,,0,0,0,,Late {sic} line",
  ].join("\n");
  assert.deepEqual(parseSubtitles(ass), [
    { start: 1, end: 3.5, text: "Hello, world second line" },
    { start: 8, end: 9, text: "After drawing" },
    { start: 3723.45, end: 3725, text: "Late {sic} line" },
  ]);
});

test("ASS: honours a custom field order and the SSA layout", () => {
  const ssa = [
    "[Events]",
    "Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: Marked=0,0:00:02.00,0:00:03.00,Default,NTP,0000,0000,0000,,One, two",
  ].join("\n");
  assert.deepEqual(texts(parseSubtitles(ssa)), ["One, two"]);

  const reordered = "[Events]\nFormat: Start, End, Text\nDialogue: 0:00:02.00,0:00:03.00,A, B, C";
  assert.deepEqual(parseSubtitles(reordered), [{ start: 2, end: 3, text: "A, B, C" }]);
});

test("decodeBytes: UTF-8 with and without BOM", () => {
  const text = "Ça va ? Très bien — 你好 😀";
  const utf8 = Buffer.from(text, "utf8");
  assert.equal(decodeBytes(new Uint8Array(utf8)), text);
  assert.equal(decodeBytes(new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]))), text);
});

test("decodeBytes: UTF-16 with BOM and without", () => {
  const text = "1\r\n00:00:01,000 --> 00:00:02,000\r\nUn café, s'il vous plaît.\r\n\r\n";
  const le = Buffer.from(text, "utf16le");
  const be = Buffer.from(le).swap16();
  assert.equal(decodeBytes(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))), text);
  assert.equal(decodeBytes(new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))), text);
  const long = text.repeat(4);
  assert.equal(decodeBytes(new Uint8Array(Buffer.from(long, "utf16le"))), long);
});

test("decodeBytes: falls back to Windows-1252 for legacy files", () => {
  // "Très bien, c’est l’été… 5 €" in Windows-1252
  const bytes = [
    0x54, 0x72, 0xe8, 0x73, 0x20, 0x62, 0x69, 0x65, 0x6e, 0x2c, 0x20, 0x63, 0x92, 0x65, 0x73,
    0x74, 0x20, 0x6c, 0x92, 0xe9, 0x74, 0xe9, 0x85, 0x20, 0x35, 0x20, 0x80,
  ];
  assert.equal(decodeBytes(new Uint8Array(bytes)), "Très bien, c’est l’été… 5 €");
});

test("decodeBytes: handles large inputs", () => {
  const text = "ligne accentuée é\n".repeat(50000);
  assert.equal(decodeBytes(new Uint8Array(Buffer.from(text, "utf8"))), text);
});

test("findCueIndexAt: gaps, boundaries and overlaps", () => {
  const cues = [
    { start: 1, end: 3, text: "a" },
    { start: 5, end: 8, text: "b" },
    { start: 6, end: 7, text: "c" },
    { start: 10, end: 11, text: "d" },
  ];
  assert.equal(findCueIndexAt(cues, 0.5), -1);
  assert.equal(findCueIndexAt(cues, 1), 0);
  assert.equal(findCueIndexAt(cues, 2.99), 0);
  assert.equal(findCueIndexAt(cues, 3), -1);
  assert.equal(findCueIndexAt(cues, 5.5), 1);
  assert.equal(findCueIndexAt(cues, 6.5), 2);
  assert.equal(findCueIndexAt(cues, 7.5), 1);
  assert.equal(findCueIndexAt(cues, 10.5), 3);
  assert.equal(findCueIndexAt(cues, 99), -1);
  assert.equal(findCueIndexAt([], 1), -1);
});
