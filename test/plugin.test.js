"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createPlayer } = require("./support/fake-iina.js");

const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/local/bin/ffmpeg", "/usr/bin/ffmpeg"]
  .find((p) => fs.existsSync(p));

const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "iina-subtitle-search-fixtures-"));
test.after(() => fs.rmSync(fixtures, { recursive: true, force: true }));

const SRT = [
  "1", "00:00:01,000 --> 00:00:02,000", "Bonjour, ça va ?", "",
  "2", "00:00:03,000 --> 00:00:04,500", "Tricky `backtick` and ${dollar} \\ \"quotes\"", "",
  "3", "00:00:05,000 --> 00:00:05,900", "Très bien, merci.", "",
].join("\n");

const ASS = [
  "[Script Info]", "ScriptType: v4.00+", "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Styled{\\i0} line, with a comma",
  "Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}",
  "Dialogue: 0,0:00:04.50,0:00:05.50,Default,,0,0,0,,Second\\Nline",
  "",
].join("\n");

function writeFixture(name, content) {
  const file = path.join(fixtures, name);
  fs.writeFileSync(file, content);
  return file;
}

function externalTrack(id, file, extra) {
  return Object.assign(
    { type: "sub", id, codec: "subrip", external: true, "external-filename": file, "ff-index": 0 },
    extra,
  );
}

async function withPlayer(options, body) {
  const player = createPlayer(options).start();
  try {
    await body(player);
  } finally {
    player.dispose();
  }
}

test("registers the menu item and loads the sidebar once the window exists", async () => {
  await withPlayer({}, async (player) => {
    assert.equal(player.loadedPage, null);
    assert.equal(player.menuItems.length, 1);
    assert.equal(player.menuItems[0].title, "Search Subtitles…");
    assert.equal(player.menuItems[0].options.keyBinding, "Meta+f");

    player.openWindow();
    assert.equal(player.loadedPage, "ui/sidebar.html");

    player.fromSidebar("ready", {});
    const state = await player.waitForState((s) => s.status === "idle");
    assert.deepEqual(state.tracks, []);

    player.menuItems[0].action();
    assert.equal(player.sidebarShown, 1);
  });
});

test("the shortcut closes the sidebar when the search tab is already showing", async () => {
  await withPlayer({}, async (player) => {
    player.openWindow();
    player.fromSidebar("ready", {});
    player.fromSidebar("visibility", { visible: false });
    const toggle = player.menuItems[0].action;

    toggle();
    assert.deepEqual([player.sidebarShown, player.sidebarHidden], [1, 0]);
    player.fromSidebar("visibility", { visible: true });

    toggle();
    assert.deepEqual([player.sidebarShown, player.sidebarHidden], [1, 1]);
    player.fromSidebar("visibility", { visible: false });

    toggle();
    assert.deepEqual([player.sidebarShown, player.sidebarHidden], [2, 1]);

    // Closed by other means (close button, another tab): the page reports it, so the next press opens.
    player.fromSidebar("visibility", { visible: true });
    player.fromSidebar("visibility", { visible: false });
    toggle();
    assert.deepEqual([player.sidebarShown, player.sidebarHidden], [3, 1]);

    // If the "hidden" report were ever lost, one press is wasted but the next one opens again.
    player.fromSidebar("visibility", { visible: true });
    toggle();
    toggle();
    assert.deepEqual([player.sidebarShown, player.sidebarHidden], [4, 2]);
  });
});

test("an empty shortcut preference registers the menu item without a key binding", async () => {
  await withPlayer({ prefs: { shortcut: "  " } }, async (player) => {
    assert.deepEqual(Object.keys(player.menuItems[0].options), []);
  });
});

test("external SRT: cues reach the sidebar intact, legacy encoding included", async () => {
  // Windows-1252 bytes, as many older French subtitle files are.
  const file = writeFixture("legacy.fr.srt", Buffer.from(SRT, "latin1"));
  await withPlayer({}, async (player) => {
    player.openWindow();
    player.fromSidebar("ready", {});
    player.openFile({
      path: "/movies/film.mkv",
      sid: "1",
      "track-list": [
        { type: "video", id: 1, codec: "h264" },
        externalTrack(1, file, { lang: "fr", selected: true }),
      ],
    });

    const state = await player.waitForState((s) => s.status === "ready");
    assert.deepEqual(state.tracks, [{ id: 1, label: "FR · legacy.fr.srt", active: true }]);
    assert.equal(state.trackId, 1);

    const cues = player.last("cues");
    assert.equal(cues.version, state.cuesVersion);
    assert.deepEqual(cues.cues, [
      [1, 2, "Bonjour, ça va ?"],
      [3, 4.5, "Tricky `backtick` and ${dollar} \\ \"quotes\""],
      [5, 5.9, "Très bien, merci."],
    ]);
    assert.equal(player.execCalls.length, 0, "ffmpeg is not needed for .srt files");
  });
});

test("seeking applies the subtitle delay and the lead-in preference", async () => {
  const file = writeFixture("seek.srt", SRT);
  await withPlayer({ prefs: { leadIn: 0.5 } }, async (player) => {
    player.openWindow();
    player.fromSidebar("ready", {});
    player.openFile({ path: "/movies/film.mkv", sid: "1", "sub-delay": 2, "track-list": [externalTrack(1, file)] });
    const state = await player.waitForState((s) => s.status === "ready");
    assert.equal(state.delay, 2);

    player.fromSidebar("seek", { version: state.cuesVersion, index: 1 });
    assert.deepEqual(player.seeks, [3 + 2 - 0.5]);

    player.fromSidebar("seek", { version: state.cuesVersion - 1, index: 0 });
    player.fromSidebar("seek", { version: state.cuesVersion, index: 99 });
    assert.equal(player.seeks.length, 1, "stale or out-of-range requests are ignored");

    player.prefs.leadIn = 10;
    player.fromSidebar("seek", { version: state.cuesVersion, index: 0 });
    assert.equal(player.seeks[1], 0, "never seeks before the start");
  });
});

test("reports the line being played", async () => {
  const file = writeFixture("position.srt", SRT);
  await withPlayer({}, async (player) => {
    player.openWindow();
    player.fromSidebar("ready", {});
    player.openFile({ path: "/movies/film.mkv", sid: "1", "time-pos": 3.2, "track-list": [externalTrack(1, file)] });
    const state = await player.waitForState((s) => s.status === "ready");
    assert.deepEqual(player.last("position"), { version: state.cuesVersion, index: 1 });

    player.props["time-pos"] = 5.5;
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.deepEqual(player.last("position"), { version: state.cuesVersion, index: 2 });

    player.props["time-pos"] = 2.5;
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.deepEqual(player.last("position"), { version: state.cuesVersion, index: -1 });
  });
});

test("follows IINA's subtitle selection until a track is picked in the sidebar", async () => {
  const first = writeFixture("first.srt", "1\n00:00:01,000 --> 00:00:02,000\nFirst file\n");
  const second = writeFixture("second.vtt", "WEBVTT\n\n00:01.000 --> 00:02.000\nSecond file\n");
  await withPlayer({}, async (player) => {
    player.openWindow();
    player.fromSidebar("ready", {});
    player.openFile({
      path: "/movies/film.mkv",
      sid: "1",
      "track-list": [externalTrack(1, first), externalTrack(2, second, { codec: "webvtt", title: "Commentary" })],
    });
    await player.waitForState((s) => s.status === "ready" && s.trackId === 1);
    assert.equal(player.last("cues").cues[0][2], "First file");

    player.props.sid = "2";
    player.emit("mpv.sid.changed");
    let state = await player.waitForState((s) => s.status === "ready" && s.trackId === 2);
    assert.equal(player.last("cues").cues[0][2], "Second file");
    assert.deepEqual(state.tracks.map((t) => [t.label, t.active]), [["first.srt", false], ["Commentary", true]]);

    player.fromSidebar("select-track", { id: 1 });
    state = await player.waitForState((s) => s.status === "ready" && s.trackId === 1);
    assert.equal(player.last("cues").cues[0][2], "First file");
    assert.equal(state.tracks[1].active, true, "the displayed track is unchanged");

    // Picking the displayed track goes back to following IINA's selection...
    player.fromSidebar("select-track", { id: 2 });
    await player.waitForState((s) => s.trackId === 2);
    player.props.sid = "no";
    player.emit("mpv.sid.changed");
    // ...so with subtitles switched off, the first text track is searched.
    await player.waitForState((s) => s.trackId === 1);

    // A track picked while another one (or none) is displayed stays put.
    player.fromSidebar("select-track", { id: 2 });
    await player.waitForState((s) => s.trackId === 2);
    player.props.sid = "1";
    player.emit("mpv.sid.changed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(player.last("state").trackId, 2);
    assert.equal(player.last("state").tracks[0].active, true);
  });
});

test("states without searchable text", async () => {
  await withPlayer({}, async (player) => {
    player.openWindow();
    player.fromSidebar("ready", {});

    player.openFile({ path: "/movies/film.mkv", "track-list": [{ type: "video", id: 1 }] });
    await player.waitForState((s) => s.status === "no-subtitles");

    player.openFile({
      path: "/movies/bluray.mkv",
      sid: "1",
      "track-list": [{ type: "sub", id: 1, codec: "hdmv_pgs_subtitle", "ff-index": 2, lang: "en" }],
    });
    let state = await player.waitForState((s) => s.status === "error");
    assert.equal(state.code, "image");
    assert.equal(state.tracks[0].label, "EN · Track 1 (image-based)");

    player.openFile({
      path: "https://example.com/stream.m3u8",
      sid: "1",
      "track-list": [{ type: "sub", id: 1, codec: "webvtt", "ff-index": 2 }],
    });
    state = await player.waitForState((s) => s.status === "error" && s.code === "remote");

    const empty = writeFixture("empty.srt", "\n\n");
    player.hideFfmpeg = true;
    player.openFile({ path: "/movies/film.mkv", sid: "1", "track-list": [externalTrack(1, empty)] });
    await player.waitForState((s) => s.status === "empty");

    player.openFile({ path: "/movies/film.mkv", sid: "1", "track-list": [externalTrack(1, "/nonexistent/file.srt")] });
    state = await player.waitForState((s) => s.status === "error" && s.code === "unreadable");
    assert.equal(state.detail, "/nonexistent/file.srt");

    player.props["idle-active"] = true;
    player.emit("mpv.end-file");
    await player.waitForState((s) => s.status === "idle");
    assert.deepEqual(player.last("cues").cues, []);
  });
});

test("embedded track without ffmpeg: asks for it, and Try Again works once it is there", { skip: !FFMPEG }, async () => {
  const srt = writeFixture("retry-source.srt", SRT);
  const video = path.join(fixtures, "retry.mkv");
  execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=5:d=6", "-i", srt,
    "-map", "0:v", "-map", "1:s", "-c:v", "mpeg4", "-c:s", "srt", video]);

  await withPlayer({ hideFfmpeg: true }, async (player) => {
    player.openWindow();
    player.fromSidebar("ready", {});
    player.openFile({ path: video, sid: "1", "track-list": [{ type: "sub", id: 1, codec: "subrip", "ff-index": 1 }] });
    await player.waitForState((s) => s.status === "error" && s.code === "ffmpeg-missing");

    player.hideFfmpeg = false;
    player.fromSidebar("reload");
    await player.waitForState((s) => s.status === "ready");
    assert.equal(player.last("cues").cues.length, 3);
  });
});

test("embedded tracks are extracted with ffmpeg (SubRip, ASS, MP4 text)", { skip: !FFMPEG }, async () => {
  const srt = writeFixture("embedded-source.srt", SRT);
  const ass = writeFixture("embedded-source.ass", ASS);
  const mkv = path.join(fixtures, "embedded.mkv");
  const mp4 = path.join(fixtures, "embedded.mp4");
  const video = ["-f", "lavfi", "-i", "color=c=black:s=64x36:r=5:d=6"];
  execFileSync(FFMPEG, ["-v", "error", "-y", ...video, "-i", srt, "-i", ass,
    "-map", "0:v", "-map", "1:s", "-map", "2:s", "-c:v", "mpeg4", "-c:s:0", "srt", "-c:s:1", "ass", mkv]);
  execFileSync(FFMPEG, ["-v", "error", "-y", ...video, "-i", srt,
    "-map", "0:v", "-map", "1:s", "-c:v", "mpeg4", "-c:s", "mov_text", mp4]);

  await withPlayer({}, async (player) => {
    player.openWindow();
    player.fromSidebar("ready", {});
    player.openFile({
      path: mkv,
      sid: "1",
      "track-list": [
        { type: "video", id: 1, codec: "mpeg4", "ff-index": 0 },
        { type: "sub", id: 1, codec: "subrip", "ff-index": 1, lang: "fr", title: "Français" },
        { type: "sub", id: 2, codec: "ass", "ff-index": 2, lang: "en" },
      ],
    });

    await player.waitForState((s) => s.status === "ready" && s.trackId === 1);
    assert.deepEqual(player.last("cues").cues, [
      [1, 2, "Bonjour, ça va ?"],
      [3, 4.5, "Tricky `backtick` and ${dollar} \\ \"quotes\""],
      [5, 5.9, "Très bien, merci."],
    ]);
    assert.equal(player.execCalls.length, 1);

    player.fromSidebar("select-track", { id: 2 });
    await player.waitForState((s) => s.status === "ready" && s.trackId === 2);
    assert.deepEqual(player.last("cues").cues, [
      [1, 2, "Styled line, with a comma"],
      [4.5, 5.5, "Second line"],
    ]);

    // Going back uses the cache instead of running ffmpeg again.
    player.fromSidebar("select-track", { id: 1 });
    await player.waitForState((s) => s.status === "ready" && s.trackId === 1);
    assert.equal(player.execCalls.length, 2);
    assert.deepEqual(fs.readdirSync(player.tmpDir), [], "temporary files are removed");

    player.openFile({ path: mp4, sid: "1", "track-list": [{ type: "sub", id: 1, codec: "mov_text", "ff-index": 1 }] });
    await player.waitForState((s) => s.status === "ready" && s.cuesVersion > 3);
    assert.deepEqual(player.last("cues").cues.map((c) => c[2]), [
      "Bonjour, ça va ?",
      "Tricky `backtick` and ${dollar} \\ \"quotes\"",
      "Très bien, merci.",
    ]);
  });
});

test("ffmpeg errors are reported with ffmpeg's own message", { skip: !FFMPEG }, async () => {
  const notVideo = writeFixture("broken.mkv", "this is not a video");
  await withPlayer({}, async (player) => {
    player.openWindow();
    player.fromSidebar("ready", {});
    player.openFile({ path: notVideo, sid: "1", "track-list": [{ type: "sub", id: 1, codec: "subrip", "ff-index": 1 }] });
    const state = await player.waitForState((s) => s.status === "error");
    assert.equal(state.code, "ffmpeg-failed");
    assert.match(state.detail, /\S/);
  });
});

test("a plugin enabled while a video is already playing picks it up", async () => {
  const file = writeFixture("late.srt", SRT);
  const player = createPlayer({
    props: { "idle-active": false, path: "/movies/film.mkv", sid: "1", "track-list": [externalTrack(1, file)] },
  });
  player.windowLoaded = true;
  try {
    player.start();
    assert.equal(player.loadedPage, "ui/sidebar.html");
    player.fromSidebar("ready", {});
    await player.waitForState((s) => s.status === "ready");
    assert.equal(player.last("cues").cues.length, 3);
  } finally {
    player.dispose();
  }
});
