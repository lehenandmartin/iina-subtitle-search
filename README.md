# Subtitle Search for IINA

An [IINA](https://iina.io) plugin that lets you search the subtitles of the video you are
watching and jump straight to the line you were looking for.

It adds a **Subtitle Search** tab to IINA's sidebar. Type a few words, pick a line, and playback
moves to that moment.

## Features

- Search as you type, ignoring case and accents: `cafe` finds "Café", `coeur` finds "cœur".
- Click a result, or press <kbd>Return</kbd>, to jump to the exact moment the line appears.
- Leave the search field empty to browse the whole transcript; the line being spoken is marked and
  the list follows playback.
- Works with external subtitle files (`.srt`, `.vtt`, `.ass`, `.ssa`) and, with ffmpeg installed,
  with text subtitles embedded in the video (MKV, MP4, …).
- Search any subtitle track of the video, not only the one being displayed.
- Takes IINA's subtitle delay into account.

## Requirements

- IINA 1.4.0 or later.
- [ffmpeg](https://ffmpeg.org) — only for subtitles embedded in the video file. Separate subtitle
  files need nothing extra. The easiest way to get it is [Homebrew](https://brew.sh):

  ```sh
  brew install ffmpeg
  ```

## Installation

**From GitHub:** in IINA, open *Settings › Plugins*, click *Install from GitHub…* and enter:

```
lehenandmartin/iina-subtitle-search
```

**From a file:** download `subtitle-search.iinaplgz` from the
[releases page](https://github.com/lehenandmartin/iina-subtitle-search/releases) and open it with IINA.

IINA lists the permission the plugin asks for (see [Permissions](#permissions)) before installing it.

## Usage

1. Play a video that has subtitles.
2. Choose *Plugin › Search Subtitles…* (<kbd>⌘F</kbd> by default), or open the plugin sidebar and
   select the *Subtitle Search* tab.
3. Click the search field and type.
4. Press <kbd>⌘F</kbd> again to close the sidebar.

| Key | Action |
| --- | --- |
| <kbd>↓</kbd> / <kbd>↑</kbd> | Select the next / previous result |
| <kbd>Return</kbd> | Jump to the selected result; press again to move on to the next one |
| <kbd>⇧ Return</kbd> | Jump to the previous result |
| <kbd>Esc</kbd> | Clear the search; press again to leave the search field |

While the search field has keyboard focus, keys are typed into it instead of controlling the
player. Clicking a result, or pressing <kbd>Esc</kbd> in an empty field, hands the keyboard back to
IINA, so <kbd>Space</kbd> and the arrow keys work as usual again.

### How matching works

- The text is first searched as you typed it: `good morning` finds lines containing "good morning".
- If no line contains it, lines containing all the words in any order are shown instead, and the
  result count says *any order*.
- Put words in double quotes to insist on an exact phrase: `"good morning" john` finds lines with
  the phrase "good morning" and the word "john".
- Matching is done on parts of words too: `phone` finds "telephone".

### Choosing a track

When the video has several subtitle tracks, a menu under the search field lets you pick the one to
search. By default it follows the track IINA is displaying. Picking another track only changes what
is searched — it does not change the subtitles shown on the video.

## Supported subtitles

| Subtitles | Supported | Notes |
| --- | --- | --- |
| External `.srt`, `.vtt`, `.ass`, `.ssa` | Yes | Read directly. UTF-8 and UTF-16 are detected; other files are read as Windows-1252. |
| Other external text formats | With ffmpeg | Anything ffmpeg can convert to text. |
| Embedded text tracks (SubRip, ASS, MP4 timed text, WebVTT…) | With ffmpeg | The track is extracted from the video file, which can take a moment for large files. Results are kept in memory, so it happens once per track. |
| Image-based tracks (Blu-ray PGS, DVD VobSub, DVB) | No | These are pictures of text; there is nothing to search. |
| Embedded tracks of online streams | No | External subtitle files still work when the video is streamed. |

## Preferences

In *Settings › Plugins › Subtitle Search › Preferences*:

- **Keyboard shortcut** that opens and closes the search tab, in mpv's key format (`Meta+f` is
  ⌘F). Leave it empty for no shortcut. Applies to new player windows.
- **Lead-in**: start playback a little before the selected line instead of exactly on it.
- **Location of ffmpeg**: only needed if ffmpeg is installed somewhere unusual. By default the
  plugin looks in `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` and `/usr/bin`.

## Permissions

The plugin asks for one permission:

- **File system access** — to read subtitle files from disk and to run ffmpeg on the video file
  when extracting an embedded track. Extracted subtitles are written to the plugin's temporary
  folder and deleted as soon as they have been read.

It makes no network requests.

## Limitations

- A plugin cannot move keyboard focus into the sidebar, so after opening the tab with the
  shortcut you have to click the search field before typing.
- Legacy subtitle files in encodings other than Windows-1252 (for example Cyrillic or CJK code
  pages) are not decoded correctly. Convert them to UTF-8 first.
- mpv's `sub-speed` option is not taken into account.

## Development

The plugin is plain JavaScript with no build step; the repository root is the plugin itself.

```
Info.json          Plugin manifest
main.js            Plugin script: finds the subtitle track, loads its cues, talks to the sidebar
src/subtitles.js   Text decoding and the SRT / WebVTT / ASS parsers
ui/                Sidebar webview (sidebar.html, sidebar.css, sidebar.js) and the search logic (search.js)
preferences.html   Preferences page
test/              Tests, run with Node
```

To load the working copy into IINA, link it into IINA's plugin folder and restart IINA:

```sh
ln -s "$PWD" ~/Library/Application\ Support/com.colliderli.iina/plugins/subtitle-search.iinaplugin-dev
```

Logs appear in *Window › Log Viewer* under the plugin's name, and the sidebar can be inspected with
Safari's Web Inspector (*Develop* menu).

Run the tests with Node 20 or later:

```sh
npm test
```

They cover the parsers, the search logic, and `main.js` running against a stand-in for IINA's
plugin runtime. The ffmpeg tests are skipped when ffmpeg is not installed.

Build an installable package:

```sh
npm run pack    # creates subtitle-search.iinaplgz
```

### Releasing

IINA finds updates through the `ghRepo` and `ghVersion` fields of `Info.json`.

1. Update `version` in `Info.json` and increase `ghVersion` by one.
2. Push to the `main` branch — IINA installs from, and checks for updates on, that branch.
3. Optionally attach `subtitle-search.iinaplgz` to a GitHub release; IINA prefers it over the
   source archive when installing from GitHub.

## About

This project was built with the assistance of [Claude](https://claude.ai), under the author's direction and review.

## License

[MIT](LICENSE) — © 2026 Martin Le Hénand
