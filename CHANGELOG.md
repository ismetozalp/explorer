# Changelog

All notable changes to the Explorer Cockpit plugin are recorded here.

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
