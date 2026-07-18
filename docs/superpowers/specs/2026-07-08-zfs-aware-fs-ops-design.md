# 2.2.5 — ZFS-aware filesystem operations

**Date:** 2026-07-08
**Status:** Approved design, pending implementation
**Version:** 2.2.5
**Component:** Explorer Cockpit plugin — `js/fs.js`, `js/core/fileops.js`

## Problem

A host can mount several filesystems at once (e.g. ext4 + ext3 + a ZFS pool).
Explorer runs `du`/`df`/`find`/`rsync` for size preflight, free-space checks, and
search/copy. The request: on ZFS, don't use `du` to size things, and adapt features
to ZFS.

## Research outcome (what is and isn't actually broken)

Verified against OpenZFS docs, Klara Systems, and OpenZFS GitHub issues:

- **`df --output=avail` is correct on ZFS** — it already excludes quotas, reservations,
  refreservations, pool slop, and snapshot-held space. Safe for "will this fit?".
- **`du -sb` (apparent bytes) is correct on ZFS** — apparent size is filesystem-agnostic.
  The preflight compares apparent-source vs raw-dest-free, so it **over-warns, never
  under-warns**, and is already time-boxed to 5 s and dismissable.
- **The `stat -c %d` same-filesystem move check is already correct** — each ZFS dataset
  (even siblings in one pool) has a distinct `st_dev`, so cross-dataset moves already
  fall back to copy+delete.

So there is **no data-safety/correctness bug** in the current du/df/stat usage. The
genuine ZFS issues are:

1. **`.zfs` snapshot directory.** With `snapdir=visible`, recursive `du`/`rsync`/`find`
   (Explorer's search) descend into `.zfs/snapshot` and walk every retained snapshot →
   wildly inflated sizes and severe slowdowns. **This is the real ZFS trap.**
2. **rsync lacks `--sparse`** (not ZFS-specific) → sparse files (VM images) balloon to
   full size on copy.

## Decisions (from brainstorming)

- **Full proposal**, honoring "use df / no du on ZFS".
- **`.zfs` pruning applied only on ZFS paths** (precise; never touches a real folder
  literally named `.zfs` on a non-ZFS partition).
- Detection is **per-path** (never a global switch) since filesystems are mixed.

## Design

### 1. Per-path filesystem detection — `js/fs.js`

Add and export:

```js
// Filesystem type for a path. findmnt is most reliable (resolves the exact
// containing mountpoint, no root); stat -f is the fallback on hosts without
// util-linux. Returns a lowercased fstype string ('zfs', 'ext4', …) or ''.
async function fsType(path, opts) {
    try {
        const o = await cockpit.spawn(['findmnt', '-no', 'FSTYPE', '-T', path], spawnOpts(opts));
        const t = o.trim();
        if (t) return t.toLowerCase();
    } catch (e) { /* fall through */ }
    try {
        const o = await cockpit.spawn(['stat', '-f', '-c', '%T', path], spawnOpts(opts));
        return o.trim().toLowerCase();
    } catch (e) { return ''; }
}
async function isZfs(path, opts) { return (await fsType(path, opts)) === 'zfs'; }
```

Export both in the FS module's public object. Detection runs once per operation and its
result is reused — never cached across operations (mixed filesystems).

### 2. Copy/move preflight — `js/core/fileops.js` (`_doCopyOrMove`)

Detect the source filesystem once, before the `du` block. The sources of one operation
share a parent folder (a multi-select comes from one listing), so detect on
`Util.dirname(srcs[0])` (its containing filesystem):

```js
const srcZfs = await FS.isZfs(Util.dirname(srcs[0]), opts).catch(() => false);
```

- **If `srcZfs`:** skip the `du` sum and the size-vs-free comparison entirely. (No cheap
  way to size a source without a full traversal; `du` is what the user asked to avoid on
  ZFS. `df` still governs the real write — ZFS returns ENOSPC if it genuinely runs out.
  The preflight is already best-effort, so skipping the *pre*-warning for ZFS sources is
  acceptable.)
- **Else:** unchanged — `du`-sum sources (5 s cap) vs `df` avail, confirm on shortage.

`srcZfs` is also reused by the rsync step (§4) so detection happens once.

### 3. Search `.zfs` prune — `js/fs.js` (`searchFilename`, `searchContent`)

Both build `['find', root, …]`. When `root` is on ZFS, prune a `.zfs` directory so search
never walks the snapshot tree:

```js
const zfs = await isZfs(root, opts).catch(() => false);
const prune = zfs ? ['-name', '.zfs', '-prune', '-o'] : [];
```

`searchFilename` command becomes:

```js
['find', root, ...(recursive ? [] : ['-maxdepth', '1']), '-mindepth', '1',
 ...prune, flag, pattern, '-printf', fmt]
```

`searchContent` enumerate command becomes:

```js
['find', root, ...(recursive ? [] : ['-maxdepth', '1']), '-mindepth', '1',
 ...prune, '-type', 'f', '-print0']
```

`find … -name .zfs -prune -o TESTS ACTION` prunes (does not descend, does not print) a
`.zfs` dir and prints everything else that matches — standard idiom. Non-ZFS roots keep
the exact current command (no behavior change, no risk to a real `.zfs` folder).

### 4. rsync — `js/core/fileops.js`

There are two rsync arg sites; both currently build
`['rsync', '-a', '--info=progress2', '--no-i-r']`:

- **`_doCopyOrMove`** (multi-source copy/move). Already has `srcZfs` from §2 — reuse it.
- **`_runRsyncRenamed`** (single-source rename-on-transfer, called from
  `_doRenamedTransfer`, which has **no** du preflight of its own). It receives `src`;
  detect there: `const srcZfs = await FS.isZfs(Util.dirname(src), opts).catch(() => false);`

Both change to:

- **Always add `--sparse`** (general fix; safe on every filesystem).
- **Add `--exclude=.zfs/`** (dirs only) when the **source is ZFS**, so a `snapdir=visible`
  copy never duplicates the snapshot tree.

```js
const args = ['rsync', '-a', '--sparse', '--info=progress2', '--no-i-r'];
if (srcZfs) args.push('--exclude=.zfs/');
```

Note `_doRenamedTransfer` itself needs no du-skip (it never ran a du preflight); only its
rsync args (in `_runRsyncRenamed`) gain `--sparse` and the conditional `.zfs` exclude.

## Non-goals

- **`du`/`df`/`stat %d` are left as-is** (research: already correct on ZFS; `du` is simply
  skipped for ZFS sources per §2, not "fixed").
- **`cp --reflink=auto`** same-pool fast clone (OpenZFS ≥2.2) — a performance enhancement,
  out of scope.
- **NFSv4-ACL (`-X`) preservation** and **encrypted/locked-dataset UX hints** — out of scope.
- No new settings; no UI change.

## Files touched

- `js/fs.js` — `fsType`/`isZfs` helpers (exported); `.zfs` prune in `searchFilename`/
  `searchContent`.
- `js/core/fileops.js` — skip `du` preflight on ZFS source; rsync `--sparse` always +
  `--exclude=.zfs/` on ZFS source (both `_doCopyOrMove` and `_doRenamedTransfer`).
- `VERSION` → `2.2.5`; `CHANGELOG.md`; `README.md` (brief ZFS note if a natural spot).

## Verification

- `node --check` each edited file; `tools/check-mixins.js`; `tools/compose-test.js`.
- `find … -name .zfs -prune -o …` and the rsync arg arrays validated with a shell dry-run
  (arg construction; `bash -n` / `find` on a fixture dir containing a `.zfs` folder to
  confirm it's pruned only when the ZFS branch is taken).
- Manual browser smoke (per-user symlink): plugin loads clean; a copy still works; search
  still returns results. (True ZFS behavior needs a ZFS pool — documented as a manual
  check for the user.)
