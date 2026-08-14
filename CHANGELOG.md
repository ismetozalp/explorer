# Changelog

All notable changes to the Explorer Cockpit plugin are recorded here.

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
