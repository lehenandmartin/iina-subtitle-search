/*
 * Subtitle Search - IINA plugin, main entry.
 *
 * One instance of this script runs per player window. It finds the subtitle
 * track to search, turns it into a list of cues (reading external files
 * directly, or asking ffmpeg to extract embedded tracks) and hands the cues to
 * the sidebar webview, which does the searching. The sidebar sends back the cue
 * to jump to.
 */

const { core, mpv, event, sidebar, menu, file, utils, preferences, console } = iina;
const subtitles = require("./src/subtitles.js");

// Subtitle codecs that are pictures, not text: there is nothing to search.
const IMAGE_CODECS = [
  "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "dvb_teletext", "xsub", "arib_caption",
];
// GUI apps do not inherit the shell PATH, so look where package managers put ffmpeg.
const FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];
const MAX_SUBTITLE_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_TRACKS = 8;
const POSITION_INTERVAL_MS = 300;
const REFRESH_DELAY_MS = 150;

let sidebarLoaded = false;
/*
 * Whether our tab is on screen. IINA has no API for this (core.window.sidebar
 * only knows its own tabs), so the page reports its own visibility: the webview
 * is taken out of the window when the sidebar closes or shows another tab.
 */
let sidebarVisible = false;
/** Track picked in the sidebar; null means "follow the track IINA is showing". */
let pinnedTrackId = null;
let tracks = [];
let currentTrackId = null;
/** What the sidebar should display besides the cues themselves. */
let view = { status: "idle" };

let cues = [];
let cuesVersion = 0;
/** Identifies the track whose cues are loaded (or being loaded). */
let loadedKey = null;
let loadSerial = 0;
let extractSerial = 0;
const cache = {};
const cacheOrder = [];

let refreshTimer = null;
let positionTimer = null;
let lastActiveIndex = -1;

// ---------------------------------------------------------------------------
// Talking to the sidebar
// ---------------------------------------------------------------------------

/*
 * IINA pastes the JSON of a message into a JavaScript template literal, so a
 * backtick or "${" in a subtitle line would break the message. Percent-encoding
 * the payload keeps it to characters that are safe there.
 */
function post(name, data) {
  if (!sidebarLoaded) return;
  sidebar.postMessage(name, { payload: encodeURIComponent(JSON.stringify(data)) });
}

function pushState() {
  const activeId = activeSubtitleId();
  post("state", {
    status: view.status,
    code: view.code || null,
    detail: view.detail || null,
    tracks: tracks.map((t) => ({ id: t.id, label: trackLabel(t), active: t.id === activeId })),
    trackId: currentTrackId,
    cuesVersion: cuesVersion,
    delay: subtitleDelay(),
  });
}

function pushCues() {
  post("cues", {
    version: cuesVersion,
    cues: cues.map((c) => [c.start, c.end, c.text]),
  });
  lastActiveIndex = -1;
  pushPosition(true);
}

function pushPosition(force) {
  let index = -1;
  if (cues.length) {
    index = subtitles.findCueIndexAt(cues, mpv.getNumber("time-pos") - subtitleDelay());
  }
  if (force || index !== lastActiveIndex) {
    lastActiveIndex = index;
    post("position", { version: cuesVersion, index: index });
  }
}

function setCues(newCues) {
  cues = newCues;
  cuesVersion += 1;
  pushCues();
  if (cues.length && positionTimer === null) {
    positionTimer = setInterval(() => pushPosition(false), POSITION_INTERVAL_MS);
  } else if (!cues.length && positionTimer !== null) {
    clearInterval(positionTimer);
    positionTimer = null;
  }
}

function setView(newView) {
  view = newView;
  pushState();
}

// ---------------------------------------------------------------------------
// Player state
// ---------------------------------------------------------------------------

function subtitleDelay() {
  const delay = mpv.getNumber("sub-delay");
  return typeof delay === "number" && isFinite(delay) ? delay : 0;
}

function activeSubtitleId() {
  const sid = parseInt(mpv.getString("sid"), 10);
  return isNaN(sid) ? null : sid;
}

/** Turn an mpv path into a local file path, or null for network resources. */
function localPath(path) {
  if (!path) return null;
  if (path.indexOf("file://") === 0) {
    try {
      return decodeURIComponent(path.slice("file://".length));
    } catch (e) {
      return null;
    }
  }
  return path.charAt(0) === "/" ? path : null;
}

function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extension(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function getSubtitleTracks() {
  let list = null;
  try {
    list = mpv.getNative("track-list");
  } catch (e) {
    console.warn("Could not read track-list: " + e);
  }
  if (!Array.isArray(list)) return [];

  const result = [];
  let embeddedCount = 0;
  list.forEach((t) => {
    if (!t || t.type !== "sub") return;
    const externalFilename = t["external-filename"] || "";
    result.push({
      id: t.id,
      title: t.title || "",
      lang: t.lang || "",
      codec: t.codec || "",
      externalFilename: externalFilename,
      ffIndex: typeof t["ff-index"] === "number" ? t["ff-index"] : null,
      // Position among the subtitle streams of the media file, for "-map 0:s:N".
      embeddedIndex: externalFilename ? null : embeddedCount++,
    });
  });
  return result;
}

function trackLabel(track) {
  let name = track.title;
  if (!name && track.externalFilename) name = baseName(track.externalFilename);
  if (!name) name = "Track " + track.id;
  const lang = track.lang ? track.lang.toUpperCase() + " · " : "";
  const note = IMAGE_CODECS.indexOf(track.codec) !== -1 ? " (image-based)" : "";
  return lang + name + note;
}

function trackKey(track) {
  return [
    mpv.getString("path") || "",
    track.id,
    track.externalFilename || "stream:" + track.ffIndex,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reading subtitles
// ---------------------------------------------------------------------------

function failure(code, detail) {
  const error = new Error(code);
  error.code = code;
  error.detail = detail || null;
  return error;
}

function readBytes(path) {
  let handle = null;
  try {
    handle = file.handle(path, "read");
  } catch (e) {
    handle = null;
  }
  if (!handle) throw failure("unreadable", path);
  try {
    handle.seekToEnd();
    if (handle.offset() > MAX_SUBTITLE_BYTES) throw failure("too-large", path);
    handle.seekTo(0);
    const bytes = handle.readToEnd();
    if (!bytes) throw failure("unreadable", path);
    return bytes;
  } finally {
    handle.close();
  }
}

function fileExists(path) {
  try {
    return !!file.exists(path);
  } catch (e) {
    return false;
  }
}

function findFfmpeg() {
  let custom = String(preferences.get("ffmpegPath") || "").trim();
  if (custom.indexOf("~/") === 0) custom = utils.resolvePath(custom) || "";
  if (custom && fileExists(custom)) return custom;
  for (let i = 0; i < FFMPEG_CANDIDATES.length; i++) {
    if (fileExists(FFMPEG_CANDIDATES[i])) return FFMPEG_CANDIDATES[i];
  }
  return null;
}

function lastLines(text, count) {
  return String(text || "").trim().split("\n").slice(-count).join("\n");
}

/** Convert a subtitle stream of `source` to text with ffmpeg and parse the result. */
async function extractWithFfmpeg(source, track) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw failure("ffmpeg-missing");

  // ASS is copied as is, so that our parser can drop its vector drawings;
  // everything else is converted to SubRip.
  const isAss = track.codec === "ass" || track.codec === "ssa";
  const name = "extract-" + Date.now() + "-" + (extractSerial += 1) + (isAss ? ".ass" : ".srt");
  const outPath = utils.resolvePath("@tmp/" + name);
  if (!outPath) throw failure("ffmpeg-failed", "Could not resolve the temporary folder.");

  const stream =
    track.ffIndex !== null ? "0:" + track.ffIndex : "0:s:" + (track.embeddedIndex || 0);
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-map", stream]
    .concat(isAss ? ["-c:s", "copy", "-f", "ass"] : ["-f", "srt"])
    .concat([outPath]);

  let result = null;
  let runError = null;
  try {
    result = await utils.exec(ffmpeg, args);
  } catch (e) {
    runError = e;
  }

  try {
    if (!result) throw failure("ffmpeg-failed", runError ? String(runError) : "ffmpeg did not run.");
    if (result.status !== 0 || !fileExists(outPath)) {
      throw failure("ffmpeg-failed", lastLines(result.stderr, 4) || "Exit status " + result.status);
    }
    return subtitles.parseSubtitles(subtitles.decodeBytes(readBytes(outPath)));
  } finally {
    try {
      if (fileExists(outPath)) file.delete("@tmp/" + name);
    } catch (e) {
      // A leftover file in the temporary folder is harmless.
    }
  }
}

async function readTrack(track) {
  if (IMAGE_CODECS.indexOf(track.codec) !== -1) throw failure("image");

  if (track.externalFilename) {
    const subtitlePath = localPath(track.externalFilename);
    if (!subtitlePath) throw failure("remote");
    if (subtitles.NATIVE_EXTENSIONS.indexOf(extension(subtitlePath)) !== -1) {
      const parsed = subtitles.parseSubtitles(subtitles.decodeBytes(readBytes(subtitlePath)));
      if (parsed.length || !findFfmpeg()) return parsed;
      // Nothing recognised: the file may not be what its extension says.
    }
    return extractWithFfmpeg(subtitlePath, track);
  }

  const mediaPath = localPath(mpv.getString("path"));
  if (!mediaPath) throw failure("remote");
  return extractWithFfmpeg(mediaPath, track);
}

function remember(key, value) {
  if (!Object.prototype.hasOwnProperty.call(cache, key)) cacheOrder.push(key);
  cache[key] = value;
  while (cacheOrder.length > MAX_CACHED_TRACKS) delete cache[cacheOrder.shift()];
}

function loadTrack(track) {
  const key = trackKey(track);
  currentTrackId = track.id;
  if (key === loadedKey) {
    pushState();
    return;
  }
  loadedKey = key;
  const serial = (loadSerial += 1);

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    setCues(cache[key]);
    setView({ status: cache[key].length ? "ready" : "empty" });
    return;
  }

  setCues([]);
  const needsFfmpeg =
    !track.externalFilename ||
    subtitles.NATIVE_EXTENSIONS.indexOf(extension(track.externalFilename)) === -1;
  setView({ status: "loading", code: needsFfmpeg ? "extracting" : "reading" });

  readTrack(track).then(
    (result) => {
      if (serial !== loadSerial) return;
      remember(key, result);
      setCues(result);
      setView({ status: result.length ? "ready" : "empty" });
    },
    (error) => {
      if (serial !== loadSerial) return;
      const code = error && error.code ? error.code : "unknown";
      const detail = error && error.code ? error.detail : String(error);
      console.error("Could not load subtitle track " + track.id + ": " + code + " " + (detail || ""));
      setView({ status: "error", code: code, detail: detail });
    },
  );
}

function reset(status) {
  loadSerial += 1;
  loadedKey = null;
  currentTrackId = null;
  if (cues.length) setCues([]);
  setView({ status: status });
}

/** Work out which track to show and (re)load it if it changed. */
function refresh() {
  refreshTimer = null;
  if (mpv.getFlag("idle-active")) {
    tracks = [];
    pinnedTrackId = null;
    reset("idle");
    return;
  }

  tracks = getSubtitleTracks();
  if (!tracks.length) {
    reset("no-subtitles");
    return;
  }

  const byId = (id) => tracks.filter((t) => t.id === id)[0];
  if (pinnedTrackId !== null && !byId(pinnedTrackId)) pinnedTrackId = null;

  const target =
    (pinnedTrackId !== null && byId(pinnedTrackId)) ||
    byId(activeSubtitleId()) ||
    tracks.filter((t) => IMAGE_CODECS.indexOf(t.codec) === -1)[0] ||
    tracks[0];
  loadTrack(target);
}

function scheduleRefresh() {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, REFRESH_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Sidebar wiring
// ---------------------------------------------------------------------------

function setUpSidebar() {
  if (sidebarLoaded || !core.window.loaded) return;
  sidebar.loadFile("ui/sidebar.html");
  sidebarLoaded = true;

  // Sent when the page has loaded (and again if the user reloads the webview).
  sidebar.onMessage("ready", () => {
    pushCues();
    pushState();
    scheduleRefresh();
  });

  sidebar.onMessage("seek", (data) => {
    if (!data || data.version !== cuesVersion) return;
    const cue = cues[data.index];
    if (!cue) return;
    const leadIn = Math.max(0, Number(preferences.get("leadIn")) || 0);
    core.seekTo(Math.max(0, cue.start + subtitleDelay() - leadIn));
  });

  sidebar.onMessage("select-track", (data) => {
    if (!data || typeof data.id !== "number") return;
    // Picking the track IINA is showing goes back to following IINA's selection.
    pinnedTrackId = data.id === activeSubtitleId() ? null : data.id;
    refresh();
  });

  sidebar.onMessage("visibility", (data) => {
    sidebarVisible = !!(data && data.visible);
  });

  sidebar.onMessage("reload", () => {
    if (loadedKey !== null) delete cache[loadedKey];
    loadedKey = null;
    refresh();
  });
}

/** Menu item / shortcut: open the search tab, or close it when it is already showing. */
function toggleSearch() {
  if (!core.window.loaded) return;
  setUpSidebar();
  if (sidebarVisible) {
    // Assume it worked rather than wait for the page to confirm: if a report ever
    // goes missing, the next press opens the tab instead of doing nothing again.
    sidebarVisible = false;
    sidebar.hide();
    return;
  }
  // The search field is deliberately not focused from here: a plugin cannot hand the
  // keyboard to its webview, so the field would only look focused while keys still
  // went to the player. It takes focus when the user clicks it.
  sidebar.show();
}

// The window already exists when the plugin is enabled or reloaded mid-session.
if (core.window.loaded) {
  setUpSidebar();
  scheduleRefresh();
}
event.on("iina.window-loaded", () => {
  setUpSidebar();
  scheduleRefresh();
});

event.on("iina.file-loaded", () => {
  pinnedTrackId = null;
  scheduleRefresh();
});
event.on("mpv.track-list.changed", scheduleRefresh);
event.on("mpv.sid.changed", scheduleRefresh);
event.on("mpv.end-file", scheduleRefresh);
event.on("mpv.idle-active.changed", scheduleRefresh);
event.on("mpv.sub-delay.changed", () => {
  pushState();
  pushPosition(false);
});

const shortcut = String(preferences.get("shortcut") || "").trim();
menu.addItem(
  menu.item("Search Subtitles…", toggleSearch, shortcut ? { keyBinding: shortcut } : {}),
);
