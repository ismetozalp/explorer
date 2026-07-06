# Clipboard-Video Paste (2.2.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users paste a locally-copied **video** file into the integrated terminal exactly the way image paste already works — upload it to the remote temp folder and type its path into the PTY.

**Architecture:** Pure generalization of the existing image-paste flow (`js/features/upload.js` + `js/features/terminal.js`). Widen three `image/`-only MIME filters to accept `image/*` **or** `video/*` via one shared predicate, extend the MIME→extension map with common video types, reword user-facing copy, and unify the single terminal toolbar button. No new upload machinery, no new settings, no playback.

**Tech Stack:** Browser JS (Alpine.js mixins, no build step), Cockpit channels (`cockpit.spawn`/`FS`), xterm.js. Verification via `node --check`, `tools/check-mixins.js`, `tools/compose-test.js`, and a manual Cockpit browser smoke (per-user symlink method).

## Global Constraints

- **No build step** — edit source files directly; JS lives in global mixin objects (`window.ExplorerUpload`, `window.ExplorerTerminal`) spread into `Alpine.data('explorer', …)`.
- **No new npm/runtime dependencies.**
- **Never auto-bump VERSION** except in the explicit VERSION task below; this release is **2.2.0**.
- **Do not echo or store any password**; do not commit/push unless the user asks.
- Preserve the `clip-` filename prefix (pruning depends on it: `find … -name 'clip-*' … -delete`).
- Keep the JS entry-point method names (`pasteClipboardImageToTerminal`, `_uploadClipboardImageBlob`, `_openPasteImageModal`) to avoid wide rename churn — only their internals/copy widen.
- Reference spec: `docs/superpowers/specs/2026-07-06-clipboard-video-paste-design.md`.

---

### Task 1: Media MIME helpers + generalized uploader (`js/features/upload.js`)

**Files:**
- Modify: `js/features/upload.js` — `_clipImageExt` (rename→`_clipMediaExt`, extend), add `_isPasteableMedia`, reword `_uploadClipboardImageBlob` op-label/toast (approx lines 76–128).

**Interfaces:**
- Produces: `_clipMediaExt(mime) → string` (image + video extensions); `_isPasteableMedia(type) → boolean` (true for `image/*` or `video/*`). Both consumed by Tasks 2–3 and by the read/overlay paths in this file.

- [ ] **Step 1: Replace `_clipImageExt` with `_clipMediaExt` (add video types)**

Replace the whole `_clipImageExt` method (currently lines ~76–87) with:

```js
    // Map an image OR video MIME type to a filename extension for pasted
    // clipboard media. Falls back to png for unknown images, mp4 for unknown
    // video, png otherwise.
    _clipMediaExt(mime) {
        switch ((mime || '').toLowerCase()) {
            case 'image/png':      return 'png';
            case 'image/jpeg':     return 'jpg';
            case 'image/gif':      return 'gif';
            case 'image/webp':     return 'webp';
            case 'image/bmp':      return 'bmp';
            case 'image/svg+xml':  return 'svg';
            case 'video/mp4':      return 'mp4';
            case 'video/webm':     return 'webm';
            case 'video/quicktime':return 'mov';
            case 'video/x-matroska':return 'mkv';
            case 'video/x-msvideo':return 'avi';
            case 'video/ogg':      return 'ogv';
            default:
                return String(mime || '').toLowerCase().startsWith('video/') ? 'mp4' : 'png';
        }
    },

    // True for any clipboard item we upload-and-path into the terminal:
    // pasted images and videos. Shared by the terminal Ctrl+V intercept, the
    // navigator.clipboard.read() path, and the fallback overlay so all three
    // stay in sync.
    _isPasteableMedia(type) {
        return !!type && (type.startsWith('image/') || type.startsWith('video/'));
    },
```

- [ ] **Step 2: Point the uploader at `_clipMediaExt` and widen its wording**

In `_uploadClipboardImageBlob` (currently ~line 94), change the ext lookup and the two user-facing strings. Update the doc-comment first line and:

```js
        const ext = this._clipMediaExt(blob.type);
```
```js
        const op = this._beginOp('Paste media');
```
```js
            this.toast('Could not save pasted media: ' + (e.message || e), 'danger');
```
```js
        this.toast('Pasted media → ' + dest, 'success');
```

Also update the method's doc comment: change "Upload a clipboard image Blob" → "Upload a clipboard image **or video** Blob".

- [ ] **Step 3: Widen the one-click `clipboard.read()` filter**

In `pasteClipboardImageToTerminal` (currently ~line 142), replace the image-only `find`:

```js
                    const type = (item.types || []).find(t => this._isPasteableMedia(t));
```

And reword the "nothing found" toast (~line 149):

```js
                this.toast('No image or video found in clipboard', 'info');
```

- [ ] **Step 4: Widen the fallback overlay filter + copy (`_openPasteImageModal`, ~line 160)**

Change the overlay message, aria-label, the paste-handler filter, and the fail toast:

```js
            '  <div class="paste-img-msg">Press Ctrl+V (⌘V) to paste your image or video here</div>' +
            '  <textarea class="paste-img-target" aria-label="Paste image or video here"></textarea>' +
```
```js
                if (it.kind === 'file' && this._isPasteableMedia(it.type)) {
```
```js
            this.toast('No image or video in the paste — nothing uploaded', 'info');
```

- [ ] **Step 5: Syntax + dup-key check**

Run: `node --check js/features/upload.js && node tools/check-mixins.js`
Expected: no output from `node --check`; `check-mixins` prints its OK/no-duplicates result (the new `_isPasteableMedia`/`_clipMediaExt` keys must not collide).

- [ ] **Step 6: Commit**

```bash
git add js/features/upload.js
git commit -m "feat: accept pasted video (not just image) in terminal upload"
```

---

### Task 2: In-terminal Ctrl+V intercept accepts video (`js/features/terminal.js`)

**Files:**
- Modify: `js/features/terminal.js:531` — the paste-listener MIME check in `_mountTerminal`.

**Interfaces:**
- Consumes: `_isPasteableMedia(type)` and `_uploadClipboardImageBlob(blob, termId)` from Task 1 (same Alpine component `this`).

- [ ] **Step 1: Widen the filter**

Replace line ~531:

```js
                    if (it.kind === 'file' && this._isPasteableMedia(it.type)) {
```

Update the block's leading comment: "Image paste:" → "Image/video paste:" and "before xterm's own paste handler) and upload it" stays; adjust "a clipboard image" → "a clipboard image or video" in that comment.

- [ ] **Step 2: Syntax check**

Run: `node --check js/features/terminal.js`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add js/features/terminal.js
git commit -m "feat: terminal Ctrl+V intercept accepts pasted video"
```

---

### Task 3: Toolbar button + settings labels (`index.html`, `html/modals/toolbar.html`)

**Files:**
- Modify: `index.html:444-445` — the single `.term-paste-img` button.
- Modify: `html/modals/toolbar.html:20-21` — the two clipboard settings labels/help text.

**Interfaces:**
- Consumes: nothing new — `pasteClipboardImageToTerminal(tab)` unchanged.

- [ ] **Step 1: Unify the button (emoji + title)**

Replace `index.html` lines 444–445:

```html
                    <button class="term-paste-img" @click="pasteClipboardImageToTerminal(tab)"
                            title="Paste clipboard image or video → upload to temp folder and send its path">📋</button>
```

- [ ] **Step 2: Reword the two settings**

In `html/modals/toolbar.html`, line 20 — change label + help text:

```html
                <div class="mb-2"><label class="form-label">Terminal clipboard-media folder</label><input type="text" class="form-control" x-model="settings.clipboardUploadDir" @change="saveSettings()" placeholder="/tmp/explorer-clip"><small class="form-text text-muted">Remote folder where images or videos pasted into the terminal are saved.</small></div>
```

Line 21 — change label + help text:

```html
                <div class="mb-2"><label class="form-label">Keep pasted media for (hours)</label><input type="number" class="form-control" x-model.number="settings.clipboardKeepHours" @change="saveSettings()" min="0" max="8760"><small class="form-text text-muted">Older clip-* files in that folder are pruned on each paste. 0 = never prune.</small></div>
```

- [ ] **Step 3: Sanity-check the markup edits**

Run: `grep -n "term-paste-img\|clipboard-media folder\|Keep pasted media" index.html html/modals/toolbar.html`
Expected: three matching lines (button in index.html; two labels in toolbar.html).

- [ ] **Step 4: Commit**

```bash
git add index.html html/modals/toolbar.html
git commit -m "feat: unify terminal paste button + settings copy for image/video"
```

---

### Task 4: Composition guard + version, changelog, README

**Files:**
- Modify: `VERSION` → `2.2.0`
- Modify: `CHANGELOG.md` — new 2.2.0 entry
- Modify: `README.md` — paste-section wording (image → image/video)

**Interfaces:**
- Consumes: all prior tasks (full mixin set must still compose).

- [ ] **Step 1: Composition test (guards the whole mixin set still loads)**

Run: `node tools/compose-test.js`
Expected: PASS. Method count rises by the newly-added methods (`_clipMediaExt` replaces `_clipImageExt` = net 0 there; `_isPasteableMedia` = +1). If it asserts a hard-coded count, update that expected number in `tools/compose-test.js` to match and note it in the commit.

- [ ] **Step 2: Bump VERSION**

Set the sole contents of `VERSION` to:

```
2.2.0
```

- [ ] **Step 3: Add CHANGELOG entry**

Prepend a `## 2.2.0` section (match existing CHANGELOG format/date `2026-07-06`) describing: pasted **videos** are now uploaded and path-typed into the terminal exactly like images; the terminal paste button + settings now say "image or video". Read the top of `CHANGELOG.md` first to mirror its exact heading style.

- [ ] **Step 4: Update README paste wording**

Find the terminal clipboard-image paste section: `grep -niE "paste.*image|clipboard.*image|🖼" README.md`. Reword those user-facing mentions to "image or video" / "media" and update the button emoji reference (🖼 → 📋) so the docs match the UI. Do not add new screenshots (out of scope).

- [ ] **Step 5: Final verification sweep**

Run:
```bash
node --check js/features/upload.js && node --check js/features/terminal.js && node tools/check-mixins.js && node tools/compose-test.js && cat VERSION
```
Expected: all pass; `VERSION` prints `2.2.0`.

- [ ] **Step 6: Commit**

```bash
git add VERSION CHANGELOG.md README.md tools/compose-test.js
git commit -m "chore: 2.2.0 — clipboard video paste (docs, changelog, version)"
```

---

## Manual browser smoke (after Task 4, before release)

Not a code task — the human/agent runs this once against Cockpit via the per-user symlink method (`ln -sfn /home/ismet/explorer ~/.local/share/cockpit/explorer`, remove after):

1. Open the plugin, open a terminal tab (or tmux tab).
2. In the OS file manager, copy a small `.mp4`.
3. Focus the terminal, press **Ctrl+V** → expect a `clip-<ts>-<rand>.mp4` in `clipboardUploadDir` and its path typed into the PTY.
4. Click the **📋** button with a video on the clipboard → same result (or the fallback overlay on HTTP, which now says "image or video").
5. Regression: paste an **image** (screenshot) → still works unchanged.

Report actual results; do not claim success without running it.

## Self-Review notes

- **Spec coverage:** §1 ext map → Task 1 Step 1; §2 uploader wording → Task 1 Step 2; §3 three filters → Task 1 Steps 3–4 + Task 2; §4 button → Task 3 Step 1; §5 overlay copy → Task 1 Step 4; §6 settings → Task 3 Step 2; VERSION/CHANGELOG/README → Task 4. No gaps.
- **Type consistency:** `_clipMediaExt`/`_isPasteableMedia` names identical across Tasks 1–2; entry-point names unchanged per Global Constraints.
- **No test runner:** deliberate — this repo verifies with `node --check` + `check-mixins` + `compose-test` + manual smoke, not jest/pytest.
