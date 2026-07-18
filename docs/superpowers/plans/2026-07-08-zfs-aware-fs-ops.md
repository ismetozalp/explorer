# ZFS-Aware Filesystem Operations (2.2.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Explorer's filesystem operations ZFS-aware per-path: skip the `du` space-preflight on ZFS sources, never let search/rsync walk the `.zfs` snapshot dir (only when the path is ZFS), and add `--sparse` to rsync.

**Architecture:** Add a per-path filesystem-type probe to the `FS` module (`js/fs.js`), then branch three call sites on it — the copy/move `du` preflight and the two rsync arg builders in `js/core/fileops.js`, plus the two `find`-based search commands in `js/fs.js`. `df`, `du -sb`, and the `stat %d` same-filesystem check are unchanged (research showed they're already correct on ZFS).

**Tech Stack:** Browser JS (`FS` = IIFE module in `js/fs.js` layered on `cockpit.spawn`; `ExplorerFileOps` global mixin in `js/core/fileops.js`), no build step. Verification: `node --check`, `tools/check-mixins.js`, `tools/compose-test.js`, shell dry-runs of the constructed `find`/`rsync` arg arrays, and a browser load-smoke.

## Global Constraints

- **No build step** — edit source directly. `js/fs.js` is an IIFE exposing a public object; `js/core/fileops.js` is a global mixin (`window.ExplorerFileOps`) spread into the Alpine component.
- **No new npm/runtime dependencies.**
- **Per-path detection, never a global switch** — a host mixes ext4/ext3/zfs; each op probes its own path. Do not cache the fstype across operations.
- **`.zfs` pruning applies ONLY when the path is ZFS** — never risk skipping a real folder literally named `.zfs` on a non-ZFS partition.
- **Never auto-bump VERSION** except in the explicit VERSION task; this release is **2.2.5**.
- Leave `du -sb`, `df --output=avail`, and `sameFilesystem` (`stat -c %d`) unchanged — they are correct on ZFS.
- Do not echo/store any password; commit only what each task says; do not push until a separate user-gated finish step.
- Reference spec: `docs/superpowers/specs/2026-07-08-zfs-aware-fs-ops-design.md`.

## Files touched

- `js/fs.js` — new `fsType`/`isZfs` helpers (exported); `.zfs` prune in `searchFilename` and `searchContent`.
- `js/core/fileops.js` — skip `du` preflight on ZFS source in `_doCopyOrMove`; rsync `--sparse` (always) + `--exclude=.zfs/` (ZFS source) in `_doCopyOrMove` and `_runRsyncRenamed`.
- `VERSION`, `CHANGELOG.md`, `README.md`.

---

### Task 1: `fsType` / `isZfs` per-path helpers (`js/fs.js`)

**Files:**
- Modify: `js/fs.js` — add two async functions in the "Capability + pre-flight helpers" section (near `duSum`/`dfAvail`/`sameFilesystem`, ~lines 356–383) and export them in the public object (~line 354).

**Interfaces:**
- Produces: `FS.fsType(path, opts) → Promise<string>` (lowercased fstype, or `''`); `FS.isZfs(path, opts) → Promise<boolean>`.

- [ ] **Step 1: Add the helpers**

In `js/fs.js`, immediately after the `sameFilesystem` function (ends ~line 383, before the final `})();`), add:

```js
    // Filesystem type for a path. findmnt is most reliable (resolves the exact
    // containing mountpoint; no root); stat -f is the fallback on hosts without
    // util-linux. Returns a lowercased fstype string ('zfs', 'ext4', …) or ''.
    async function fsType(path, opts) {
        try {
            const o = await cockpit.spawn(['findmnt', '-no', 'FSTYPE', '-T', path], spawnOpts(opts));
            const t = o.trim();
            if (t) return t.toLowerCase();
        } catch (e) { /* fall through to stat -f */ }
        try {
            const o = await cockpit.spawn(['stat', '-f', '-c', '%T', path], spawnOpts(opts));
            return o.trim().toLowerCase();
        } catch (e) { return ''; }
    }
    async function isZfs(path, opts) { return (await fsType(path, opts)) === 'zfs'; }
```

- [ ] **Step 2: Export them**

In the public-object return near line 354, which currently ends:

```js
        hasRsync, duSum, dfAvail, sameFilesystem,
    };
```

change that line to:

```js
        hasRsync, duSum, dfAvail, sameFilesystem, fsType, isZfs,
    };
```

- [ ] **Step 3: Syntax check**

Run: `node --check js/fs.js`
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add js/fs.js
git commit -m "feat: FS.fsType/isZfs per-path filesystem detection (findmnt→stat -f)"
```

---

### Task 2: `.zfs` prune in search (`js/fs.js`)

**Files:**
- Modify: `js/fs.js` — `searchFilename` (~lines 267–296) and `searchContent`'s enumerate command (~lines 304–308).

**Interfaces:**
- Consumes: `isZfs(root, opts)` from Task 1 (same module scope — call it bare as `isZfs`, not `FS.isZfs`).
- Produces: no signature change.

- [ ] **Step 1: Prune `.zfs` in `searchFilename`**

The current command build in `searchFilename` is:

```js
        const cmd = ['find', root,
                     ...(recursive ? [] : ['-maxdepth', '1']),
                     '-mindepth', '1',
                     flag, pattern,
                     '-printf', fmt];
```

Replace it with (detect ZFS, prune only then):

```js
        const zfs = await isZfs(root, opts).catch(() => false);
        const prune = zfs ? ['-name', '.zfs', '-prune', '-o'] : [];
        const cmd = ['find', root,
                     ...(recursive ? [] : ['-maxdepth', '1']),
                     '-mindepth', '1',
                     ...prune,
                     flag, pattern,
                     '-printf', fmt];
```

- [ ] **Step 2: Prune `.zfs` in `searchContent` enumerate**

The current enumerate command in `searchContent` is:

```js
        const findCmd = ['find', root,
                         ...(recursive ? [] : ['-maxdepth', '1']),
                         '-mindepth', '1', '-type', 'f', '-print0'];
```

Replace it with:

```js
        const zfs = await isZfs(root, opts).catch(() => false);
        const prune = zfs ? ['-name', '.zfs', '-prune', '-o'] : [];
        const findCmd = ['find', root,
                         ...(recursive ? [] : ['-maxdepth', '1']),
                         '-mindepth', '1',
                         ...prune,
                         '-type', 'f', '-print0'];
```

- [ ] **Step 3: Syntax check + prune-idiom dry-run**

Run:
```bash
node --check js/fs.js
tmp=$(mktemp -d); mkdir -p "$tmp/.zfs/snapshot/x" "$tmp/real"; touch "$tmp/real/hit.txt" "$tmp/.zfs/snapshot/x/hit.txt"
echo "--- WITH prune (zfs branch): should list only ./real/hit.txt ---"
find "$tmp" -mindepth 1 -name .zfs -prune -o -iname '*hit*' -printf '%p\n'
echo "--- WITHOUT prune (non-zfs branch): lists both (incl. under .zfs) ---"
find "$tmp" -mindepth 1 -iname '*hit*' -printf '%p\n'
rm -rf "$tmp"
```
Expected: `node --check` silent. The WITH-prune output lists the `real/hit.txt` path and the `.zfs` dir entry is NOT descended (no `.zfs/snapshot/...` path printed); the WITHOUT-prune output includes a `.zfs/snapshot/x/hit.txt` path. This confirms the prune idiom skips the snapshot tree only on the ZFS branch.

- [ ] **Step 4: Commit**

```bash
git add js/fs.js
git commit -m "fix: prune .zfs snapshot dir in search when the root is ZFS"
```

---

### Task 3: Skip `du` preflight on ZFS source (`js/core/fileops.js`)

**Files:**
- Modify: `js/core/fileops.js` — the disk-space preflight block in `_doCopyOrMove` (~lines 173–197).

**Interfaces:**
- Consumes: `FS.isZfs(path, opts)` from Task 1; `Util.dirname`.
- Produces: local `const srcZfs` in `_doCopyOrMove`, reused by Task 4.

- [ ] **Step 1: Detect the source filesystem and gate the du block**

The current preflight block is:

```js
        // 2. Disk-space pre-flight (best effort, capped at 5s)
        op.statusText = 'Checking sizes…';
        try {
            const sumPromise = (async () => {
                let total = 0;
                for (const s of srcs) total += await FS.duSum(s, opts);
                return total;
            })();
            const sized = await Promise.race([
                sumPromise,
                new Promise(r => setTimeout(() => r(null), 5000)),
            ]);
            if (sized != null) {
                const free = await FS.dfAvail(dest, opts);
                if (sized > free) {
                    const ok = await this.askConfirm('Not enough free space',
                        `Source size: ${Util.humanSize(sized)}\nDestination free: ${Util.humanSize(free)}\n\nContinue anyway?`,
                        'Continue');
                    if (!ok) throw new Error('Cancelled by user');
                }
            }
        } catch (e) {
            if (/Cancelled by user/.test(e.message)) throw e;
            // Pre-flight failures are not fatal — proceed without the check.
        }
        op.statusText = '';
        op.progress = 0;
```

Replace it with (detect once; skip the whole `du` block on a ZFS source):

```js
        // 2. Disk-space pre-flight (best effort, capped at 5s). Skipped on ZFS:
        //    `du` there is a slow tree-walk and (with dest compression) can only
        //    over-warn — `df` governs the real write, returning ENOSPC if it
        //    truly runs out. `srcZfs` is reused by the rsync step below.
        const srcZfs = await FS.isZfs(Util.dirname(srcs[0]), opts).catch(() => false);
        op.statusText = 'Checking sizes…';
        if (!srcZfs) try {
            const sumPromise = (async () => {
                let total = 0;
                for (const s of srcs) total += await FS.duSum(s, opts);
                return total;
            })();
            const sized = await Promise.race([
                sumPromise,
                new Promise(r => setTimeout(() => r(null), 5000)),
            ]);
            if (sized != null) {
                const free = await FS.dfAvail(dest, opts);
                if (sized > free) {
                    const ok = await this.askConfirm('Not enough free space',
                        `Source size: ${Util.humanSize(sized)}\nDestination free: ${Util.humanSize(free)}\n\nContinue anyway?`,
                        'Continue');
                    if (!ok) throw new Error('Cancelled by user');
                }
            }
        } catch (e) {
            if (/Cancelled by user/.test(e.message)) throw e;
            // Pre-flight failures are not fatal — proceed without the check.
        }
        op.statusText = '';
        op.progress = 0;
```

(Note: the `if (!srcZfs) try { … } catch { … }` form is valid JS — a `try` statement is the single statement governed by the `if`.)

- [ ] **Step 2: Syntax check**

Run: `node --check js/core/fileops.js`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add js/core/fileops.js
git commit -m "feat: skip du space-preflight when the copy/move source is ZFS"
```

---

### Task 4: rsync `--sparse` (always) + `.zfs` exclude (ZFS source) (`js/core/fileops.js`)

**Files:**
- Modify: `js/core/fileops.js` — the rsync arg array in `_doCopyOrMove` (~line 236) and in `_runRsyncRenamed` (~lines 283–291).

**Interfaces:**
- Consumes: `srcZfs` (already computed in `_doCopyOrMove`, Task 3); `FS.isZfs`/`Util.dirname` (for `_runRsyncRenamed`, which has no `srcZfs` yet).
- Produces: no signature change.

- [ ] **Step 1: `_doCopyOrMove` rsync args**

The current line (~236) is:

```js
        const args = ['rsync', '-a', '--info=progress2', '--no-i-r'];
```

Replace with:

```js
        const args = ['rsync', '-a', '--sparse', '--info=progress2', '--no-i-r'];
        if (srcZfs) args.push('--exclude=.zfs/');
```

(`srcZfs` is in scope from Task 3 — same function.)

- [ ] **Step 2: `_runRsyncRenamed` rsync args**

`_runRsyncRenamed(op, src, fullTarget, mode, isDir, opts)` currently builds:

```js
        const args = ['rsync', '-a', '--info=progress2', '--no-i-r'];
        if (mode === 'move') args.push('--remove-source-files');
        args.push('--', s, t);
        return this._rsyncRun(op, args, opts);
```

This method is not `async`. Make it `async` and detect the source fs (its own `src`):

```js
    async _runRsyncRenamed(op, src, fullTarget, mode, isDir, opts) {
```

and replace the arg block with:

```js
        const srcZfs = await FS.isZfs(Util.dirname(src), opts).catch(() => false);
        const args = ['rsync', '-a', '--sparse', '--info=progress2', '--no-i-r'];
        if (srcZfs) args.push('--exclude=.zfs/');
        if (mode === 'move') args.push('--remove-source-files');
        args.push('--', s, t);
        return this._rsyncRun(op, args, opts);
```

The one caller, `_doRenamedTransfer` (~line 272), already `await`s it: `await this._runRsyncRenamed(...)` — so making it `async` is safe (it returned a promise before, too).

- [ ] **Step 3: Syntax check + rsync arg dry-run**

Run:
```bash
node --check js/core/fileops.js
echo "--- rsync dry-run: --sparse accepted, .zfs excluded (no real transfer) ---"
tmp=$(mktemp -d); mkdir -p "$tmp/src/.zfs/snapshot" "$tmp/dst"; touch "$tmp/src/keep.txt" "$tmp/src/.zfs/snapshot/snap.txt"
rsync -a --sparse --exclude=.zfs/ --dry-run --itemize-changes "$tmp/src/" "$tmp/dst/" | grep -E 'keep.txt|\.zfs' || true
rm -rf "$tmp"
```
Expected: `node --check` silent. The rsync dry-run lists `keep.txt` and does **not** list anything under `.zfs/` (the exclude works; `--sparse` is accepted without error).

- [ ] **Step 4: Commit**

```bash
git add js/core/fileops.js
git commit -m "feat: rsync --sparse always; exclude .zfs/ when the source is ZFS"
```

---

### Task 5: Version, changelog, README

**Files:**
- Modify: `VERSION` → `2.2.5`; `CHANGELOG.md`; `README.md`.

**Interfaces:**
- Consumes: all prior tasks (full mixin set must still compose).

- [ ] **Step 1: Full verification sweep**

Run:
```bash
node --check js/fs.js && node --check js/core/fileops.js && node tools/check-mixins.js && node tools/compose-test.js
```
Expected: both `node --check` silent; `check-mixins` prints `OK — <n> unique keys …`; `compose-test` prints `OK — component assembled …`. (`fsType`/`isZfs` are on the `FS` module, not the Alpine component, so the compose method count is unchanged.)

- [ ] **Step 2: Bump VERSION**

Set the sole contents of `VERSION` to:

```
2.2.5
```

- [ ] **Step 3: CHANGELOG entry**

Read the top of `CHANGELOG.md` to mirror its heading/date style, then prepend a `## 2.2.5`
section (date `2026-07-08`) with:
- **ZFS-aware filesystem operations.** On ZFS paths, Explorer no longer runs the slow
  `du` space-preflight before a copy/move (ZFS `df` already reports correct free space and
  returns ENOSPC if a write truly won't fit); filename/content **search** and **rsync**
  copies now skip the `.zfs` snapshot directory so a `snapdir=visible` dataset can't
  inflate sizes or stall traversal. Detection is per-path (`findmnt`/`stat -f`), so mixed
  ext4/ext3/zfs hosts each get the right behavior. Also: rsync now copies with `--sparse`
  so sparse files (e.g. VM images) aren't ballooned to full size.

- [ ] **Step 4: README note**

Run: `grep -niE "rsync|copy|move|search|filesystem|zfs" README.md | head`. Add a short
sentence in the copy/move or search area (whichever is the natural spot) that Explorer is
ZFS-aware: it skips the `du` preflight and the `.zfs` snapshot dir on ZFS paths, and copies
sparsely. Do not add screenshots.

- [ ] **Step 5: Re-verify VERSION**

Run: `cat VERSION`
Expected: `2.2.5`.

- [ ] **Step 6: Commit**

```bash
git add VERSION CHANGELOG.md README.md
git commit -m "chore: 2.2.5 — ZFS-aware fs operations (docs, changelog, version)"
```

---

## Manual browser smoke (after Task 5, before release)

Not a code task. Run against Cockpit via the per-user symlink
(`ln -sfn /home/ismet/explorer ~/.local/share/cockpit/explorer`, remove after), sourcing
credentials from `~/.config/.claude/cockpit-credentials.json` so no password is recorded.

1. Plugin loads clean (toolbar, file list, Settings modal open/close), **0 JS errors**.
2. A **copy** of a small file still completes (rsync `--sparse` path exercised).
3. **Search** (filename + content) in a normal ext4 folder still returns results (non-ZFS
   branch: command unchanged).

True ZFS behavior (du-skip, `.zfs` prune) needs a ZFS pool to exercise end-to-end — note it
as a manual check for the user on their ZFS partition: copy from a ZFS source (no
"checking sizes" du delay / no spurious space warning) and search a dataset with
`snapdir=visible` (no snapshot-tree traversal). Report actual results; don't claim ZFS
behavior verified without a pool.

## Self-Review notes

- **Spec coverage:** §1 detection → Task 1; §2 du-skip → Task 3; §3 search prune → Task 2;
  §4 rsync (both sites) → Task 4; VERSION/CHANGELOG/README → Task 5. No gaps.
- **Type consistency:** `fsType`/`isZfs` defined Task 1, consumed as `isZfs` (bare, same
  module) in Task 2 and `FS.isZfs` (cross-module) in Tasks 3–4; `srcZfs` produced in Task 3
  and reused in Task 4 Step 1; `_runRsyncRenamed` becomes `async` (Task 4 Step 2) and its
  sole `await`ing caller is unaffected.
- **No test runner:** deliberate — verification is `node --check` + `check-mixins` +
  `compose-test` + the shell dry-runs above + manual smoke, not jest/pytest.
- **Ordering:** Tasks 3 and 4 both edit `_doCopyOrMove`; do them in order and re-read the
  function before Task 4 (Task 3 shifts line numbers).
