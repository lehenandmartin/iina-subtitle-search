/*
 * Sidebar webview: receives the cues from the plugin script, searches them
 * locally and asks the plugin to seek when a line is chosen.
 */
(function () {
  "use strict";

  var search = window.SubtitleSearch;
  var bridge = window.iina;

  // Rendering more rows than this makes the list sluggish; nobody scrolls that far anyway.
  var MAX_ROWS = 5000;
  var INPUT_DELAY_MS = 60;
  // After the user scrolls the list, leave it alone for a while.
  var AUTO_SCROLL_PAUSE_MS = 4000;

  var el = {
    query: document.getElementById("query"),
    clear: document.getElementById("clear"),
    summary: document.getElementById("summary"),
    track: document.getElementById("track"),
    list: document.getElementById("list"),
    notice: document.getElementById("notice"),
    noticeTitle: document.getElementById("notice-title"),
    noticeBody: document.getElementById("notice-body"),
    noticeDetail: document.getElementById("notice-detail"),
    retry: document.getElementById("retry"),
  };

  var state = { status: "idle", code: null, detail: null, tracks: [], trackId: null, delay: 0 };
  var cues = [];
  var norms = [];
  var cuesVersion = -1;

  var terms = [];
  /** True when the query's words were found, but not next to each other as typed. */
  var anyOrder = false;
  /** Indices (into `cues`) of the lines currently listed. */
  var rows = [];
  var rowElements = {};
  /** Position in `rows` of the keyboard selection, or -1. */
  var selected = -1;
  /** Position in `rows` last jumped to with Return, so Return again moves on. */
  var jumped = -1;
  /** Index (into `cues`) of the line on screen in the player, or -1. */
  var activeIndex = -1;

  var inputTimer = null;
  var lastUserScroll = 0;

  var NOTICES = {
    idle: ["No video playing", "Open a video to search its subtitles."],
    "no-subtitles": [
      "No subtitles",
      "This video has no subtitle track. Load a subtitle file or pick one from the Subtitles menu.",
    ],
    reading: ["Reading subtitles…", ""],
    extracting: [
      "Extracting subtitles…",
      "Embedded subtitles are read from the video file. This can take a moment for large files.",
    ],
    empty: ["No text in this track", "This subtitle track does not contain any text lines."],
    image: [
      "Image-based subtitles",
      "This track stores its subtitles as pictures (Blu-ray PGS, DVD VobSub…), so there is no " +
        "text to search. Pick another track or load a text subtitle file.",
    ],
    remote: [
      "Not available for streams",
      "Subtitles can only be read from files on this Mac. Subtitle files loaded from disk " +
        "work even when the video itself is streamed.",
    ],
    "ffmpeg-missing": [
      "ffmpeg is needed for this track",
      "Subtitles embedded in the video file are extracted with ffmpeg, which was not found. " +
        "Install it (with Homebrew: brew install ffmpeg) or set its location in the plugin’s " +
        "preferences, then try again. Separate subtitle files (.srt, .ass, .vtt) work without it.",
    ],
    "ffmpeg-failed": ["Could not extract the subtitles", "ffmpeg reported an error:"],
    unreadable: ["Could not read the subtitle file", ""],
    "too-large": ["Subtitle file is too large", "Files over 32 MB are not loaded."],
    unknown: ["Something went wrong", ""],
  };

  // -------------------------------------------------------------------------
  // Bridge
  // -------------------------------------------------------------------------

  function send(name, data) {
    if (bridge) bridge.postMessage(name, data || {});
  }

  /* Payloads are percent-encoded by the plugin script; see post() in main.js. */
  function receive(name, handler) {
    if (!bridge) return;
    bridge.onMessage(name, function (message) {
      var data;
      try {
        data = JSON.parse(decodeURIComponent(message.payload));
      } catch (e) {
        return;
      }
      handler(data);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function showNotice(key, detail, canRetry) {
    var text = NOTICES[key] || NOTICES.unknown;
    el.noticeTitle.textContent = text[0];
    el.noticeBody.textContent = text[1];
    el.noticeBody.hidden = !text[1];
    el.noticeDetail.textContent = detail || "";
    el.noticeDetail.hidden = !detail;
    el.retry.hidden = !canRetry;
    el.notice.hidden = false;
    el.list.hidden = true;
  }

  function appendHighlighted(parent, text) {
    var ranges = search.highlightRanges(text, terms);
    var position = 0;
    for (var i = 0; i < ranges.length; i++) {
      var start = ranges[i][0];
      var end = ranges[i][1];
      if (start > position) parent.appendChild(document.createTextNode(text.slice(position, start)));
      var mark = document.createElement("mark");
      mark.textContent = text.slice(start, end);
      parent.appendChild(mark);
      position = end;
    }
    if (position < text.length) parent.appendChild(document.createTextNode(text.slice(position)));
  }

  function renderList() {
    var fragment = document.createDocumentFragment();
    var withHours = cues.length > 0 && cues[cues.length - 1].start + state.delay >= 3600;
    var count = Math.min(rows.length, MAX_ROWS);
    rowElements = {};

    for (var r = 0; r < count; r++) {
      var index = rows[r];
      var cue = cues[index];
      var row = document.createElement("div");
      row.className = "row";
      row.setAttribute("role", "option");
      row.dataset.row = String(r);

      var time = document.createElement("span");
      time.className = "time";
      time.textContent = search.formatTime(cue.start + state.delay, withHours);

      var text = document.createElement("span");
      text.className = "text";
      if (terms.length) {
        appendHighlighted(text, cue.text);
      } else {
        text.textContent = cue.text;
      }

      row.appendChild(time);
      row.appendChild(text);
      fragment.appendChild(row);
      rowElements[index] = row;
    }

    if (rows.length > count) {
      var more = document.createElement("div");
      more.className = "more";
      more.textContent =
        "Showing the first " + count.toLocaleString() + " of " + rows.length.toLocaleString() +
        " lines. Refine the search to see the rest.";
      fragment.appendChild(more);
    }

    el.list.textContent = "";
    el.list.appendChild(fragment);
    el.list.scrollTop = 0;
  }

  function markRows() {
    var previous = el.list.querySelectorAll(".row.selected, .row.active");
    for (var i = 0; i < previous.length; i++) previous[i].classList.remove("selected", "active");

    var selectedRow = selected >= 0 ? rowElements[rows[selected]] : null;
    if (selectedRow) selectedRow.classList.add("selected");
    var activeRow = activeIndex >= 0 ? rowElements[activeIndex] : null;
    if (activeRow) activeRow.classList.add("active");
  }

  function scrollTo(row, block, smooth) {
    if (row) row.scrollIntoView({ block: block, behavior: smooth ? "smooth" : "auto" });
  }

  function render() {
    var ready = state.status === "ready" && cues.length > 0;
    el.query.disabled = !ready;
    el.clear.hidden = !el.query.value;
    renderTracks();

    if (!ready) {
      el.summary.textContent = "";
      if (state.status === "loading") {
        showNotice(state.code === "extracting" ? "extracting" : "reading");
      } else if (state.status === "error") {
        showNotice(state.code || "unknown", state.detail, true);
      } else {
        // "ready" with no cues yet means the cues message is still on its way.
        showNotice(state.status === "ready" ? "reading" : state.status);
      }
      return;
    }

    if (terms.length) {
      el.summary.textContent =
        (rows.length === 1 ? "1 match" : rows.length.toLocaleString() + " matches") +
        (anyOrder ? " · any order" : "");
    } else {
      el.summary.textContent = cues.length === 1 ? "1 line" : cues.length.toLocaleString() + " lines";
    }

    if (!rows.length) {
      el.noticeTitle.textContent = "No matches";
      el.noticeBody.textContent = "No subtitle line contains “" + el.query.value.trim() + "”.";
      el.noticeBody.hidden = false;
      el.noticeDetail.hidden = true;
      el.retry.hidden = true;
      el.notice.hidden = false;
      el.list.hidden = true;
      return;
    }

    el.notice.hidden = true;
    el.list.hidden = false;
    renderList();
    markRows();
    if (terms.length) {
      scrollTo(rowElements[rows[selected]], "nearest", false);
    } else {
      scrollTo(rowElements[activeIndex], "center", false);
    }
  }

  function renderTracks() {
    var tracks = state.tracks || [];
    el.track.hidden = tracks.length < 2;
    var signature = JSON.stringify(tracks);
    if (el.track.dataset.signature !== signature) {
      el.track.dataset.signature = signature;
      el.track.textContent = "";
      tracks.forEach(function (track) {
        var option = document.createElement("option");
        option.value = String(track.id);
        option.textContent = track.label + (track.active ? " (shown)" : "");
        el.track.appendChild(option);
      });
    }
    if (state.trackId !== null && state.trackId !== undefined) el.track.value = String(state.trackId);
  }

  /** Recompute the listed rows from the query and redraw. */
  function update() {
    var found = search.find(norms, el.query.value);
    terms = found.terms;
    anyOrder = found.anyOrder && found.rows.length > 0;
    if (terms.length) {
      rows = found.rows;
      selected = rows.length ? 0 : -1;
    } else {
      rows = cues.map(function (cue, index) { return index; });
      selected = -1;
    }
    jumped = -1;
    render();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function seekToRow(position) {
    if (position < 0 || position >= rows.length) return;
    selected = position;
    jumped = position;
    markRows();
    scrollTo(rowElements[rows[position]], "nearest", false);
    send("seek", { version: cuesVersion, index: rows[position] });
  }

  function moveSelection(step) {
    var visible = Math.min(rows.length, MAX_ROWS);
    if (!visible) return;
    if (selected < 0) {
      // Start from the line being played, when there is one in the list.
      var from = rows.indexOf(activeIndex);
      selected = from >= 0 && from < visible ? from : step > 0 ? 0 : visible - 1;
    } else {
      selected = (selected + step + visible) % visible;
    }
    markRows();
    scrollTo(rowElements[rows[selected]], "nearest", false);
  }

  /** Return: jump to the selection; pressed again, walk through the results. */
  function jumpWithKeyboard(step) {
    var visible = Math.min(rows.length, MAX_ROWS);
    if (!visible) return;
    if (selected < 0) {
      moveSelection(step);
    } else if (jumped === selected) {
      selected = (selected + step + visible) % visible;
    }
    seekToRow(selected);
  }

  function clearQuery() {
    el.query.value = "";
    update();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  // See the note on #query.engaged in sidebar.css.
  function engage() {
    el.query.classList.add("engaged");
  }
  el.query.addEventListener("mousedown", engage);
  el.query.addEventListener("keydown", engage);
  el.query.addEventListener("blur", function () {
    el.query.classList.remove("engaged");
  });

  el.query.addEventListener("input", function () {
    el.clear.hidden = !el.query.value;
    if (inputTimer !== null) clearTimeout(inputTimer);
    inputTimer = setTimeout(function () {
      inputTimer = null;
      update();
    }, INPUT_DELAY_MS);
  });

  el.query.addEventListener("keydown", function (event) {
    if (event.isComposing) return;
    if (inputTimer !== null && (event.key === "Enter" || event.key.indexOf("Arrow") === 0)) {
      clearTimeout(inputTimer);
      inputTimer = null;
      update();
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        break;
      case "Enter":
        event.preventDefault();
        jumpWithKeyboard(event.shiftKey ? -1 : 1);
        break;
      case "Escape":
        event.preventDefault();
        if (el.query.value) {
          clearQuery();
        } else {
          // Hand the keyboard back to the player.
          el.query.blur();
        }
        break;
      default:
        break;
    }
  });

  el.clear.addEventListener("click", function () {
    clearQuery();
    engage();
    el.query.focus();
  });

  // Keep clicks on the list from moving focus or starting a text selection.
  el.list.addEventListener("mousedown", function (event) {
    event.preventDefault();
  });

  el.list.addEventListener("click", function (event) {
    var row = event.target.closest ? event.target.closest(".row") : null;
    if (!row) return;
    seekToRow(Number(row.dataset.row));
    // Let Space, arrows and the other player shortcuts work again right away.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });

  el.list.addEventListener("wheel", function () {
    lastUserScroll = Date.now();
  }, { passive: true });

  el.track.addEventListener("change", function () {
    send("select-track", { id: Number(el.track.value) });
    el.track.blur();
  });

  el.retry.addEventListener("click", function () {
    send("reload");
  });

  // -------------------------------------------------------------------------
  // Messages from the plugin script
  // -------------------------------------------------------------------------

  receive("cues", function (data) {
    cuesVersion = data.version;
    cues = (data.cues || []).map(function (c) {
      return { start: c[0], end: c[1], text: c[2] };
    });
    norms = cues.map(function (cue) { return search.fold(cue.text); });
    activeIndex = -1;
    update();
  });

  receive("state", function (data) {
    var previous = state;
    state = data;
    var listUnchanged =
      previous.status === data.status &&
      previous.code === data.code &&
      previous.detail === data.detail &&
      previous.delay === data.delay;
    if (listUnchanged) {
      // Only the track list or selection changed: keep the list and its scroll position.
      renderTracks();
    } else {
      render();
    }
  });

  receive("position", function (data) {
    if (data.version !== cuesVersion || data.index === activeIndex) return;
    activeIndex = data.index;
    markRows();
    // Follow playback while browsing the full transcript, unless the user is scrolling.
    if (!terms.length && Date.now() - lastUserScroll > AUTO_SCROLL_PAUSE_MS) {
      scrollTo(rowElements[activeIndex], "center", true);
    }
  });

  /*
   * Tell the plugin script whether this tab is on screen, so that its shortcut
   * can close the sidebar when it is already open. IINA takes the webview out
   * of the window when the sidebar closes or switches to another plugin's tab.
   */
  function reportVisibility() {
    var visible = document.visibilityState === "visible";
    // The keyboard goes back to the player when the tab goes away; do not come
    // back later with a field that still looks focused.
    if (!visible) el.query.blur();
    send("visibility", { visible: visible });
  }
  document.addEventListener("visibilitychange", reportVisibility);

  render();
  send("ready");
  reportVisibility();
})();
