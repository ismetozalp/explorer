# Changelog

All notable changes to the Explorer Cockpit plugin are recorded here.

## 4.3.0

- **JSON export for the code-census tables.** Two new buttons in the census
  header:
  - **JSON** — export the table you're currently viewing to
    `census-<table>.json` in a folder you pick (like the Report button), then
    open it in the preview pane.
  - **Zip all** — run the core analyses and export **every** table that has data
    as one JSON file each, bundled into `census-export.zip` (built with Python,
    so no `zip` binary is required).

## 4.2.2

- **Fixed the code-census Report button getting stuck disabled.** The button's
  “generating” state was cleared only on the success/cancel paths, so if an
  analysis threw (or the flow was interrupted) the busy flag stayed set and the
  button stayed disabled. Report generation now runs inside a single
  try/finally, so the button is always re-enabled when it finishes — however it
  finishes. (The flag was never persisted, so a stuck button also clears on
  reload.)

## 4.2.1

- **Code-census report: fixed the unreadable dependency-vulnerabilities table.**
  The scanner detail tables now clip each cell to its column's real (proportional-
  font) width, so long GHSA ids, package names and CVSS strings no longer overrun
  into the next column. The dependency severity now shows a short rating
  (`HIGH` / `MODERATE` / …, or a compact `CVSS V4` label) instead of the full
  CVSS vector string, in both the report and the pane.
- **Report button now shows a loading state** (“Generating…”, disabled) from the
  moment it's clicked — through the analyses and the folder dialog — so it's clear
  the report is being generated.

## 4.2.0

- **New: code-census pane in the AI view (`scc ▶`).** A quality dashboard powered
  by [`scc`](https://github.com/boyter/scc) plus a set of analyses, with a
  one-click PDF report. Pick an analysis from the dropdown:
  - **Language table** (sortable), **Complexity** (top-50 files; the number also
    shows next to every file in the repo tree), **Hotspots** (churn × complexity
    from git log), **Coverage** (from an existing lcov file), **TODO / FIXME**
    census, and **Scanners**: secrets (gitleaks), dependency vulnerabilities
    (osv-scanner), duplication (jscpd), per-function complexity (lizard).
  - **One-click installs.** Any missing tool shows an **Install** button that runs
    the right command for the host's Linux distro (native package, GitHub-release
    binary, npm or pip) as administrator, streaming the output.
  - **PDF report.** The **Report** button produces a multi-page *Code Census* PDF
    (cover stats, language table, composition charts, complexity + churn hotspots,
    a quality page, and a McCabe risk legend) — generated **server-side with plain
    Python**, no browser and no extra libraries. Saved git-ignored in the repo by
    default, or to a folder you pick.
  - **Optional background auto-refresh** via a per-repo **systemd user timer**
    (interval in Settings), enabled only after a consent prompt explaining exactly
    what it creates; the pane reloads when results update.
- **Inline Diff + Census panel in the file browser.** When a folder tab is inside
  a git repository, a thin *◈ repo* strip opens a right-hand panel with a
  **[Diff | Census]** toggle — the same live diff (with the changed-file strip and
  editor jumps) and the full code-census dashboard above, now without leaving the
  file manager. The panel roots at the repository toplevel, so it works from any
  subdirectory, and its diff refreshes live while the tab is in front.

## 4.1.0

- **New: repo tree panel in the AI view (`Terminal | Tree | Diff`).** A
  collapsible column (a thin *tree ▶* strip reveals it) that navigates the whole
  repository rooted at the session's git toplevel — folders **expand on demand**,
  so even large repos stay snappy. Each entry is **colored by git status**
  (modified = blue, added/new = green, untracked/not-in-repo = red; a folder
  containing changes is tinted too), **theme-aware**. A file row **shows its diff**
  in the diff pane (even a clean file focuses to its own "no changes" view rather
  than leaving an unrelated diff up), **👁** previews it, and **✎** opens it in the
  Monaco editor. The
  colors and listings refresh live alongside the diff — including on branch/commit
  switches — and re-list directories the agent adds to or deletes from.
- **AI session tabs now persist** across reloads and restarts, like your other
  tabs (Settings → *Restore tabs*). On next launch a **tmux**-backed session
  **re-attaches** to its live tmux session — the running `claude`/`codex` comes
  right back — or is re-created (running the CLI) if it's gone; a **shell**
  session **re-launches** the CLI (resuming when it was a resume, otherwise a
  fresh prompt). Restored tabs mount lazily when you switch to them, so they
  don't steal focus on startup.
- **Plugin Manager — *release notes ↗* link.** Each plugin row now links to that
  plugin's GitHub release page (the latest tag when known), opening in a new tab.
- **Fixes & hardening.**
  - Integrated terminals now size reliably — the mount waits on a
    `ResizeObserver` and resumes the instant the container gets a height, instead
    of a fixed 1-second poll that could time out and toast *"Terminal failed to
    size."* The per-terminal window-resize listener is now removed on **every**
    close path (including closing the tab), fixing a small listener leak.
  - Removed six dev-only source-map comments from vendored libraries (xterm,
    bootstrap, quill, monaco), silencing the `.map` 404s in the browser console.
  - **Security:** directory listing/search and the deep-link `#open=` param can no
    longer let a leading-dash path be read as a `find` expression; the AI folder
    picker's *New folder* rejects path components like `../`; the transcode cache
    directory is created **private (0700)**; and root-owned videos now transcode
    through the superuser bridge and read back through it, so they play without
    exposing content to other local users.
  - The editor's *save as administrator* retry now writes the **originally-edited
    file** even if you switched windows during a slow save. Directory loads and
    searches carry a per-tab generation token so an out-of-order response can't
    paint the wrong folder's files. Reading a file into the browser is capped at
    1 GiB so a stray large download can't hang the tab.

## 4.0.0

- **New: AI CLI tabs — Claude & Codex (`✦ AI`).** Run the `claude` and `codex`
  CLIs inside Explorer in an integrated terminal with a **live git working-tree
  diff** beside it that updates as the agent edits files.
  - **Sub-tab sessions:** each AI tab holds multiple sessions (like the terminal
    tab holds terminals) — add *New Claude* / *New Codex* / *Resume…*, each with
    its own terminal and diff; close/rename them. Detection runs in your login
    shell, so a CLI in `~/.local/bin` is found; the buttons only show for
    installed tools.
  - **Live diff pane:** `git diff` of the session's folder — **All / Unstaged /
    Staged**, including untracked files, unborn-HEAD-aware, bounded so a giant
    diff can't freeze the browser. **Syntax-colored with old/new line-number
    gutters**; a changed-files strip where you **click a file to isolate its
    diff** (several show back-to-back; *Show all* clears); each file's **✎** opens
    it in the **Monaco editor**; and **▶ / ◀ diff** hides/reveals the pane so the
    terminal can fill the tab. Runs from the repo toplevel with hardened,
    plain-format git output; polls ~1/s while visible (one request at a time,
    superseded results discarded) and self-heals when a folder becomes a repo or
    the session `cd`s to another one.
  - **Folder picker on start:** starting a new session opens a directory browser —
    breadcrumb navigation, an editable path, **search within a folder**, and
    **create-new-folder** — so the CLI starts exactly where you want.
  - **Move a running session in:** the terminal tab bar's **✦** button relocates a
    live `claude`/`codex` (shell or tmux) into the AI split view — same PTY, now
    with the diff pane (a tmux session's real working directory is resolved from
    its active pane).
  - **Launch in a shell or tmux** (Settings → *Run AI CLIs in*): a shell (you
    return to it when the CLI exits) or a persistent, named **tmux** session
    (attach-or-create). Resuming into tmux uses a session name unique to that
    resume so it always runs `--resume` instead of silently attaching elsewhere;
    generated names are sanitized to what tmux accepts. Closing a tmux-backed
    sub-tab or tab **asks whether to terminate the tmux session or keep it
    running**.
  - **Resume browser:** prior Claude/Codex sessions, **grouped by project folder**
    into disclosure panels — the header resumes the latest session in that folder,
    expanding lists each session to resume a specific one, and you can **delete a
    session or all of a project's sessions** (removes the transcript files). Read
    from each tool's own store — `~/.claude/projects` and `~/.codex/sessions`
    (paths **and scan depth** configurable in Settings) — with project folder,
    title and age; a loading spinner shows while scanning. **Every project appears
    with an accurate count** (Claude read one head per project directory, Codex
    per session), throwaway `/tmp` sessions are excluded, and resume uses the
    correct id per tool.
  - Opened from the `✦ AI ▾` toolbar button and the right-click **Open
    Claude/Codex here**. The CLIs run as you (no root).

  Reviewed across multiple codex delta + whole-codebase passes; all findings
  fixed — command-injection-safe launch via the terminal's `directory:` option,
  correct Codex rollout parsing, bounded per-directory registry reads,
  shell-matched detection, tmux/unavailable-CLI guards, Alpine reactive-proxy
  correctness for the live diff, poll-generation lifecycle, git-quoted &
  space-containing path handling, and color/prefix-hardened diff output.

## 3.3.1

- **Fixed: the Users & sudo panel now reflects a user's *effective* passwordless
  state.** A user made passwordless by a pre-existing `/etc/sudoers.d/<user>`
  file (not Explorer's own drop-in) previously showed “—” with the
  **Passwordless** button still active. Detection is now authoritative
  (`sudo -l -U`, run under `LC_ALL=C` so it isn't thrown off by a non-English
  locale): the badge reads `NOPASSWD` for an Explorer-managed grant and
  `NOPASSWD*` for one configured outside Explorer, and the toggle is disabled for
  external grants — which Explorer can't safely remove — instead of offering to
  “enable” what is already on. The `sudo` column stays group-based (what Grant /
  Revoke actually change), and turning off a managed rule now reports exactly
  what it removed.

## 3.3.0

- **New: Users & sudo management (`⛊ Users`).** Create local OS accounts,
  grant/revoke sudo, enable full passwordless sudo, and delete accounts from a
  single panel. Sudo is granted via the distro admin group (`wheel`/`sudo`,
  auto-detected from the sudoers policy); passwordless sudo writes a
  `visudo`-validated, app-managed `/etc/sudoers.d/90-explorer-<user>` drop-in
  (`NOPASSWD:ALL`) — `/etc/sudoers` and your own drop-ins are never edited, and
  an invalid file is never installed. Strict username validation; passwords go to
  `chpasswd` on stdin (never argv/logs); you can't revoke your own sudo or delete
  your own account; removing the last admin is warned; only local (`files`)
  accounts are listed. Delete is a distinct action with an opt-in
  “remove home directory” choice.

This release also included a full security/correctness review of the **wider
codebase** (not just the new feature), which fixed several pre-existing issues:

- **fstab and GRUB editors no longer risk wiping the file after a failed read.**
  If `/etc/fstab` or `/etc/default/grub` can't be read, the editor now shows the
  error and blocks Save (previously it silently opened empty and could overwrite
  the real file), including a re-check right before writing to close a
  reload-while-saving race.
- **GitHub auth hardening.** The access token is no longer passed on the `git`
  command line (moved into the process environment, so it can't be read from
  `/proc/<pid>/cmdline` by other local users), and an authenticated push/fetch
  only redirects to `github.com` when the checkout's origin is actually GitHub —
  never pushing a GitLab/Bitbucket/self-hosted repo to a same-named GitHub one.
- **Name fields reject path traversal.** Rename, new file/folder, and paste-as
  now refuse `/`, `.` and `..`, so an item can't be moved or created outside the
  folder shown.
- **`find` never parses a path as an expression.** A directory literally named
  `-delete`, `!`, or `(` can no longer be interpreted as a `find` operator.
- **Pasted clipboard media is kept private.** It's written into a `0700`
  directory the user owns (files `0600`), failing closed rather than into a
  directory another local user could have pre-created on a shared `/tmp`.
- **Compressing a cross-directory selection is rejected** instead of silently
  archiving the wrong files.
- **Persisted preview/editor windows reopen again** next session (the saved state
  was passed to the restorer in the wrong shape, so nothing reopened).
- **Dialog prompts resolve on dismissal** (Esc/backdrop) instead of hanging, and
  clear secret values afterward; password prompts are now masked.

## 3.2.2

- **The `/etc/shells` parsing from 3.2.1 is now a pure, unit-tested pair of
  helpers.** `_parseShells()` and `_pickDefaultShell()` moved out of
  `_initExtensions()`'s I/O into `js/core/settings.js`, matching the shape of
  the other parsers that feed keyed `x-for`s (`_parseSmbShares`,
  `_parseExports`). `tests/shells-unit.mjs` covers the reported duplicate line,
  the "no two entries are equal" invariant the markup depends on, comment and
  whitespace handling, tmux exclusion, and default-shell selection. No
  behaviour change from 3.2.1 for a normal `/etc/shells`.
- **Fixed: a `/etc/shells` that listed nothing but tmux left the shell list
  empty.** tmux is excluded from the list (the session manager drives it), and
  the exclusion used to run after the list was assigned — so a file offering
  only tmux emptied it, leaving `this.shells[0]` undefined for the terminal and
  Run-command paths. The fallback is now applied after exclusion, so the list is
  never empty; an unreadable, empty, comments-only, or tmux-only file keeps the
  built-in defaults.

## 3.2.1

- **Fixed: the plugin failed to load when `/etc/shells` listed the same shell
  twice.** The shell list is rendered by an `x-for` keyed on the shell path, so
  a repeated line produced two identical `:key` values; Alpine's keyed diff then
  worked from a stale node reference and threw `Cannot read properties of
  undefined (reading 'after')`. Because it happened during init the whole
  component died and Cockpit showed "Ooops!" instead of the file manager.
  `/etc/shells` is now de-duplicated when it is read, so the uniqueness the key
  depends on holds regardless of what the file contains. Reported as
  [#1](https://github.com/ismetozalp/explorer/issues/1), with the diagnosis and
  the fix, by [@Inter-Galactic-App](https://github.com/Inter-Galactic-App).

## 3.2.0

- **HTML files now preview as rendered web pages.** Opening a `.html`/`.htm`
  file shows the page in a sandboxed frame, with a **Rendered ⇄ Source** toggle
  in the window header (they previously showed only as syntax-highlighted
  source). The page's own scripts are **off by default**; an **Enable scripts**
  button in the header runs them on request. Either way the frame is a null
  origin — it can never reach Cockpit's session, cookies, or DOM — and the
  plugin's content-security-policy keeps even a script-enabled page from calling
  out to external hosts. Relative resources (`./style.css`, local images) don't
  resolve, since the frame has no filesystem base.
- **Coverage reporting for the unit suite.** `make test` runs the pure-node unit
  tests under node's built-in runner with `--experimental-test-coverage` and
  fails if coverage falls below the floors in the Makefile; `make coverage` also
  writes a committed, sortable `COVERAGE.html` plus `coverage/lcov.info` (machine
  output, git-ignored). A new `make release` target gates a release on the tests
  and records the report before publishing. Dev tooling only — nothing in the
  shipped plugin changes, and the report is never included in the release zip.

## 3.1.10

- **Fixed: the built-in "List archive contents" action failed on file
  names containing spaces, parentheses, or other shell characters,
  reporting `syntax error near unexpected token`.** The command template
  quoted the file name itself, on top of the quoting the action runner
  already applies to every value — producing a doubled-quote `case`
  statement the shell couldn't parse. The redundant quotes are removed;
  the runner's own quoting is safe and complete, so archive listing now
  works whatever the file is named.

## 3.1.9

- **Fixed: the instant git bar (3.1.8) now actually works on the first
  navigation after opening the plugin.** The repo cache it reads from is
  now loaded up front, before the first folder opens, instead of a beat
  later — so entering a registered repository no longer briefly waits for
  a full Git scan the very first time you click into it each session.

## 3.1.8

- **Faster: the git bar now appears instantly when you enter a folder
  inside a repository you've already registered.** Its owner/repo and
  last-known branch are remembered in the repo cache, so browsing in no
  longer waits for Git to finish scanning the working tree before the bar
  can render. The real status (uncommitted changes, ahead/behind) still
  fills in a moment later, and a repository that was moved or deleted
  since it was cached self-corrects — the bar clears instead of showing
  stale information.

## 3.1.7

- **Fixed: browsing into a subfolder of an already-registered Git repository
  no longer shows a stray "+ Register" button** — the git bar correctly
  shows the repo as *cached* throughout its tree.
- **Dev: committed a previewable-fixture set and preview test coverage.**
  `tests/samples/` now ships a small (~5 MB), synthetic set of sample files
  covering every preview kind Explorer supports — images (incl. SVG/AVIF),
  PDF, Markdown, `.docx`, spreadsheets (`.xlsx`/`.ods`/`.csv`), text/code,
  audio, natively-playable video, and the ffmpeg/HLS video formats (incl.
  `.ogv`, guarding the 3.1.6 black-picture fix). A new unit test pins the
  fixture set against the preview-kind detectors, and a new end-to-end test
  drives the real UI through every preview kind against these fixtures,
  including transcoding. The existing smoke test also gained a fast,
  ffmpeg-independent pass over a few of them. Dev-only — `tests/` is not
  part of the installed/zipped plugin.

## 3.1.6

- **Fixed: some `.ogv` videos played with sound but a black picture.**
  `.ogv` files almost always carry Theora video, and current versions of
  Chrome no longer include a Theora decoder — but Chrome still answers
  "maybe" when asked if it can play the container in general, so the plugin
  handed the file straight to the browser instead of converting it first.
  The result was a player with working controls and audio but a frame that
  never showed anything. `.ogv` is now converted on the server (the same
  path already used for `.mkv`, `.avi`, `.ogm`, and other formats the
  browser can't decode on its own), so the picture plays correctly.

## 3.1.5

- **Split view: counts are no longer ambiguous between panes.** With two
  panes open, the single shared status bar and toolbar chip couldn't say
  *which* pane a number belonged to. Each pane now gets its own `N selected`
  chip (in its head) and its own status strip (in its footer, aligned with
  that pane's width) showing that pane's totals and selection — the shared
  toolbar chip and status bar are hidden while split, since they'd just
  repeat one pane's numbers ambiguously. Single-pane view is unchanged.

## 3.1.4

- **Selection is easier to spot.** The status-bar selection breakdown now
  lights up in the accent colour (bold, theme-aware) instead of blending into
  the muted status text. A new compact **`N selected`** chip also appears in
  the toolbar next to the path bar — where your eyes already are — the moment
  the active pane has a selection; click it to clear the selection. Hidden on
  phones (the status bar still shows the count there); both read from the
  same pane selection, so they can't drift apart.

## 3.1.3

- **Selection summary now breaks down files vs. folders.** The status bar's
  selection readout used to show only a raw count and size (`4 selected ·
  9.6 MB`). It now relates the selection to the pane's total and splits it
  into files/folders, e.g. `4 of 28 selected · 3 files, 1 folder · 9.6 MB`.
  A folders-only selection omits the size instead of showing a misleading
  `0 B` (folder sizes aren't computed).

## 3.1.2

- **Fixed: maximized video preview sat in a corner.** Maximizing the preview
  window while a video was playing left it capped at its normal-window size
  in the top-left, with a large empty dark area to the right and below.
  Maximized video preview now fills the window (letterboxed) instead of
  sitting in a corner.

## 3.1.1

- **Fixed: some videos showed a black player and never started.** A video
  whose picture data can be handed to the browser untouched is repackaged
  rather than re-encoded, which is much faster — but that only works if the
  browser will actually accept the source's picture data, and some files carry
  malformed data that a player refuses even though the file is otherwise fine
  and every other tool plays it. Explorer now decodes the first few frames
  before it commits: if the decoder objects, the file is re-encoded instead
  (the green **⚙ Transcoding** badge) rather than repackaged. Re-encoding is
  slower, but it always plays — and it also brings the full progress bar and
  seeking that re-encoded video already had. Files that repackage cleanly are
  unaffected and still take the fast path.
- **Fixed: repackaged video showed the wrong length on its progress bar.**
  The player's own progress bar used to show only how much had been repackaged
  so far, so a long film started out claiming to be about forty seconds long
  and then jumped repeatedly as repackaging ran ahead, settling on the real
  length only once the whole file was done — a couple of minutes for a large
  one. Dragging that bar to what looked like the end landed a few seconds in
  and stalled. The progress bar now shows the file's real total length from
  the first frame, matching the length already shown in the title bar.
  Dragging forward past the part that has been repackaged so far takes you as
  far as it has got (repackaging usually outruns playback by a wide margin);
  dragging backwards into anything already done is exact.

## 3.1.0

- **Video that needs converting is now fully seekable, right from the start.**
  The player shows the file's real total length and a normal progress bar as
  soon as playback begins, instead of a bar that grew as the conversion caught
  up. You can now drag to any point — including parts that haven't been
  converted yet: conversion restarts at that point and playback resumes there
  after a couple of seconds. Anything already converted, including sections you
  skipped over, replays straight from the cache without being converted again,
  and an open video only ever runs one conversion at a time — seeking moves that
  conversion rather than starting a second one. This covers video that has
  to be re-encoded (the **⚙ Transcoding** badge). Video that only needs
  repackaging (**Remuxing** — already-H.264 sources) is unchanged: its pieces
  can't be cut to a fixed grid, so its timeline still fills in as it goes.

## 3.0.1

- **Fixed: PDF preview prompted a download instead of rendering inline.**
  Previewed binary files (PDF, images, audio, natively-played video) are now
  fetched with the correct content type, so the browser knows how to display
  them; a PDF preview now shows the built-in PDF viewer instead of offering
  to save the file. Audio and video preview blobs also now carry a correct
  content type.
- **Fixed: transcoded/remuxed video could stall forever or never start,
  and the total length briefly showed as a few seconds.** Playback now
  waits until about 30 seconds of video has been converted before it
  starts, so it doesn't stall right at the start waiting for more data;
  playback also now starts at the beginning of the file instead of
  skipping ahead a few seconds. The title bar now shows the real total
  length right away (the small counter on the video's own control bar
  still climbs as more of the file finishes converting — that one's the
  browser's, not ours). Video with 5.1/multichannel audio (common on
  ripped discs) is downmixed to stereo, since some browsers refuse to
  play multichannel audio in this preview path. The **Transcoding /
  Remuxing** badge and the length now show in the preview window's title
  bar instead of floating over the video.

## 3.0.0

- **Preview is now a viewer.** Page through a folder's previewable files with
  **◀ / ▶** (or the arrow keys) without leaving the window, and **maximize** the
  window (it stays above the status bar).
- **Video that plays.** Formats the browser can't decode (mkv, avi, HEVC, …) are
  transcoded on the fly with **ffmpeg** and streamed into the player; ordinary
  mp4/webm still play natively. A badge shows when it's **transcoding** (green)
  vs **remuxing** (gray). If ffmpeg isn't installed, Explorer detects your distro
  and offers a one-click install (with the manual command shown). Local files
  only — this is not an IPTV/streaming feature.
- **Rendered documents.** Markdown renders (toggle to source), and **.docx** and
  **spreadsheets** (.xlsx/.xls/.ods/.csv/.xlsb) render in a sandboxed frame.
- **New dependency (optional):** `ffmpeg` on the server — only needed for
  non-native video. See the README.

## 2.5.0

- **Mobile-friendly on phones.** Explorer now fits and works on a phone-sized
  screen (e.g. iPhone). The top toolbar collapses its secondary actions into a
  **⋯ More** menu; dialogs go full-screen; the global-actions list, Plugin
  Manager and Actions manager reflow into single-column layouts so buttons
  (like **Run**) are always on-screen and tappable. Desktop and tablet layouts
  are unchanged.

## 2.4.2

- **Plugin Manager:** the IF TV row is now labelled **InFlightTV (iftv)**.
- **Custom actions manager:** the action list on the left is now split into
  **Global Actions** (toolbar) and **Other Actions** (file / directory), in both
  the User and System tabs; a section with no actions is hidden entirely. The
  list and the editor each scroll independently within a fixed-height dialog, so
  long lists and long forms stay side by side. The **↑ / ↓** reorder buttons now
  move an action **within its own section**, never across the Global/Other divide.
- **Interactive actions:** fixed prompt-transcript and message lines running
  together in the interactive output pane — every line now ends properly.

## 2.4.1

- **Plugin Manager now covers Hangar and Pilot.** The two newest plugins join
  Explorer, Cockpit Top, IF TV and Manifest in the **⬆ Plugins** panel, so all
  six can be checked, updated, installed and force-reinstalled from one place.
  Pilot reads its update repo from its own settings file; Hangar uses the
  built-in default (its settings live in `/etc/hangar`).

## 2.4.0

- **New: reorder tabs and sub-tabs by drag-and-drop.** Main tabs in the top bar,
  and terminal/tmux sub-tabs inside a tab, can now be dragged into a new order
  (powered by Alpine's sort plugin — a click still activates a tab, a drag
  reorders it). The order is **persisted for the tabs that are already saved** —
  directory tabs and tmux sessions come back in your chosen order next launch;
  plain-shell terminals and output tabs stay session-only (they aren't restored
  across a reload regardless).

## 2.3.1

- **Fixed: an empty terminal pane appeared when toggling Split (dual pane) and
  couldn't be dismissed.** The integrated terminal pane used `x-show` for its
  visibility gate, but it also carries a reactive `:style` (the split width/height).
  Toggling **Split** re-applied that `:style`, which overwrote the inline
  `display:none` that `x-show` had set — so an empty terminal pane (no terminals)
  became visible and got *stuck*: its `×` wouldn't close it, and the only way to
  clear it was to open a terminal and then close it. The pane and its resizer are now
  gated with `x-if`, which adds/removes them from the DOM entirely, so an empty
  split can never be shown.
- **Hardened: closing the last terminal always closes the split.** `closeTerminal`
  previously closed the split (dir tabs) / the terminal tab only when the closed
  sub-tab happened to be the *active* one; it now closes whenever the last terminal
  is gone, regardless of which sub-tab was active. Covered by a new unit test
  (`tests/terminal-close-unit.mjs`).

## 2.3.0

- **New: Plugin Manager — update or install all your Cockpit plugins from one place.**
  The **⬆ Plugins** toolbar button opens a panel listing Explorer, Cockpit Top, IF TV and Manifest
  with their installed and latest released versions. Each plugin's update repo is
  read from its own settings file where it has one (Explorer `updateRepo`, IF TV
  `updateRepo` in JSON, Manifest `update.repo`), falling back to a built-in default
  (Cockpit Top is static). **Update** a plugin or **Update all** at once (a *Force
  reinstall* toggle also reinstalls up-to-date plugins, and IF TV whose installed
  version isn't tracked). Not-installed plugins can be **multi-selected and
  installed at once**. Install logs stream live, and a **Restart Cockpit** button
  (confirm-gated — it disconnects your session) appears when updates finish.
  Downloads use your `gh`/`curl` credentials; only the install into
  `/usr/share/cockpit` runs through the superuser bridge.
- **Fixed: "Retry as administrator" now appears when a delete hits root/foreign-owned
  files.** Deleting a folder whose tree contains items you don't own (e.g. a root-owned
  `node_modules/` or a container's foreign-uid `data/`) failed with a bare `rm exit 1`
  and no way forward. The delete channel merges `rm`'s stderr into its output stream, so
  the "Permission denied" text was being discarded and the generic exit message didn't
  match the permission-error check that gates the admin retry. The failure now carries
  the actual `rm` error and flags permission/EPERM cases, so the **Retry as administrator**
  button shows and the delete completes through the superuser bridge.
- **Fixed: editing the path bar in split (dual-pane) view.** The top path bar and the
  active pane's per-pane path bar shared a single `editingPath` flag, so clicking the top
  bar rendered *two* auto-focusing inputs; their cross-blur closed the editor immediately
  and you couldn't type. The top bar now uses its own flag, so exactly one input renders.
- **New: "Copy path" in the right-click menu.** Copies the absolute path of the selected
  file/folder to the system clipboard (one per line for a multi-selection). Shown as
  "Copy paths" when several items are selected.

## 2.2.7

- **Fixed: pasting a video (webm/mp4/…) via the terminal 📋 button.** The one-click
  path used the browser's async Clipboard API, which only exposes a safelisted set of
  types (in practice `image/png` and `image/svg+xml`) and **cannot surface video at all**
  (nor `image/jpeg`/`image/webp`). When it found no readable media it stopped with
  "No image or video found" instead of trying the native-paste overlay — so a copied
  **webm** was never detected. The button now falls through to the *"press Ctrl+V here"*
  panel, whose DOM paste event isn't subject to that safelist, so videos (and JPEG/WebP
  images) upload as expected. Ctrl+V directly in the terminal already used the native
  paste path and was unaffected.

## 2.2.6

- **Deep-link "open this directory."** Another Cockpit plugin can now hand a folder to
  Explorer via `cockpit.jump("/explorer#open=" + encodeURIComponent(absolutePath))`.
  Explorer reads the `#open=<url-encoded path>` hash on startup and on every `hashchange`,
  opens the directory in a new focused tab (a file path opens its parent and selects the
  file; a bad path shows a toast), then strips the `open=` param so a reload doesn't
  re-fire it. Used by the companion **ctop** plugin.

## 2.2.5

- **ZFS-aware filesystem operations.** On ZFS paths, Explorer no longer runs the slow
  `du` space-preflight before a copy/move (ZFS `df` already reports correct free space and
  returns ENOSPC if a write truly won't fit); filename/content **search** and **rsync**
  copies now skip the `.zfs` snapshot directory so a `snapdir=visible` dataset can't
  inflate sizes or stall traversal. Detection is per-path (`findmnt`/`stat -f`), so mixed
  ext4/ext3/zfs hosts each get the right behavior. Also: rsync now copies with `--sparse`
  so sparse files (e.g. VM images) aren't ballooned to full size.

## 2.2.4

- **Reorder custom actions.** Each action in the Custom Actions manager now has
  **↑ / ↓** buttons to move it up or down within its scope (User / System). The
  order you set is the order the actions appear in the right-click menu — the
  change takes effect immediately and is written to disk when you **Save**.

## 2.2.3

- **Dialogs put the cursor in the first field automatically.** When a modal
  opens and its first field is a text input or textarea, it's focused
  immediately so you can type without clicking first — new-folder/rename/new
  tmux session prompts, the commit message box, GitHub token entry, etc. Modals
  whose first field isn't text (e.g. Settings) are left alone. This also covers
  the interactive **Script Prompt Protocol** text prompts. (Previously the
  prompt tried to focus via `x-init`, which runs at page load while the modal is
  hidden and so never took effect; it now focuses on the modal's shown event.)
- **Per-row actions menu (⋮) for touch screens.** Every file/folder row now has
  a ⋮ button that opens the same menu as right-click — so the context menu is
  reachable on touch devices that have no right-click. On desktop it appears on
  row hover; on touch it's always shown with a larger tap target.
- **Copy button in text previews.** Previewing a text-based file (md, txt, html,
  code, …) now shows a **Copy** button in the window header that copies the
  file's contents to the clipboard (works over plain HTTP too).

- **Fixed: a restored tmux tab's non-active session came back blank.** With
  multiple tmux sessions open as sub-tabs, reloading mounted only the active
  sub-tab; switching to another one showed a blank pane until you closed and
  reopened it. Non-active sub-tabs (whose container is hidden and can't size at
  restore time) now mount lazily the moment you select them, and tab activation
  only mounts the visible sub-tab instead of futilely retrying hidden ones.

## 2.2.1

- **Large uploads/pastes no longer disconnect Cockpit.** Uploads (drag-drop,
  folder trees, and clipboard image/video paste) now stream to the host in
  64 KiB chunks — matching Cockpit's own transport framing — instead of one
  oversized message that tripped Cockpit's `too-large` limit and dropped the
  whole session (the "Reconnect" overlay). Pasting a video no longer knocks you
  offline. The unused "Upload chunk size" setting was removed.
- **Terminals auto-reconnect after a Cockpit restart or disconnect.** When the
  transport drops, dropped terminal channels now re-attach automatically (with
  backoff): **tmux** sessions reattach to the live server and force a full
  repaint instead of coming back **blank**, and plain shells respawn. Terminals
  in backgrounded tabs reconnect the moment their tab becomes visible again.

## 2.2.0

- **Clipboard paste now accepts video, not just images.** Pasting into a
  terminal (Ctrl+V, or the paste button) uploads a copied **video**
  (`mp4`, `webm`, `mov`, `mkv`, `avi`, `ogv`) the same way it already
  handled images: saved to the remote `clipboardUploadDir` as
  `clip-<timestamp>-<random>.<ext>`, with the path typed into the shell.
  The terminal's paste button changed from **🖼** to **📋** and its title
  now reads "Paste clipboard image or video …"; the two related Settings
  fields are relabelled "Terminal clipboard-media folder" and "Keep pasted
  media for (hours)" to reflect that both file types are covered. No
  behavior change for images.

## 2.1.0

- **Internal: `index.html` split into HTML partials.** The ~21 modal dialogs
  moved out of the 2,142-line `index.html` into focused `html/modals/*.html`
  files (windows, files, dialogs, mounts, grub, actions, toolbar, github);
  `index.html` is now ~660 lines — just the app shell (tab bar, tabs, context
  menus, toasts). Still **no build step**: a small `js/boot.js` fetches the
  partials in the browser, injects them into the component's scope, and only
  then loads Alpine, so Alpine initializes the completed DOM (each modal's
  `x-init` runs normally). No behavior change; verified in-browser.

## 2.0.1

- **Line numbers in the code preview.** The text/code Preview now shows a
  line-number gutter down the left, aligned 1:1 with the syntax-highlighted
  code. The gutter stays pinned while you scroll a wide line horizontally, and
  the numbers aren't selectable — copying the code never picks them up.

## 2.0.0

- **Internal: `app.js` split into per-feature + per-core modules.** The
  7,188-line Alpine component is now composed from focused files instead of one
  monolith — no behavior change, no build step. Shared non-reactive registries +
  constants moved to `js/runtime.js` (`window.ExRT`); each feature's methods moved
  verbatim into a `window.ExplorerX` global-mixin file under `js/features/`
  (`grub`, `mounts`, `github`, `actions`, `terminal`, `upload`, `editor`) and the
  core shell into `js/core/` (`tabs`, `filelist`, `fileops`, `output`, `dialogs`,
  `settings`), all spread into `Alpine.data`. `app.js` shrank from **7,188 to
  ~575 lines** — just reactive state, `init`, and the composer. A
  `tools/check-mixins.js` guard fails on duplicate method keys across the mixins
  (there is no test runner). Reactive state stays centralized in `app.js`; public
  method names are unchanged.

## 1.1.6

- **Esc closes the open popup.** Pressing **Escape** now closes the top-most
  popup — the editor / preview window included. Those two used to ignore Esc on
  purpose (so a stray keypress couldn't discard edits); Esc now goes through the
  normal close path, which still prompts before discarding unsaved changes. The
  folder picker closes on Esc too. Backdrop clicks are unchanged.

- **Reload actions without a page reload.** The Custom-actions manager has a
  **↻ Reload from disk** button, and every file/folder right-click menu has a
  **↻ Reload actions** entry, that re-read the user, system and built-in
  `actions.json` files — handy after editing them by hand.

- **Docs.** README updated for the terminal/tmux pane split, copying text out of
  the terminal (and the HTTPS-for-clipboard note), Esc-to-close and Reload
  actions, plus new screenshots for the terminal/tmux panes and the right-click
  menu.

## 1.1.5

- **Fix: copying selected text from a file Preview did nothing.** The global
  Ctrl/⌘+C shortcut (which stages files for paste) was hijacking the keypress
  even when you had text selected in a read-only preview, so the browser's own
  copy never ran. Copy/Cut now only stage files when no text is selected;
  otherwise the keypress falls through to the native copy. Also fixes Ctrl/⌘+X.

- **Copy on non-secure (http) origins.** `navigator.clipboard` only exists on a
  secure origin, so on a plain-`http://` Cockpit the clipboard writes that used
  it silently failed. The tmux/vim **OSC 52** copy and the *Open in terminal*
  `cd`-command copy now fall back to `execCommand`, so they work (best-effort)
  on http too. **For reliable terminal/tmux copy, use `https://`** — Cockpit
  serves it by default on port 9090; the browser blocks async clipboard writes
  from a terminal on http regardless.

## 1.1.4

- **Terminal & tmux panes are now fully separated.** A terminal tab is a
  container of plain shells; a tmux tab is a container of tmux sessions. The
  `+` button does the right thing for its tab: in a plain terminal it opens
  another shell, and in a tmux tab it opens a **new tmux session** (asking for
  the session name with the same prompt as the header **New tmux session**
  button).

- **All tmux sessions are grouped under one tab.** Opening a session from the
  tmux manager now adds it as a sub-tab of the single tmux tab (or focuses it
  if already open) instead of scattering sessions across separate main tabs.
  The whole group is remembered and restored together on reload; sessions that
  died meanwhile are dropped.

- **Clear icons and colours per kind.** Plain terminals are marked `❯` with a
  **blue** pane-header accent; tmux panes are marked `⧉` with a **green**
  accent, on both the main-tab title and each sub-tab — so the two are obvious
  at a glance (light and dark themes).

- **Bigger directory toolbar buttons.** The Back / Forward / Up / Home / Reload
  glyphs are larger and bolder so they're easy to read.

## 1.1.3

- **Terminal: paste a clipboard image straight into the shell.** Pressing
  **Ctrl+V** in a terminal that holds an image on the clipboard (e.g. a
  screenshot) now uploads it to a temp folder on this host and types the
  saved file's path — followed by Enter — into the terminal. This makes
  pasting images into a program running in the terminal (such as an AI CLI
  inside tmux) work even though the browser and the shell are on different
  machines: the image is read locally in the browser and streamed to the
  host, so the remote clipboard is never involved. Pasting **text** is
  unchanged. Works over both HTTP and HTTPS.

- **Terminal: 🖼 button on the sub-tab bar.** An explicit button to do the
  same thing. On HTTPS it reads the clipboard directly in one click; on
  HTTP (where direct clipboard reads are blocked) it opens a small
  "press Ctrl+V here" panel that captures the image.

- **Settings: clipboard-image folder and retention.** New settings for the
  destination folder (default `/tmp/explorer-clip`) and how long to keep
  pasted images (default 24 h; `0` = keep forever). On each paste, older
  `clip-*` files in that folder are pruned.

## 1.1.2

- **Fix: "Set up GitHub…" reappearing on an already-configured host.**
  The gh auth check relied on `gh auth status`, which makes a live network
  call and exits non-zero when the GitHub API is briefly slow or
  unreachable. It now checks `gh auth token` first (a purely local
  credential read), so the button no longer flips on transient
  connectivity.

- **Fix: file Cut / Copy / Paste did nothing.** A second method also named
  `copyToClipboard` (for copying text to the OS clipboard) shadowed the
  file-clipboard one, so the context-menu Copy/Cut and Ctrl+C / Ctrl+X /
  Ctrl+V wrote the literal word "copy"/"cut" to the clipboard and never
  staged the files — leaving Paste a no-op. The text copier is now
  `copyTextToClipboard`, and file clipboard actions work again.

- **Terminal: copy the selection.** xterm never copied on its own.
  Select-to-copy now works, as do **Ctrl/⌘+Shift+C** and **Ctrl+Insert**
  (plain Ctrl+C still sends SIGINT). Paste remains **Ctrl+Shift+V**.

- **Terminal: copy from tmux / vim (OSC 52).** Programs that take over the
  mouse (tmux with `mouse on`, vim, …) push copies via the OSC 52 escape
  sequence, which the terminal now honours by writing to the system
  clipboard; clipboard *reads* (`OSC 52 ?`) are ignored. tmux must emit it
  with `set -g set-clipboard on` (plus an `Ms` terminal-override). Holding
  **Shift** while dragging is an alternative that uses xterm's own
  selection.

- **Fix: "Follow" breaking on fast log tails.** On a busy stream (e.g.
  `podman-compose logs`) the auto-scroll listener mistook its own scrolling
  for the user scrolling away, so Follow kept switching off then on. It now
  ignores its own scrolls, coalesces them to one per animation frame, and
  stays pinned; trimming to `outputMaxLines` no longer jumps the view.

- **GitHub: remember the token and re-login automatically.** The sign-in
  dialog has an opt-in **Remember this token** checkbox that saves the PAT
  under `~/.config/cockpit/explorer/gh-token` (0600, and the dialog shows
  the path). When gh loses its stored login, Explorer re-authenticates from
  that token automatically — at startup and when the GitHub panel
  refreshes. If a GitHub API call is rejected for auth, it re-logins once
  and retries; if the saved token is also rejected, it prompts for a new
  one.

## 1.1.1

- **tmux: Edit `~/.tmux.conf`.** When the user has a `~/.tmux.conf`, the
  **▤ tmux** panel shows an **⚙ Edit .tmux.conf** button (detected each
  time the panel opens) that opens the file directly in the editor. The
  button is hidden when no such file exists.

## 1.1.0

A big release centred on a new **Mounts panel** and a **GRUB editor**,
plus folder/admin uploads, per-launch action elevation, and a set of
administrator-access improvements in the editor, preview and listing.

### Mounts panel (new — `⛁ Mounts`)

A new toolbar button opens a Mounts dialog with three tabs.

**`/etc/fstab` editor**

- Structured table — one row per entry (device/UUID, mount point, type,
  options, dump, pass) with add-entry / remove-row, plus a **Raw text**
  toggle. Comments, blank lines and value quoting round-trip untouched.
- **Field suggestions** on every column: real block devices from
  `lsblk`/`blkid` (offered as `UUID=`, `LABEL=`, `/dev/…`), existing
  mount points under `/mnt` and `/media` plus common targets, filesystem
  types from `/proc/filesystems`, and option/dump/pass presets. Choosing
  a device auto-fills its filesystem type.
- Per-row **mounted indicator**: ● mounted, ○ declared but not mounted
  (click to mount now), — not applicable (swap / `none`). State comes
  from `findmnt`, falling back to `/proc/self/mounts`.
- **Save** validates the entries, backs up to `/etc/fstab.bak`, writes
  through Cockpit's superuser bridge, then (optionally) runs
  `systemctl daemon-reload` and a targeted `mount <point>` for each new
  entry, reporting per-entry results.

**Mounted (live) tab**

- Lists everything currently mounted, with per-mount **remount**
  (`mount -o remount`) and **unmount** (`umount`, with a lazy-unmount
  offer when the target is busy).
- **Mount something…** does an ad-hoc `mount` that isn't written to
  fstab.
- System and pseudo mounts (`/`, `/proc`, `/sys`, `/dev`, `/run`, virtual
  filesystems) are protected from unmount/remount.

**Network share tab — SMB/CIFS and NFS**

- Pick the share type at the top (SMB/CIFS or NFS).
- **SMB/CIFS** with a managed, root-only credential store: credentials
  are saved to `/etc/cifs-creds/<name>` (a `0700` root directory with
  `0600` files), written through the file channel so the password never
  appears in `/etc/fstab`, on a command line, or in any log. fstab only
  references `credentials=/etc/cifs-creds/<name>`.
- **Discover** finds SMB hosts via mDNS (`avahi-browse`) and a NetBIOS
  broadcast (`nmblookup '*'`); when those find nothing it offers a
  **directed subnet scan** (default = your interface's network) that
  probes each address with `nmblookup -A` and a TCP/445 check — reliable
  even with no master browser or a suppressed broadcast.
- **Browse** lists a host's shares with `smbclient` (guest or a saved
  credential). If `smbclient` is missing, Browse is disabled and a
  distro-specific install command is shown.
- **NFS** (host/IP-based, no credentials): enter server + export path (or
  list exports with `showmount -e`), pick options, and *Add & save*
  writes a `server:/export` entry and mounts it. A distro-specific
  install hint is shown when `mount.nfs` is missing.
- Results (hosts, shares, exports) appear as clickable chips and as toasts.

### GRUB boot-loader editor (new — `⏻ GRUB`)

- Shown only when `/etc/default/grub` exists and a regeneration tool is
  present (degrade-hide).
- Structured key/value table or raw text; comments and value quoting
  round-trip untouched.
- A header line shows the detected regeneration command, BIOS vs UEFI,
  and whether `grubby` is available.
- **Save & regenerate** backs up to `/etc/default/grub.bak`, writes the
  file, and — after a confirmation showing the exact command —
  regenerates the boot config (`update-grub`, else
  `grub2-mkconfig`/`grub-mkconfig -o <path>` with the path auto-detected:
  Fedora/RHEL `/etc/grub2*.cfg` symlinks, the UEFI `EFI/<distro>` path, or
  the BIOS default). Optional `grubby` pass applies the kernel cmdline to
  already-installed kernels. Edits `/etc/default/grub` only.

### Uploads & custom actions

- **Drag-and-drop folder upload**: dropped folders are recreated with
  their full tree (including empty directories); plain multi-file drops
  keep their per-file behaviour.
- **Admin-aware upload**: an upload that fails with *Permission denied*
  offers a whole-batch *Retry as administrator*.
- Custom actions gained a **`privilege: "ask"`** mode that prompts
  *Run as me / Run as administrator* at launch.

### Administrator access (editor / preview / listing)

- **Open / preview as administrator**: files you can't read as your
  session user now offer a *Retry as administrator* (preview) or *Open as
  administrator* (editor) that reads through the superuser bridge.
- **Sticky admin saves**: once a file is known to need root, the editor
  keeps saving through the bridge; a single adaptive Save button flips to
  *Save as administrator*, and a permission-denied save auto-retries
  elevated.
- **Sticky admin directory listings**: listing a root-only directory as
  administrator stays elevated for that path across reloads and refreshes.
- **`root` tab badge**: a tab listing a directory as administrator shows a
  small badge in its header.

### Notes

- All privileged operations run through Cockpit's superuser bridge, so
  *Administrative access* must be enabled in Cockpit.
- Optional tools degrade gracefully: `cifs-utils`/`mount.cifs`,
  `nfs-utils`/`mount.nfs`, `smbclient`, `showmount`, `avahi-browse`,
  `nmblookup`, `findmnt`, and the GRUB tools are each detected, and the
  related UI hides or shows an install hint when absent.
