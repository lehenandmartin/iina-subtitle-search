"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fold, parseQuery, search, find, highlightRanges, formatTime } = require("../ui/search.js");

const highlighted = (text, query) =>
  highlightRanges(text, parseQuery(query)).map(([s, e]) => text.slice(s, e));

test("fold: case, accents, ligatures and typographic punctuation", () => {
  assert.equal(fold("Hello World"), "hello world");
  assert.equal(fold("Été à Noël, ça va ?"), "ete a noel, ca va ?");
  assert.equal(fold("Cœur, Æther, Straße"), "coeur, aether, strasse");
  assert.equal(fold("C’est « vrai » — non…"), "c'est \" vrai \" - non...");
  assert.equal(fold("été"), "ete");
  assert.equal(fold("İstanbul ıslak"), "istanbul islak");
  assert.equal(fold("日本語 😀"), "日本語 😀");
});

test("parseQuery: words, phrases and duplicates", () => {
  assert.deepEqual(parseQuery(""), []);
  assert.deepEqual(parseQuery("   "), []);
  assert.deepEqual(parseQuery("Hello  WORLD hello"), ["hello", "world"]);
  assert.deepEqual(parseQuery('"good  morning" Été'), ["good morning", "ete"]);
  assert.deepEqual(parseQuery("« bonne nuit »"), ["bonne nuit"]);
  assert.deepEqual(parseQuery('"unterminated phrase'), ["unterminated phrase"]);
  assert.deepEqual(parseQuery('""'), []);
});

test("search: every term must match, accent-insensitively", () => {
  const lines = ["Bonjour, ça va ?", "Ça ne va pas du tout.", "Tout va bien.", "Rien à voir"];
  const norms = lines.map(fold);
  assert.deepEqual(search(norms, parseQuery("ca va")), [0, 1]);
  assert.deepEqual(search(norms, parseQuery("VA")), [0, 1, 2]);
  assert.deepEqual(search(norms, parseQuery('"va pas"')), [1]);
  assert.deepEqual(search(norms, parseQuery("tout bien")), [2]);
  assert.deepEqual(search(norms, parseQuery("absent")), []);
  assert.deepEqual(search(norms, []), []);
});

test("find: the query as typed first, then its words in any order", () => {
  const lines = ["Tu es sûr que c'est le bon chemin ?", "C'est seulement le vent.", "Le vent, c’est tout."];
  const norms = lines.map(fold);

  assert.deepEqual(find(norms, "  C'EST   le "), { terms: ["c'est le"], rows: [0], anyOrder: false });
  assert.deepEqual(find(norms, "vent c'est"), { terms: ["vent", "c'est"], rows: [1, 2], anyOrder: true });
  assert.deepEqual(find(norms, "vent"), { terms: ["vent"], rows: [1, 2], anyOrder: false });
  assert.deepEqual(find(norms, '"le vent" tout'), { terms: ["le vent", "tout"], rows: [2], anyOrder: false });
  assert.deepEqual(find(norms, '"vent le"'), { terms: ["vent le"], rows: [], anyOrder: false });
  assert.deepEqual(find(norms, "chemin absent"), { terms: ["chemin", "absent"], rows: [], anyOrder: true });
  assert.deepEqual(find(norms, "   "), { terms: [], rows: [], anyOrder: false });
});

test("highlightRanges: maps matches back onto the original text", () => {
  assert.deepEqual(highlighted("Un Café crème", "cafe"), ["Café"]);
  assert.deepEqual(highlighted("Mon cœur bat", "coeur"), ["cœur"]);
  assert.deepEqual(highlighted("Mon cœur bat", "oe"), ["œ"]);
  assert.deepEqual(highlighted("C’est l’été", "c'est ete"), ["C’est", "été"]);
  assert.deepEqual(highlighted("été chaud", "ete"), ["été"]);
  assert.deepEqual(highlighted("banana", "ana"), ["ana"]);
  assert.deepEqual(highlighted("abcabc", "abc bc"), ["abcabc"]);
  assert.deepEqual(highlighted("say 😀 cheese", "cheese"), ["cheese"]);
  assert.deepEqual(highlighted("nothing here", "zzz"), []);
});

test("highlightRanges: overlapping terms are merged and sorted", () => {
  const ranges = highlightRanges("the other mother", parseQuery("the other"));
  assert.deepEqual(ranges, [[0, 3], [4, 9], [11, 16]]);
});

test("formatTime", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(59.9), "0:59");
  assert.equal(formatTime(754.2), "12:34");
  assert.equal(formatTime(754.2, true), "0:12:34");
  assert.equal(formatTime(3723), "1:02:03");
  assert.equal(formatTime(-5), "0:00");
});
