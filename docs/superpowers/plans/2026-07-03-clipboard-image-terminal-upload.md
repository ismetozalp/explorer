# Clipboard-image Terminal Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user paste a locally-copied image into the plugin's integrated terminal; the plugin uploads it to a temp folder on the remote machine and types the file's path + Enter into the terminal (→ tmux → Claude).

**Architecture:** All image bytes are read in the *local browser* (via the DOM `paste` event, or `navigator.clipboard.read()` on HTTPS), then streamed to the remote using the plugin's existing base64 upload channel (`_doUpload` → `base64 -d > dest`). The PTY channel is never asked to carry image bytes. A Ctrl+V intercept handles the common case; a toolbar button (with an HTTP-safe paste-modal fallback) provides an explicit entry point.

**Tech Stack:** Vanilla JS + Alpine.js, xterm.js, Cockpit channels, Bootstrap 5 (already vendored). No build step, no test runner.

## Global Constraints

- **No new dependencies.** Everything ships vendored already; add none.
- **Must work on both HTTP and HTTPS.** The `paste`-event path (Ctrl+V intercept and the button's modal fallback) is the cross-protocol guarantee; `navigator.clipboard.read()` is a HTTPS-only nicety only.
- **Text paste must remain byte-for-byte unchanged.** Only clipboards containing an `image/*` file are intercepted.
- **Prune only touches `clip-*` files** inside the configured dir — never other files.
- **Follow existing code style** in `js/app.js`: methods are properties on the Alpine component object (`name(args) { … },`), 4-space indent, `this.toast(msg, level)` for user feedback, `Util.*`/`FS.*`/`cockpit.*` helpers.
- **No test runner exists.** The automated gate for every JS change is `node --check js/app.js`. Functional verification is a manual browser checklist after `sudo make install` + hard-reload of the Explorer page.

### Verification loop (used by every task)

1. Automated syntax gate: `node --check js/app.js` (must print nothing / exit 0).
2. Deploy: `sudo make install` (copies the repo to `/usr/share/cockpit/explorer`).
3. In the browser, open **Tools → Explorer** and hard-reload (Ctrl+Shift+R). No Cockpit restart needed — `manifest.json` is unchanged.
4. Perform the task's manual checklist and confirm the expected observations.

---

### Task 1: Settings defaults + core upload helper

**Files:**
- Modify: `js/app.js` — `DEFAULT_SETTINGS` (around line 6–17); add two methods near the other upload helpers (after `_doUpload`, ~line 2067).

**Interfaces:**
- Consumes: `_getTermInstance(termId)` → `{ term, channel, … }`; `_doUpload(op, dest, fileOrBlob, opts)`; `_beginOp(label)`, `_endOp(op, status)`, `_failOp(op, err, retryFn?)`; `FS.mkdir(path)`; `Util.joinPath(a, b)`; `cockpit.spawn(argv, opts)`; `this.toast(msg, level)`; `this.settings`.
- Produces:
  - `settings.clipboardUploadDir: string` (default `'/tmp/explorer-clip'`)
  - `settings.clipboardKeepHours: number` (default `24`)
  - `_clipImageExt(mime: string) → string`
  - `async _uploadClipboardImageBlob(blob: Blob, termId: string) → void`

- [ ] **Step 1: Add the two settings defaults**

In `DEFAULT_SETTINGS`, after the `updateCheckOnStart: true,` line:

```js
    updateCheckOnStart: true,           // auto-check for a newer release at startup
    clipboardUploadDir: '/tmp/explorer-clip', // remote dir for pasted terminal images
    clipboardKeepHours: 24,             // prune clip-* older than this many hours on paste (0 = never)
```

- [ ] **Step 2: Add the extension helper**

Immediately after the `_doUpload(op, dest, file, opts) { … },` method (ends ~line 2067), add:

```js
    // Map an image MIME type to a filename extension for pasted clipboard images.
    _clipImageExt(mime) {
        switch ((mime || '').toLowerCase()) {
            case 'image/png':     return 'png';
            case 'image/jpeg':    return 'jpg';
            case 'image/gif':     return 'gif';
            case 'image/webp':    return 'webp';
            case 'image/bmp':     return 'bmp';
            case 'image/svg+xml': return 'svg';
            default:              return 'png';
        }
    },
```

- [ ] **Step 3: Add the core upload helper**

Directly after `_clipImageExt`, add:

```js
    // Upload a clipboard image Blob (already extracted in the browser) to the
    // remote clipboardUploadDir, then type its path + Enter into the given
    // terminal (→ tmux active pane → Claude). Cross-protocol: the Blob was
    // obtained by the caller from a paste event or clipboard read, so no secure
    // context is required here. Best-effort prune of old clip-* files first.
    async _uploadClipboardImageBlob(blob, termId) {
        if (!blob) return;
        const inst = _getTermInstance(termId);
        if (!inst || !inst.channel) { this.toast('Terminal not ready for paste', 'warning'); return; }

        const dir = (this.settings.clipboardUploadDir || '/tmp/explorer-clip').replace(/\/+$/, '') || '/';
        const ext = this._clipImageExt(blob.type);
        const rand = Math.random().toString(36).slice(2, 8);
        const dest = Util.joinPath(dir, `clip-${Date.now()}-${rand}.${ext}`);

        const op = this._beginOp('Paste image');
        try {
            await FS.mkdir(dir);
            const hours = Number(this.settings.clipboardKeepHours);
            if (Number.isFinite(hours) && hours > 0) {
                const mins = Math.round(hours * 60);
                try {
                    await cockpit.spawn(
                        ['find', dir, '-maxdepth', '1', '-name', 'clip-*', '-type', 'f', '-mmin', '+' + mins, '-delete'],
                        { err: 'ignore' });
                } catch (e) { /* prune is best-effort */ }
            }
            await this._doUpload(op, dest, blob, {});
            this._endOp(op, 'done');
        } catch (e) {
            console.error('Clipboard image upload failed:', e, 'dest:', dest);
            this._failOp(op, e);
            this.toast('Could not save pasted image: ' + (e.message || e), 'danger');
            return;
        }

        try { inst.channel.send(dest + '\r'); } catch (e) {}
        try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(dest).catch(() => {}); } catch (e) {}
        this.toast('Pasted image → ' + dest, 'success');
    },
```

- [ ] **Step 4: Syntax gate**

Run: `node --check js/app.js`
Expected: no output, exit 0.

- [ ] **Step 5: Smoke-test the helper directly in the browser**

Deploy (`sudo make install`) and hard-reload Explorer. Open a terminal tab. Open DevTools console and run (this fabricates a 1×1 PNG Blob and drives the helper against the active terminal):

```js
(async () => {
  const app = document.querySelector('[x-data]')._x_dataStack[0];
  const tab = app.tabs.find(t => t.kind === 'terminal');
  const termId = tab.activeTermId;
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });
  await app._uploadClipboardImageBlob(blob, termId);
})();
```

Expected observations:
- A success toast `Pasted image → /tmp/explorer-clip/clip-….png`.
- The terminal shows the path was typed and Enter pressed (if a shell is focused it will run/complain — that's expected).
- `ls -l /tmp/explorer-clip/` in the terminal shows a `clip-*.png` (~68 bytes).

- [ ] **Step 6: Commit**

```bash
git add js/app.js
git commit -m "feat: clipboard-image settings + _uploadClipboardImageBlob helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Ctrl+V paste intercept in the terminal

**Files:**
- Modify: `js/app.js` — inside `_mountTerminal`, after `xterm.open(container)` and the `fitAddon.fit()` call (~line 5478), before the `attachCustomKeyEventHandler` block.

**Interfaces:**
- Consumes: `xterm.textarea` (the hidden paste target xterm renders); `this._uploadClipboardImageBlob(blob, termId)` from Task 1; `termId` (in scope in `_mountTerminal`).
- Produces: nothing new; wires image pastes into the Task 1 helper.

- [ ] **Step 1: Add the capture-phase paste listener**

In `_mountTerminal`, immediately after:

```js
        xterm.open(container);
        try { fitAddon.fit(); } catch (e) {}
```

insert:

```js
        // Image paste: intercept a clipboard image (capture phase, so we run
        // before xterm's own paste handler) and upload it instead of letting it
        // hit the shell. Text / non-image pastes are untouched — we neither
        // preventDefault nor stopPropagation, so xterm's native paste proceeds.
        // Uses the DOM paste event (clipboardData), which exposes image data on
        // both http and https with no permission prompt.
        if (xterm.textarea) {
            xterm.textarea.addEventListener('paste', (e) => {
                const items = (e.clipboardData && e.clipboardData.items) || [];
                for (const it of items) {
                    if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        const blob = it.getAsFile();
                        if (blob) this._uploadClipboardImageBlob(blob, termId);
                        return;
                    }
                }
                // no image → fall through: xterm handles the text paste as usual
            }, true);
        }
```

- [ ] **Step 2: Syntax gate**

Run: `node --check js/app.js`
Expected: no output, exit 0.

- [ ] **Step 3: Manual browser checklist**

Deploy + hard-reload. Open a terminal tab (ideally attached to a tmux session running Claude, to match the real use case).

- Copy a screenshot to your OS clipboard, click into the terminal, press **Ctrl+V**.
  Expected: success toast with a `/tmp/explorer-clip/clip-….png` path; that path is typed into the terminal and submitted; `ls -l /tmp/explorer-clip/` shows the PNG.
- Copy some **text**, click into the terminal, press **Ctrl+V**.
  Expected: the text pastes exactly as before — no toast, no upload.
- Repeat the text paste with **Ctrl+Shift+V**.
  Expected: still normal text paste, unchanged.

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "feat: intercept image paste in terminal, upload instead of dropping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Toolbar button + HTTP-safe paste modal

**Files:**
- Modify: `index.html` — add a button in the terminal sub-tab bar (after the `term-tabbar-spacer` span, ~line 442).
- Modify: `js/app.js` — add `pasteClipboardImageToTerminal(tab)` and `_openPasteImageModal(termId)` (place next to the Task 1 helpers).
- Modify: `css/explorer.css` — styles for the button and the paste overlay.

**Interfaces:**
- Consumes: `this._uploadClipboardImageBlob(blob, termId)` and `_getTermInstance` (Task 1); `navigator.clipboard.read()` (HTTPS only); `this.toast`.
- Produces:
  - `async pasteClipboardImageToTerminal(tab) → void`
  - `_openPasteImageModal(termId: string) → void`

- [ ] **Step 1: Add the toolbar button (index.html)**

In the terminal sub-tab bar, change:

```html
                    <button class="term-subtab-add" @click="addTerminalToTab(tab, tab.path)" title="New terminal here">+</button>
                    <span class="term-tabbar-spacer"></span>
                </div>
```

to:

```html
                    <button class="term-subtab-add" @click="addTerminalToTab(tab, tab.path)" title="New terminal here">+</button>
                    <span class="term-tabbar-spacer"></span>
                    <button class="term-paste-img" @click="pasteClipboardImageToTerminal(tab)"
                            title="Paste clipboard image → upload to temp folder and send its path">🖼</button>
                </div>
```

- [ ] **Step 2: Add the button handler + modal (js/app.js)**

After `_uploadClipboardImageBlob` (Task 1), add:

```js
    // Toolbar entry point: read a clipboard image and hand it to the uploader.
    // HTTPS + permission → navigator.clipboard.read() (one click). Otherwise
    // (http, or a blocked read) → a small overlay that captures a Ctrl+V paste,
    // which exposes image data even on http.
    async pasteClipboardImageToTerminal(tab) {
        const termId = tab && tab.activeTermId;
        if (!termId || !_getTermInstance(termId)) { this.toast('No active terminal', 'warning'); return; }

        if (navigator.clipboard && navigator.clipboard.read) {
            try {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                    const type = (item.types || []).find(t => t.startsWith('image/'));
                    if (type) {
                        const blob = await item.getType(type);
                        await this._uploadClipboardImageBlob(blob, termId);
                        return;
                    }
                }
                this.toast('No image found in clipboard', 'info');
                return;
            } catch (e) {
                // NotAllowedError / SecurityError (http or blocked) → modal fallback
            }
        }
        this._openPasteImageModal(termId);
    },

    // HTTP-safe fallback: a focused overlay that captures one paste event and
    // extracts an image from it. Built in plain DOM so it needs no Alpine state.
    _openPasteImageModal(termId) {
        const overlay = document.createElement('div');
        overlay.className = 'paste-img-overlay';
        overlay.innerHTML =
            '<div class="paste-img-box">' +
            '  <div class="paste-img-msg">Press Ctrl+V (⌘V) to paste your image here</div>' +
            '  <textarea class="paste-img-target" aria-label="Paste image here"></textarea>' +
            '  <div class="paste-img-hint">Esc to cancel</div>' +
            '</div>';
        document.body.appendChild(overlay);
        const target = overlay.querySelector('.paste-img-target');

        const close = () => {
            document.removeEventListener('keydown', onKey, true);
            try { overlay.remove(); } catch (e) {}
        };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
        document.addEventListener('keydown', onKey, true);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

        target.addEventListener('paste', (e) => {
            e.preventDefault();
            const items = (e.clipboardData && e.clipboardData.items) || [];
            for (const it of items) {
                if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
                    const blob = it.getAsFile();
                    close();
                    if (blob) this._uploadClipboardImageBlob(blob, termId);
                    return;
                }
            }
            this.toast('No image in the paste — nothing uploaded', 'info');
            close();
        });

        setTimeout(() => { try { target.focus(); } catch (e) {} }, 0);
    },
```

- [ ] **Step 3: Add styles (css/explorer.css)**

Append:

```css
/* Terminal sub-tab-bar: paste-clipboard-image button */
.term-paste-img {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 2px 6px;
    opacity: .75;
}
.term-paste-img:hover { opacity: 1; }

/* HTTP-safe "paste your image here" fallback overlay */
.paste-img-overlay {
    position: fixed; inset: 0; z-index: 3000;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, .45);
}
.paste-img-box {
    background: var(--bs-body-bg, #fff);
    color: var(--bs-body-color, #1f2328);
    border: 1px solid var(--bs-border-color, #ccc);
    border-radius: 8px;
    padding: 18px 20px;
    width: min(420px, 90vw);
    box-shadow: 0 8px 30px rgba(0, 0, 0, .3);
    text-align: center;
}
.paste-img-msg { font-size: 14px; margin-bottom: 10px; }
.paste-img-target {
    width: 100%; height: 90px; resize: none;
    border: 1px dashed var(--bs-border-color, #999);
    border-radius: 6px;
    background: transparent; color: inherit;
    padding: 8px;
}
.paste-img-hint { font-size: 12px; opacity: .6; margin-top: 8px; }
```

- [ ] **Step 4: Syntax gate**

Run: `node --check js/app.js`
Expected: no output, exit 0.

- [ ] **Step 5: Manual browser checklist**

Deploy + hard-reload. Open a terminal tab.

- With an image on the clipboard, click the **🖼 button** on the sub-tab bar.
  - On HTTPS: image uploads directly (success toast + path typed), no modal.
  - On HTTP: the "Press Ctrl+V here" overlay appears; press Ctrl+V → image uploads, overlay closes, path typed.
- With **no image** on the clipboard, click 🖼.
  - HTTPS: toast "No image found in clipboard".
  - HTTP: overlay appears; paste text → toast "No image in the paste"; Esc closes it.
- Press **Esc** while the overlay is open → it closes with no upload.

- [ ] **Step 6: Commit**

```bash
git add index.html js/app.js css/explorer.css
git commit -m "feat: terminal toolbar button to paste clipboard image (http-safe fallback)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Settings-modal fields

**Files:**
- Modify: `index.html` — settings modal, after the "Upload chunk size" field (~line 1488).

**Interfaces:**
- Consumes: `settings.clipboardUploadDir`, `settings.clipboardKeepHours` (Task 1); `saveSettings()`.
- Produces: nothing new — UI to edit the two settings.

- [ ] **Step 1: Add the two fields**

After the line:

```html
                <div class="mb-2"><label class="form-label">Upload chunk size (MB)</label><input type="number" class="form-control" x-model.number="settings.uploadChunkMB" min="1" max="64"></div>
```

insert:

```html
                <div class="mb-2"><label class="form-label">Terminal clipboard-image folder</label><input type="text" class="form-control" x-model="settings.clipboardUploadDir" @change="saveSettings()" placeholder="/tmp/explorer-clip"><small class="form-text text-muted">Remote folder where images pasted into the terminal are saved.</small></div>
                <div class="mb-2"><label class="form-label">Keep pasted images for (hours)</label><input type="number" class="form-control" x-model.number="settings.clipboardKeepHours" @change="saveSettings()" min="0" max="8760"><small class="form-text text-muted">Older clip-* files in that folder are pruned on each paste. 0 = never prune.</small></div>
```

- [ ] **Step 2: Syntax gate (HTML has no node --check; verify the app still boots)**

Deploy + hard-reload. Expected: Explorer loads with no console errors; no Alpine template error banner.

- [ ] **Step 3: Manual browser checklist**

- Open **Settings** (gear). The two new fields show current values (`/tmp/explorer-clip`, `24`).
- Change the folder to `/tmp/mypics` and hours to `1`, close settings, reload the page.
  Expected: values persisted (reflected on reload; also present in `~/.config/cockpit/explorer/settings.yml`).
- Paste an image in the terminal.
  Expected: it lands in `/tmp/mypics/` and old `clip-*` files there >1h are pruned.
- Set hours to `0`, paste again.
  Expected: no pruning occurs (no `find … -delete` run).
- Restore folder to `/tmp/explorer-clip` and hours to `24`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: settings fields for clipboard image folder and retention

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Two settings (`clipboardUploadDir`, `clipboardKeepHours`) → Task 1 (defaults) + Task 4 (UI). ✓
- Core helper reusing `_doUpload` + prune + path-into-terminal → Task 1. ✓
- Ctrl+V intercept, image-only, text untouched, capture phase → Task 2. ✓
- Toolbar button, HTTPS `clipboard.read()`, HTTP paste-modal fallback, "no image" toast → Task 3. ✓
- Works on http and https → paste-event paths in Tasks 2 & 3. ✓
- tmux: `channel.send(dest + '\r')` into active pane → Task 1 Step 3. ✓
- Prune scoped to `clip-*` only → Task 1 Step 3 (`find … -name 'clip-*'`). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `_uploadClipboardImageBlob(blob, termId)`, `_clipImageExt(mime)`, `pasteClipboardImageToTerminal(tab)`, `_openPasteImageModal(termId)`, `settings.clipboardUploadDir`, `settings.clipboardKeepHours` — names identical across all tasks. `_getTermInstance(...).channel` matches the instance shape stored in `_mountTerminal`. ✓

**Note on the `_x_dataStack` console smoke-test (Task 1 Step 5):** if that internal accessor differs in this Alpine build, an equivalent is `Alpine.$data(document.querySelector('[x-data]'))`. Either yields the component; the test only needs the `app` object with `.tabs` and `._uploadClipboardImageBlob`.
