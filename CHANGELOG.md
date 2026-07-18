# Changelog

All notable changes to the Explorer Cockpit plugin are recorded here.

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
