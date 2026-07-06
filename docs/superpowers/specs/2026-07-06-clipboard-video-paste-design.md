# Clipboard-video paste → terminal (extend image paste)

**Date:** 2026-07-06
**Status:** Approved design, pending implementation
**Version:** 2.2.0
**Component:** Explorer Cockpit plugin — integrated terminal
(`js/features/upload.js`, `js/features/terminal.js`, `index.html`, `html/modals/toolbar.html`, `css/explorer.css`)

## Problem

The plugin already pastes a locally-copied **image** into the remote terminal (see
`2026-07-03-clipboard-image-terminal-upload-design.md`): read the blob in the local
browser, upload it to `clipboardUploadDir` as `clip-<ts>-<rand>.<ext>`, then type the
path + Enter into the PTY (→ tmux → Claude Code). Users now want the same for **video**
files (e.g. drag a screen-recording onto the clipboard, paste it into a Claude session).

## Key insight

A **video file** copied in Finder/Explorer is a *file reference*, not raw bytes. It is
exposed by the DOM **`paste` event** (`e.clipboardData.items`, `kind:'file'`,
`type:'video/mp4'`) — exactly the mechanism the image feature already uses on its
paste paths. `navigator.clipboard.read()` (the one-click toolbar path) almost never
exposes video files, so video will in practice arrive via the two paste-event paths; the
one-click path is extended for completeness but is expected to catch images far more
often than video. No new upload machinery is needed — only the MIME filters, the
extension map, and user-facing labels widen from image-only to image+video.

## Design

The change is a **generalization**, not new plumbing. Unify the existing "paste image"
flow to accept `image/*` **or** `video/*`.

### 1. Extension map — `_clipImageExt` → `_clipMediaExt` (`js/features/upload.js`)

Rename and extend the existing MIME→extension switch to also cover common video types:

| MIME              | ext  |
|-------------------|------|
| `image/*`         | (unchanged: png/jpg/gif/webp/bmp/svg) |
| `video/mp4`       | mp4  |
| `video/webm`      | webm |
| `video/quicktime` | mov  |
| `video/x-matroska`| mkv  |
| `video/x-msvideo` | avi  |
| `video/ogg`       | ogv  |
| `video/mpeg`/other `video/*` | fallback `mp4` |
| non-media fallback | png (unchanged) |

Keep a thin `_clipImageExt` alias delegating to `_clipMediaExt` if any caller still
references it (none expected after this change — direct rename).

### 2. Uploader stays blob-agnostic (`_uploadClipboardImageBlob`)

The uploader already accepts any Blob and computes `dest` itself; only cosmetic changes:
- extension now from `_clipMediaExt(blob.type)`;
- op label + success toast say "media" (e.g. `_beginOp('Paste media')`, toast
  `'Pasted media → ' + dest`). The `clip-` filename prefix is unchanged, so pruning
  (`find … -name 'clip-*' … -delete`) still covers pasted videos.

Method name is left as `_uploadClipboardImageBlob` to avoid a wide rename churn; a one-
line comment notes it now handles image **and** video blobs. (Renaming is optional
polish, not required.)

### 3. Widen the three MIME filters from `image/` to image-or-video

A single shared predicate keeps the three call sites in sync. Add to upload.js:

```js
_isPasteableMedia(type) {
    return !!type && (type.startsWith('image/') || type.startsWith('video/'));
}
```

Apply it at:
- **`js/features/terminal.js`** in-terminal Ctrl+V intercept (`_mountTerminal`, the
  `it.kind === 'file' && it.type.startsWith('image/')` check).
- **`js/features/upload.js`** `pasteClipboardImageToTerminal` — the
  `navigator.clipboard.read()` loop's `types.find(t => t.startsWith('image/'))`.
- **`js/features/upload.js`** `_openPasteImageModal` — the overlay paste handler's
  `it.type.startsWith('image/')` check.

Behaviour is otherwise identical: text/non-media pastes still fall through untouched
(no `preventDefault`/`stopImmediatePropagation`), so the terminal's native text paste
is unaffected.

### 4. Toolbar button (`index.html`)

Unify the existing single button (per user decision — one button, not a second one):
- emoji `🖼` → `📋` (neutral "paste media"); title →
  `"Paste clipboard image or video → upload to temp folder and send its path"`.
- No new button, no JS entry-point rename (`pasteClipboardImageToTerminal` kept).

### 5. Fallback overlay copy (`_openPasteImageModal`, upload.js)

Overlay text "Press Ctrl+V (⌘V) to paste your image here" →
"…paste your image or video here"; aria-label and the "No image in the paste" toast
reworded to "media". Method name kept.

### 6. Settings labels (`html/modals/toolbar.html`)

The two existing settings (`clipboardUploadDir`, `clipboardKeepHours`) are unchanged in
behaviour; only their labels/help text widen from "image" to "image or video" /
"media". No new settings.

## Scope / non-goals

- **No in-browser video playback** and no server stream proxy — this is upload-a-file,
  identical topology to the image feature.
- No changes to the PTY channel, upload machinery (`_doUpload`), pruning, or drag-drop.
- No new settings; no second button.
- Large videos: uploaded via the existing base64-over-channel `_doUpload` path, same as
  any large file today. No new size cap is introduced (out of scope); if this proves a
  problem it is a separate follow-up.

## Files touched

- `js/features/upload.js` — `_clipMediaExt` (rename+extend `_clipImageExt`);
  `_isPasteableMedia` helper; op-label/toast wording; `clipboard.read()` filter; overlay
  filter + copy.
- `js/features/terminal.js` — Ctrl+V intercept MIME filter → `_isPasteableMedia`.
- `index.html` — terminal sub-tab-bar button emoji + title.
- `html/modals/toolbar.html` — settings label wording.
- `css/explorer.css` — none expected (button reuses `.term-paste-img`); adjust only if
  the emoji swap needs it.
- `VERSION` → `2.2.0`; `CHANGELOG.md`; `README.md` (paste section wording).

## Verification

- `node --check` on each edited JS file.
- `node tools/check-mixins.js` (no duplicate keys after adding `_isPasteableMedia`).
- `node tools/compose-test.js` (composition still loads; key/method count +1 method).
- Manual browser smoke via the per-user symlink: copy a small `.mp4` in the OS file
  manager → focus a terminal → Ctrl+V → file lands in `clipboardUploadDir` as
  `clip-*.mp4` and its path is typed into the PTY. Image paste still works unchanged.
