# 2.2.1 — Chunked upload + terminal auto-reconnect

**Date:** 2026-07-07
**Status:** Approved design, pending implementation
**Version:** 2.2.1
**Component:** Explorer Cockpit plugin — integrated terminal & upload
(`js/features/upload.js`, `js/features/terminal.js`, `js/runtime.js`, `html/modals/toolbar.html`)

## Problem

Two related field bugs:

1. **Pasting a video (or large image) disconnects Cockpit.** The Reconnect overlay
   appears and the whole session drops.
2. **After a Cockpit restart / disconnect, tmux terminals come back blank** — the pane
   is empty until a keypress or resize; plain terminals never reconnect at all.

## Root causes (confirmed)

### Bug 1 — unbounded single `channel.send`
Cockpit chunks *every* channel payload into **64 KiB** slices via its own internal
helper `Me(e, s, n = 64*1024)` (used by `cockpit.spawn` input, `cockpit.http`, …) before
writing to the WebSocket. Explorer's `_doUpload` (`js/features/upload.js`) bypasses that
and calls the **raw** `channel.send(b64)` with the entire base64 string
(`readAsDataURL` → ~1.33× file size). Images stay under Cockpit's hard `too-large`
limit; a video (tens of MB) exceeds it, Cockpit raises `too-large` ("Too much data") and
**tears down the whole transport** → Reconnect overlay. The `uploadChunkMB: 4` setting
in `DEFAULT_SETTINGS` was never wired into the send path (and 4 MB would still blow the
64 KiB budget) — it is dead and misleading.

### Bug 2 — no terminal reconnect + tmux reattach doesn't repaint
`reload_after_disconnect` is `false` in Cockpit, so a transport drop does **not** reload
the page — the transport reconnects but every terminal's channel is already dead.
Explorer's channel-`close` handler (`terminal.js`) only writes `[channel error …]` into
the xterm; there is **no transport-level reconnect anywhere** (the only `focus`/
`visibilitychange` listener just refreshes GitHub state). So terminals freeze. When the
user reloads, `_restoreTmuxTabs` reattaches via `tmux new-session -A`, but **tmux only
issues a full repaint on an actual client-size change** — reattaching at the same size
leaves the fresh xterm blank.

Note the two bugs are linked: Bug 1's oversized paste is itself one of the transport
drops that then triggers Bug 2. Fixing Bug 1 stops paste-caused drops; fixing Bug 2 lets
a genuine `systemctl restart cockpit` or network blip recover cleanly.

## Design

### Fix 1 — chunk the upload send (`_doUpload`, upload.js)

Replace the single `channel.send(b64)` with a 64 KiB send loop that mirrors Cockpit's own
`Me` helper, then signal done:

```js
const CHUNK = 64 * 1024;                 // match Cockpit's internal frame chunk
for (let i = 0; i < b64.length; i += CHUNK) channel.send(b64.slice(i, i + CHUNK));
channel.control({ command: 'done' });
```

`base64 -d` is a stream decoder: it concatenates the incoming stream and decodes 4 chars
→ 3 bytes regardless of where the chunk boundaries fall, so slicing the base64 string at
arbitrary 64 KiB offsets is safe. No other change to `_doUpload` (op lifecycle, admin
retry, error handling all unchanged). This path is shared by drag-drop upload, clipboard
image/video paste, and tree upload, so all of them are fixed at once.

**Remove the dead setting.** Delete `uploadChunkMB` from `DEFAULT_SETTINGS`
(`js/runtime.js`) and its field from the settings modal (`html/modals/toolbar.html`) —
it controls nothing and implies user-tunable behavior that does not exist. The 64 KiB
chunk is a Cockpit-transport constant, not a user preference.

### Fix 2 — auto-reconnect terminals + force tmux repaint (terminal.js)

**(a) Reconnect on transport-level close.** In `_mountTerminal`'s channel `close`
handler, distinguish a transport drop from a clean shell exit:

- `options.problem` set (e.g. `terminated`, `disconnected`, `not-found`, `protocol-error`)
  **and** not `cancelled` → transport/connection drop → schedule a reconnect.
- `exit-status` present with no `problem` → the shell genuinely exited → leave the
  `[shell exited (n)]` message, do **not** reconnect.

New helper `_scheduleTermReconnect(termId, dir)`:
1. Abort if the terminal no longer exists in any tab's `terminals` (user closed it) — look
   it up with the existing `_findTermById`.
2. Coalesce: keep a per-terminal reconnect record (attempt count + timer id) in a
   module-scope registry on `ExRT.term` (e.g. `ExRT.term.reconn` map) so overlapping
   closes don't stack timers.
3. Backoff: delays `[500, 1000, 2000, 3000, 5000]` ms, then hold at 5000 ms; cap at ~40
   attempts (~3 min) then stop and write a `[reconnect gave up — reopen the tab]` line.
4. On fire: dispose the stale instance (`ExRT.term.get(termId)` → `term.dispose()`,
   remove its `onWinResize` listener, `ExRT.term.del`), then call
   `_mountTerminal(termId, dir)`. Because the container is keyed by `term-container-<id>`
   in the Alpine `x-for` and the term object stays in `tab.terminals`, the DOM container
   persists and the fresh xterm reuses it.
5. If `_mountTerminal`'s own `cockpit.channel()` throws (transport still down), that path
   must also call `_scheduleTermReconnect` (transport not back yet) instead of only
   toasting — so the poll continues. A successful mount whose channel then closes again
   re-enters the same close handler, which reschedules — this naturally polls until the
   transport is back, at which point the channel stays open (for tmux, `new-session -A`
   reattaches to the surviving session; for a plain shell, a fresh shell spawns, as the
   user chose).
6. On a successful reconnect, reset that terminal's attempt counter and write a
   `[reconnected]` line.

**(b) Force a tmux repaint on (re)attach.** For a tmux-backed terminal (`termObj.tmux`
truthy), after the initial fit + size control in the mount's `$nextTick`, nudge the PTY
size so tmux sees a change and issues a full redraw:

```js
if (tmuxSession) {
    setTimeout(() => {
        const rows = xterm.rows, cols = xterm.cols;
        if (rows > 1) {
            try {
                channel.control({ command: 'options', window: { rows: rows - 1, cols } });
                channel.control({ command: 'options', window: { rows, cols } });
            } catch (e) {}
        }
    }, 120);
}
```

Two `SIGWINCH`es (shrink one row, restore) force tmux to redraw the whole client. On a
dead channel the `control` calls throw and are swallowed (the reconnect poll handles
recovery). The nudge is scoped to tmux terminals so plain shells are untouched. This also
fixes the plain reload → reattach blank, not just the transport-drop path.

## Scope / non-goals

- No change to the PTY data flow, the tmux session model, or `_restoreTmuxTabs` beyond the
  redraw nudge already inside `_mountTerminal`.
- Plain (non-tmux) shells respawn fresh on reconnect (their scrollback/running process is
  gone) — the user's chosen behaviour ("auto-reconnect everything").
- No new setting is added; one dead setting is removed.
- No visual "Reconnect" button (auto-reconnect covers it).

## Files touched

- `js/features/upload.js` — chunked send loop in `_doUpload`.
- `js/runtime.js` — remove `uploadChunkMB` from `DEFAULT_SETTINGS`.
- `html/modals/toolbar.html` — remove the "Upload chunk size (MB)" field.
- `js/features/terminal.js` — reconnect-on-transport-close in the `close` handler; the
  channel-throw path reschedules; new `_scheduleTermReconnect`; tmux redraw nudge; a
  `ExRT.term.reconn` registry (may live in `js/runtime.js` next to `ExRT.term`).
- `VERSION` → `2.2.1`; `CHANGELOG.md`; `README.md` (terminal reconnect note; drop the
  clipboard chunk-size mention if the README documents that setting).

## Verification

- `node --check` on each edited JS file; `node tools/check-mixins.js`;
  `node tools/compose-test.js` (component still assembles; `_scheduleTermReconnect` present).
- Manual browser smoke (per-user symlink):
  - Paste a large `.mp4` → it uploads with **no** Cockpit disconnect; file lands as
    `clip-*.mp4`, path typed into the PTY.
  - Open a tmux session, run something with visible output, then `sudo systemctl restart
    cockpit` (or kill cockpit-ws). After the transport recovers, the tmux pane
    **auto-reattaches and repaints** (not blank), and a plain terminal respawns.
