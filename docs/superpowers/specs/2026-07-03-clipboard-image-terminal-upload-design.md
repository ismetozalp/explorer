# Clipboard-image → temp upload → terminal path

**Date:** 2026-07-03
**Status:** Approved design, pending implementation
**Component:** Explorer Cockpit plugin — integrated terminal (`js/app.js`, `index.html`)

## Problem

The plugin is served over Cockpit from a **remote** machine; the browser runs on the
user's **local** machine. Users run Claude Code inside a **tmux** session in the plugin's
integrated xterm terminal and want to paste a locally-copied image (e.g. a screenshot)
into that session.

This cannot work through the terminal today: the xterm ↔ Cockpit PTY channel
(`js/app.js` `_mountTerminal`) carries **text only** (`xterm.onData(d => channel.send(d))`).
Any clipboard-image read Claude attempts runs `xclip`/`wl-paste` on the **remote**
machine, whose clipboard is empty/headless — the image is on the local machine. Result:
"no image found on clipboard".

## Key insight

The plugin's JavaScript runs in the **local** browser, so it already has access to the
local clipboard. We read the image in the browser and reuse the plugin's existing
upload path (`_doUpload`: base64 → `base64 -d > dest` over a Cockpit channel) to place
the file on the remote filesystem, then type its path into the terminal. The PTY is
never asked to carry image bytes.

### Why it works on both HTTP and HTTPS

The reliable, cross-protocol read is the DOM **`paste` event** (`e.clipboardData.items`),
which exposes image data even on plain HTTP with no secure context and no permission
prompt. `navigator.clipboard.read()` (HTTPS-only, permission-gated) is used only as a
one-click nicety for the toolbar button, with a `paste`-event modal fallback so the
button also works on HTTP.

## Design

### 1. New settings (`DEFAULT_SETTINGS`, `js/app.js`)

| Key                  | Default             | Meaning |
|----------------------|---------------------|---------|
| `clipboardUploadDir` | `/tmp/explorer-clip`| Remote dir images are written to. World-readable temp so Claude or any other program can open the file. |
| `clipboardKeepHours` | `24`                | On each upload, prune `clip-*` files in that dir older than this many hours. `0` = never prune. |

Both surfaced as fields in the settings modal (`index.html`). Loaded/merged/saved by the
existing settings machinery (deep-merge over defaults → YAML at
`~/.config/cockpit/explorer/settings.yml`).

### 2. Core helper — `_uploadClipboardImageBlob(blob, termId)` (`js/app.js`)

1. Choose extension from `blob.type`: `image/png`→png, `image/jpeg`→jpg, `image/gif`→gif,
   `image/webp`→webp, else png.
2. `dir = settings.clipboardUploadDir || '/tmp/explorer-clip'`;
   `dest = <dir>/clip-<Date.now()>-<rand>.<ext>` (`rand` = short `Math.random()` suffix —
   both APIs are available in the browser).
3. `mkdir -p <dir>` (best-effort, via `FS.mkdir` / `cockpit.spawn`).
4. Prune when `clipboardKeepHours > 0` (best-effort, ignore failure):
   `find <dir> -maxdepth 1 -name 'clip-*' -mmin +<hours*60> -delete`.
   Scoped to `clip-*` in that one dir only — never touches other files.
5. Upload by reusing `_doUpload(op, dest, blob, {})` under a `_beginOp('Paste image')`.
   `_doUpload` already `readAsDataURL`s a Blob and does not depend on `file.name`
   (we compute `dest` ourselves).
6. On success: `_getTermInstance(termId).channel.send(dest + '\r')` — types the absolute
   path and presses Enter into the PTY (→ tmux active pane → Claude). Also toast the path
   and best-effort copy it to the local clipboard (`navigator.clipboard.writeText`).
7. On failure: toast the error (no admin/root retry — `/tmp` is world-writable; a custom
   dir that is not writable surfaces as a clear error).

### 3. Ctrl+V intercept (`_mountTerminal`, `js/app.js`)

After `xterm.open(container)`, add a **capture-phase** `paste` listener on
`xterm.textarea`:

```js
xterm.textarea.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const blob = it.getAsFile();
            if (blob) this._uploadClipboardImageBlob(blob, termId);
            return;
        }
    }
    // no image → do nothing → xterm's native text paste proceeds unchanged
}, true);
```

**Text paste is unaffected:** for non-image clipboards the handler calls neither
`preventDefault` nor `stopImmediatePropagation`, so the event proceeds to xterm exactly
as today (Ctrl+V and Ctrl+Shift+V both keep working). Capture phase guarantees we run
before xterm's own bubble-phase handler when an image *is* present.

**Edge case:** a clipboard carrying both an image and text (some file managers on file
copy) → the image wins, text is not pasted. Rare; acceptable/expected.

### 4. Toolbar button (`index.html` term sub-tab bar + `pasteClipboardImageToTerminal(tab)`)

A small button on the terminal sub-tab bar (near `term-tabbar-spacer`). On click, resolve
the active `termId`, then:

1. If `navigator.clipboard?.read` is available (HTTPS + permission granted): read items,
   find the first `image/*`, get its blob → `_uploadClipboardImageBlob`. One click.
2. If that API is absent or throws `NotAllowedError`/`SecurityError` (HTTP or blocked):
   open a small Bootstrap modal with a focused paste target and the text
   "Press Ctrl+V to paste your image here." A one-shot `paste` listener extracts the
   image, uploads it, and closes the modal. Makes the button fully functional on HTTP.
3. If a read succeeded but the clipboard held no image: toast "No image found in clipboard."

### tmux behaviour

`channel.send(dest + '\r')` writes into the PTY running `tmux new-session …`, so the path
lands in the **active tmux pane** (the Claude session) and Enter submits it. Consequence
of the chosen "path + Enter" behaviour: whatever is focused in the terminal receives it —
if the user is at a bare shell rather than Claude, the shell will try to run the path as a
command. Accepted.

## Scope / non-goals

- No changes to the PTY channel or terminal data flow.
- No remote clipboard tooling (`xclip`/`wl-clipboard`) — irrelevant to this topology.
- No changes to existing drag-and-drop upload (already works for files).
- Additions only: two settings, one helper, one paste hook, one button + fallback modal.

## Files touched

- `js/app.js` — `DEFAULT_SETTINGS`; `_uploadClipboardImageBlob`; paste listener in
  `_mountTerminal`; `pasteClipboardImageToTerminal` + modal handling.
- `index.html` — settings-modal fields; terminal sub-tab-bar button; paste-fallback modal
  markup.
- `css/explorer.css` — minimal styling for the button and fallback modal (if needed).
