# Changelog

All notable changes to the Explorer Cockpit plugin are recorded here.

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
