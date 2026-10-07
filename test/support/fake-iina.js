"use strict";

/*
 * A stand-in for the IINA plugin runtime, close enough to run main.js under
 * Node: the same require() wrapper, the same way of pasting sidebar messages
 * into a template literal, and file/exec APIs backed by the real file system.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFile } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");

/** What IINA does to a message on its way to the webview (JavascriptMessageHub.swift). */
function throughBridge(data) {
  const json = JSON.stringify(data);
  const received = vm.runInNewContext("String.raw`" + json + "`");
  return JSON.parse(received);
}

function createPlayer(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "iina-subtitle-search-"));
  const player = {
    props: Object.assign(
      { "idle-active": true, "track-list": [], sid: "no", path: "", "sub-delay": 0, "time-pos": 0 },
      options.props,
    ),
    prefs: Object.assign({ ffmpegPath: "", leadIn: 0, shortcut: "Meta+f" }, options.prefs),
    windowLoaded: false,
    hideFfmpeg: !!options.hideFfmpeg,
    loadedPage: null,
    sidebarShown: 0,
    sidebarHidden: 0,
    seeks: [],
    menuItems: [],
    execCalls: [],
    messages: [],
    logs: [],
    tmpDir,
  };

  const eventListeners = {};
  let sidebarListeners = {};
  const intervals = new Set();
  const timeouts = new Set();

  const resolvePath = (p) => (p.startsWith("@tmp/") ? path.join(tmpDir, p.slice(5)) : p);
  const exists = (p) => {
    if (player.hideFfmpeg && p.endsWith("/ffmpeg")) return false;
    return fs.existsSync(resolvePath(p));
  };

  const iina = {
    core: {
      window: {
        get loaded() {
          return player.windowLoaded;
        },
      },
      seekTo: (seconds) => player.seeks.push(seconds),
    },
    mpv: {
      getFlag: (name) => !!player.props[name],
      getNumber: (name) => Number(player.props[name]) || 0,
      getString: (name) => (player.props[name] == null ? null : String(player.props[name])),
      getNative: (name) => player.props[name],
    },
    event: {
      on(name, callback) {
        (eventListeners[name] = eventListeners[name] || []).push(callback);
        return name + "#" + eventListeners[name].length;
      },
    },
    sidebar: {
      loadFile(page) {
        if (!player.windowLoaded) throw new Error("sidebar.loadFile called when window is not available");
        player.loadedPage = page;
        sidebarListeners = {};
      },
      show() {
        player.sidebarShown += 1;
      },
      hide() {
        player.sidebarHidden += 1;
      },
      postMessage(name, data) {
        const message = throughBridge(data);
        player.messages.push({ name, data: JSON.parse(decodeURIComponent(message.payload)) });
      },
      onMessage(name, callback) {
        sidebarListeners[name] = callback;
      },
    },
    menu: {
      item: (title, action, itemOptions) => ({ title, action, options: itemOptions }),
      addItem: (item) => player.menuItems.push(item),
    },
    file: {
      exists,
      handle(p, mode) {
        if (mode !== "read") throw new Error("only read mode is faked");
        const buffer = fs.readFileSync(resolvePath(p));
        let position = 0;
        return {
          offset: () => position,
          seekTo: (offset) => { position = offset; },
          seekToEnd: () => { position = buffer.length; },
          readToEnd: () => new Uint8Array(buffer.subarray(position)),
          close() {},
        };
      },
      delete: (p) => fs.unlinkSync(resolvePath(p)),
    },
    utils: {
      resolvePath,
      exec(file, args) {
        player.execCalls.push({ file, args });
        return new Promise((resolve, reject) => {
          if (!fs.existsSync(file)) {
            reject(-1);
            return;
          }
          execFile(file, args, (error, stdout, stderr) => {
            resolve({ status: error ? error.code || 1 : 0, stdout, stderr });
          });
        });
      },
    },
    preferences: { get: (key) => player.prefs[key] },
    console: {
      log: (...a) => player.logs.push(a.join(" ")),
      warn: (...a) => player.logs.push(a.join(" ")),
      error: (...a) => player.logs.push(a.join(" ")),
    },
  };

  // IINA's require(): the file is wrapped in a function with a bare `module` object.
  const context = vm.createContext({
    iina,
    setTimeout: (fn, ms) => { const t = setTimeout(() => { timeouts.delete(t); fn(); }, ms); timeouts.add(t); return t; },
    clearTimeout: (t) => { timeouts.delete(t); clearTimeout(t); },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); intervals.add(t); return t; },
    clearInterval: (t) => { intervals.delete(t); clearInterval(t); },
  });
  context.require = (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    return vm.runInContext(
      "(function() {\nconst module = {};\n" + source + "\nreturn module.exports;\n})();",
      context,
      { filename: file },
    );
  };

  Object.assign(player, {
    /** Load main.js, as IINA does when the player is created. */
    start() {
      vm.runInContext(fs.readFileSync(path.join(ROOT, "main.js"), "utf8"), context, { filename: "main.js" });
      return player;
    },
    emit(name) {
      (eventListeners[name] || []).forEach((callback) => callback());
    },
    /** A message from the sidebar webview, as IINA would deliver it. */
    fromSidebar(name, data) {
      const json = JSON.stringify(data);
      const callback = sidebarListeners[name];
      if (!callback) throw new Error("No sidebar listener for " + name);
      if (json === undefined) callback();
      else callback(JSON.parse(json));
    },
    openWindow() {
      player.windowLoaded = true;
      player.emit("iina.window-loaded");
    },
    openFile(props) {
      Object.assign(player.props, { "idle-active": false }, props);
      player.emit("iina.file-loaded");
      player.emit("mpv.track-list.changed");
    },
    last(name) {
      for (let i = player.messages.length - 1; i >= 0; i--) {
        if (player.messages[i].name === name) return player.messages[i].data;
      }
      return null;
    },
    /** Wait until the sidebar has been told about a state matching `predicate`. */
    async waitForState(predicate, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = player.last("state");
        if (state && predicate(state)) return state;
        if (Date.now() > deadline) {
          throw new Error("Timed out; last state: " + JSON.stringify(state) + "\n" + player.logs.join("\n"));
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    dispose() {
      intervals.forEach((t) => clearInterval(t));
      timeouts.forEach((t) => clearTimeout(t));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  });
  return player;
}

module.exports = { createPlayer, throughBridge };
