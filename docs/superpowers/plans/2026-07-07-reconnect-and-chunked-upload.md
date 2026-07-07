# Chunked Upload + Terminal Auto-Reconnect (2.2.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop large clipboard/upload payloads from disconnecting Cockpit, and make integrated terminals auto-reconnect (tmux reattaching and repainting, plain shells respawning) after any transport drop.

**Architecture:** Two independent fixes. (1) `_doUpload` sends its base64 payload in 64 KiB chunks — matching Cockpit's own internal `Me` frame chunk — instead of one raw `channel.send`, so it never trips Cockpit's `too-large` transport kill. (2) `_mountTerminal`'s channel-`close` handler distinguishes a transport drop from a clean shell exit and schedules a backoff reconnect that disposes the dead xterm and re-mounts (reusing the persistent DOM container); tmux terminals get a one-row size nudge on attach to force a full redraw.

**Tech Stack:** Browser JS (Alpine.js global mixins, no build step), Cockpit stream channels (`cockpit.channel`, `channel.send`, `channel.control`), xterm.js + FitAddon, tmux. Verification: `node --check`, `tools/check-mixins.js`, `tools/compose-test.js`, and a manual Cockpit browser smoke (per-user symlink).

## Global Constraints

- **No build step** — edit source directly. JS methods live in global mixin objects (`window.ExplorerUpload`, `window.ExplorerTerminal`) spread into one Alpine component; all share `this`. Non-reactive registries live on `window.ExRT` (`js/runtime.js`).
- **No new npm/runtime dependencies.**
- **Never auto-bump VERSION** except in the explicit VERSION task; this release is **2.2.1**.
- **Do not echo or store any password.** The Cockpit smoke sources credentials from `~/.config/.claude/cockpit-credentials.json` (keys `host`, `user`, `password`) inside the command so no literal is recorded.
- **Commit/push only what each task says**; do not push to origin until the finishing step (separate, user-gated).
- The 64 KiB upload chunk is a Cockpit-transport constant, **not** a user setting.
- Reference spec: `docs/superpowers/specs/2026-07-07-reconnect-and-chunked-upload-design.md`.

---

### Task 1: Chunk the upload send (`_doUpload`)

**Files:**
- Modify: `js/features/upload.js` — the `r.onload` body of `_doUpload` (around lines 43–71, specifically the send at line 69).

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — `_doUpload(op, dest, file, opts)` behaves identically except the payload is streamed in 64 KiB slices.

- [ ] **Step 1: Replace the single send with a 64 KiB loop**

In `_doUpload`, the current tail of the `r.onload` handler is:

```js
                channel.send(b64);
                channel.control({ command: 'done' });
```

Replace those two lines with:

```js
                // Cockpit's transport chunks every channel payload into 64 KiB
                // frames internally; sending one giant raw message instead trips
                // its `too-large` guard and drops the whole transport (the
                // "Reconnect" overlay). Mirror Cockpit here: stream the base64 in
                // 64 KiB slices. `base64 -d` is a stream decoder, so arbitrary
                // slice boundaries decode correctly.
                const CHUNK = 64 * 1024;
                for (let i = 0; i < b64.length; i += CHUNK) {
                    channel.send(b64.slice(i, i + CHUNK));
                }
                channel.control({ command: 'done' });
```

Leave everything else in `_doUpload` (FileReader, op lifecycle, admin retry, close handler) unchanged.

- [ ] **Step 2: Syntax + dup-key check**

Run: `node --check js/features/upload.js && node tools/check-mixins.js`
Expected: `node --check` silent (success); `check-mixins` prints `OK — <n> unique keys …` with no duplicate-key error.

- [ ] **Step 3: Commit**

```bash
git add js/features/upload.js
git commit -m "fix: stream uploads in 64 KiB chunks to avoid Cockpit too-large disconnect"
```

---

### Task 2: Remove the dead `uploadChunkMB` setting

**Files:**
- Modify: `js/runtime.js` — remove the `uploadChunkMB` key from `ExRT.const.DEFAULT_SETTINGS` (line 15: `uploadChunkMB: 4,`).
- Modify: `html/modals/toolbar.html` — remove the "Upload chunk size (MB)" settings field.

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_SETTINGS` no longer has `uploadChunkMB`; the settings modal no longer shows the field.

- [ ] **Step 1: Confirm the setting is truly unused before deleting**

Run: `grep -rn "uploadChunkMB" js/features js/core js/app.js js/runtime.js html/`
Expected: matches ONLY in `js/runtime.js` (the default) and `html/modals/toolbar.html` (the field). If any other file references it, STOP and report — do not delete.

- [ ] **Step 2: Remove the default**

In `js/runtime.js`, delete the line:

```js
            uploadChunkMB: 4,
```

(Leave the surrounding `DEFAULT_SETTINGS` keys intact; ensure the object remains valid JS — no dangling/again-missing commas.)

- [ ] **Step 3: Remove the settings-modal field**

In `html/modals/toolbar.html`, delete the entire line for the upload-chunk field (currently around line 19):

```html
                <div class="mb-2"><label class="form-label">Upload chunk size (MB)</label><input type="number" class="form-control" x-model.number="settings.uploadChunkMB" min="1" max="64"></div>
```

- [ ] **Step 4: Verify removal + files still parse**

Run:
```bash
grep -rn "uploadChunkMB" js/ html/ ; echo "grep-exit=$?"
node --check js/runtime.js
node tools/compose-test.js
```
Expected: the grep prints nothing and `grep-exit=1` (no matches); `node --check` silent; `compose-test` prints `OK — component assembled …`.

- [ ] **Step 5: Commit**

```bash
git add js/runtime.js html/modals/toolbar.html
git commit -m "chore: remove dead uploadChunkMB setting (never wired into upload path)"
```

---

### Task 3: tmux redraw nudge on (re)attach (`_mountTerminal`)

**Files:**
- Modify: `js/features/terminal.js` — the final `$nextTick` block of `_mountTerminal` (around lines 695–701), which already does the initial fit + size control.

**Interfaces:**
- Consumes: `tmuxSession` (already computed earlier in `_mountTerminal` as `const tmuxSession = termObj && termObj.tmux;`), local `xterm` and `channel`.
- Produces: after a tmux terminal mounts, tmux receives a size change and repaints (no blank pane). No new method.

- [ ] **Step 1: Add the nudge after the existing initial resize**

The current tail of `_mountTerminal` is:

```js
        this.$nextTick(() => {
            try { fitAddon.fit(); } catch (e) {}
            try { xterm.focus(); } catch (e) {}
            try {
                channel.control({ command: 'options', window: { rows: xterm.rows, cols: xterm.cols } });
            } catch (e) {}
        });
    },
```

Replace that block with:

```js
        this.$nextTick(() => {
            try { fitAddon.fit(); } catch (e) {}
            try { xterm.focus(); } catch (e) {}
            try {
                channel.control({ command: 'options', window: { rows: xterm.rows, cols: xterm.cols } });
            } catch (e) {}
            // tmux only issues a full repaint when the client size actually
            // changes. On (re)attach at the same size it stays blank, so nudge
            // the PTY one row smaller then back — two SIGWINCHes force tmux to
            // redraw the whole screen. Scoped to tmux; plain shells are untouched.
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
        });
    },
```

- [ ] **Step 2: Syntax check**

Run: `node --check js/features/terminal.js`
Expected: silent (success).

- [ ] **Step 3: Commit**

```bash
git add js/features/terminal.js
git commit -m "fix: force tmux full redraw on attach so reattached panes aren't blank"
```

---

### Task 4: Auto-reconnect terminals on transport drop (`terminal.js` + `runtime.js`)

**Files:**
- Modify: `js/runtime.js` — add a reconnect registry to `ExRT.term`.
- Modify: `js/features/terminal.js` — the channel `close` handler in `_mountTerminal` (around lines 670–679); the `cockpit.channel()` `catch` block (around lines 659–664); add a new `_scheduleTermReconnect` method.

**Interfaces:**
- Consumes: `_findTermById(termId)` (existing — returns the term object from any tab's `terminals`, or falsy if closed); `ExRT.term.get/del`; `_mountTerminal(termId, dir)`.
- Produces: `_scheduleTermReconnect(termId, dir)` — schedules a backoff reconnect for a terminal whose channel dropped; `ExRT.term.reconn` Map holding `{ attempt, timer }` per termId.

- [ ] **Step 1: Add the reconnect registry to ExRT.term (`js/runtime.js`)**

The `term` object on `ExRT` (js/runtime.js, ~line 55) is:

```js
    term: {
        map: new Map(),
        set(tabId, val) { this.map.set(tabId, val); },
        get(tabId) { return this.map.get(tabId); },
        del(tabId) {
            const inst = this.map.get(tabId);
            if (!inst) return;
            try { inst.channel && inst.channel.close('terminated'); } catch (e) {}
            try { inst.term && inst.term.dispose(); } catch (e) {}
            this.map.delete(tabId);
        },
    },
```

Add ONE field — `reconn: new Map(),` — right after `map: new Map(),`; change nothing
else. Note `del()` already closes the channel and disposes the xterm, so callers do not
dispose manually.

```js
    term: {
        map: new Map(),
        reconn: new Map(),   // termId → { attempt, timer } for auto-reconnect backoff
        set(tabId, val) { this.map.set(tabId, val); },
        get(tabId) { return this.map.get(tabId); },
        del(tabId) {
            const inst = this.map.get(tabId);
            if (!inst) return;
            try { inst.channel && inst.channel.close('terminated'); } catch (e) {}
            try { inst.term && inst.term.dispose(); } catch (e) {}
            this.map.delete(tabId);
        },
    },
```

- [ ] **Step 2: Reconnect on transport-level close**

In `_mountTerminal`, the current close handler is:

```js
        channel.addEventListener('close', (ev, options) => {
            const problem = options && options.problem;
            const exit = options && options['exit-status'];
            let reason;
            if (problem) reason = 'channel error: ' + problem + (options.message ? ' - ' + options.message : '');
            else if (typeof exit === 'number') reason = 'shell exited (' + exit + ')';
            else reason = 'closed';
            console.warn('[explorer] terminal channel closed:', reason, options);
            try { xterm.write(`\r\n\x1b[33m[${reason}]\x1b[0m\r\n`); } catch (e) {}
        });
```

Replace it with (adds the reconnect branch; keeps the existing message):

```js
        channel.addEventListener('close', (ev, options) => {
            const problem = options && options.problem;
            const exit = options && options['exit-status'];
            let reason;
            if (problem) reason = 'channel error: ' + problem + (options.message ? ' - ' + options.message : '');
            else if (typeof exit === 'number') reason = 'shell exited (' + exit + ')';
            else reason = 'closed';
            console.warn('[explorer] terminal channel closed:', reason, options);
            try { xterm.write(`\r\n\x1b[33m[${reason}]\x1b[0m\r\n`); } catch (e) {}
            // A `problem` (terminated/disconnected/protocol-error/…) is a transport
            // drop, not a clean shell exit — auto-reconnect. `cancelled` is our own
            // close; a numeric exit-status with no problem is a real shell exit.
            if (problem && problem !== 'cancelled') {
                this._scheduleTermReconnect(termId, dir);
            }
        });
```

- [ ] **Step 3: Reschedule when the channel spawn throws (transport still down)**

The current `cockpit.channel()` catch block is:

```js
        } catch (e) {
            console.error('[explorer] failed to spawn shell:', e);
            this.toast('Failed to spawn shell: ' + (e.message || e), 'error');
            try { xterm.dispose(); } catch (e2) {}
            return;
        }
```

Replace with (dispose the just-created xterm, then keep polling for the transport):

```js
        } catch (e) {
            console.error('[explorer] failed to spawn shell:', e);
            try { xterm.dispose(); } catch (e2) {}
            // Transport likely still down mid-reconnect — keep polling instead of
            // giving up. (First-ever mount will also retry, which is harmless.)
            this._scheduleTermReconnect(termId, dir);
            return;
        }
```

- [ ] **Step 4: Add `_scheduleTermReconnect`**

Add this method to the `window.ExplorerTerminal` object (place it right after `_mountTerminal`, before `_startTermResize`):

```js
    // Auto-reconnect a terminal whose Cockpit channel dropped (transport
    // disconnect / cockpit restart). Disposes the dead xterm and re-mounts,
    // reusing the persistent DOM container (keyed by term-container-<id>). Backs
    // off and polls until the transport returns: tmux reattaches to its live
    // session (new-session -A), a plain shell respawns fresh.
    _scheduleTermReconnect(termId, dir) {
        const term = this._findTermById(termId);
        if (!term) { ExRT.term.reconn.delete(termId); return; }  // user closed it

        const DELAYS = [500, 1000, 2000, 3000, 5000];
        const MAX_ATTEMPTS = 40;
        const rec = ExRT.term.reconn.get(termId) || { attempt: 0, timer: null };
        if (rec.timer) return;  // a reconnect is already pending — coalesce

        if (rec.attempt >= MAX_ATTEMPTS) {
            const inst = ExRT.term.get(termId);
            if (inst && inst.term) { try { inst.term.write('\r\n\x1b[31m[reconnect gave up — reopen the tab]\x1b[0m\r\n'); } catch (e) {} }
            ExRT.term.reconn.delete(termId);
            return;
        }

        const delay = DELAYS[Math.min(rec.attempt, DELAYS.length - 1)];
        rec.attempt += 1;
        rec.timer = setTimeout(() => {
            rec.timer = null;
            ExRT.term.reconn.set(termId, rec);
            // Bail if the terminal was closed while we waited.
            if (!this._findTermById(termId)) { ExRT.term.reconn.delete(termId); return; }
            // Drop the stale instance so _mountTerminal builds a fresh xterm in
            // the same container. ExRT.term.del() disposes the xterm and closes
            // the (dead) channel itself — just unhook the window resize listener.
            const inst = ExRT.term.get(termId);
            if (inst) {
                if (inst.onWinResize) { try { window.removeEventListener('resize', inst.onWinResize); } catch (e) {} }
                ExRT.term.del(termId);
            }
            this._mountTerminal(termId, dir);
        }, delay);
        ExRT.term.reconn.set(termId, rec);
    },
```

- [ ] **Step 5: Reset the backoff after a channel stays open**

A reconnect succeeds when the freshly mounted channel does not immediately close. Clear the attempt counter on the first inbound message. In `_mountTerminal`, the current message handler is:

```js
        channel.addEventListener('message', (ev, data) => {
            try { xterm.write(data); } catch (e) { console.warn('[explorer] xterm.write failed:', e); }
        });
```

Replace with:

```js
        let _gotData = false;
        channel.addEventListener('message', (ev, data) => {
            if (!_gotData) {
                _gotData = true;
                // Channel is live again — clear any reconnect backoff for this term.
                if (ExRT.term.reconn.has(termId)) ExRT.term.reconn.delete(termId);
            }
            try { xterm.write(data); } catch (e) { console.warn('[explorer] xterm.write failed:', e); }
        });
```

- [ ] **Step 6: Syntax + dup-key + composition checks**

Run:
```bash
node --check js/runtime.js && node --check js/features/terminal.js && node tools/check-mixins.js && node tools/compose-test.js
```
Expected: both `node --check` silent; `check-mixins` OK, no duplicate keys; `compose-test` prints `OK — component assembled …` (probed methods still present; `_scheduleTermReconnect` is a new method on the component).

- [ ] **Step 7: Commit**

```bash
git add js/runtime.js js/features/terminal.js
git commit -m "fix: auto-reconnect integrated terminals after a Cockpit transport drop"
```

---

### Task 5: Version, changelog, README

**Files:**
- Modify: `VERSION` → `2.2.1`
- Modify: `CHANGELOG.md` — new 2.2.1 entry
- Modify: `README.md` — terminal reconnect note; drop any mention of the removed upload-chunk setting

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Full verification sweep**

Run:
```bash
node --check js/features/upload.js && node --check js/features/terminal.js && node --check js/runtime.js && node tools/check-mixins.js && node tools/compose-test.js
```
Expected: all pass; `compose-test` prints `OK — component assembled …`.

- [ ] **Step 2: Bump VERSION**

Set the sole contents of `VERSION` to:

```
2.2.1
```

- [ ] **Step 3: Add CHANGELOG entry**

Read the top of `CHANGELOG.md` to mirror its exact heading/date style, then prepend a `## 2.2.1` section (date `2026-07-07`) with two bullets:
- **Large uploads/pastes no longer disconnect Cockpit** — uploads (drag-drop, tree, and clipboard image/video paste) now stream to the host in 64 KiB chunks instead of one oversized frame that tripped Cockpit's transport limit. Removed the unused "Upload chunk size" setting.
- **Terminals auto-reconnect after a Cockpit restart / disconnect** — dropped terminal channels re-attach automatically (with backoff); tmux sessions reattach and force a full repaint instead of coming back blank; plain shells respawn.

- [ ] **Step 4: Update README**

Run: `grep -niE "uploadChunkMB|upload chunk|chunk size|reconnect|disconnect" README.md`
- If the README documents the removed "Upload chunk size" setting, delete that line.
- Add a short note in the terminal section that integrated terminals auto-reconnect after a Cockpit restart/disconnect (tmux reattaches and repaints). Do not add screenshots.

- [ ] **Step 5: Re-verify VERSION**

Run: `cat VERSION`
Expected: `2.2.1`.

- [ ] **Step 6: Commit**

```bash
git add VERSION CHANGELOG.md README.md
git commit -m "chore: 2.2.1 — chunked upload + terminal auto-reconnect (docs, changelog, version)"
```

---

## Manual browser smoke (after Task 5, before release)

Not a code task. Run against Cockpit via the per-user symlink
(`ln -sfn /home/ismet/explorer ~/.local/share/cockpit/explorer`, remove after), sourcing
credentials from `~/.config/.claude/cockpit-credentials.json` so no password is recorded.

1. **Upload/paste no longer disconnects:** paste (or drag) a large `.mp4` (tens of MB)
   into a terminal → it uploads, the file appears as `clip-*.mp4` / at its dest, its path
   is typed into the PTY, and **the Cockpit Reconnect overlay does NOT appear**.
2. **tmux reconnect:** open a tmux session, produce visible output, then restart Cockpit
   (`sudo systemctl restart cockpit` on the host, or kill cockpit-ws). After the
   transport recovers, the tmux pane **auto-reattaches and repaints its content** (not
   blank). A plain terminal in another tab respawns a fresh shell.
3. Regression: normal `exit` in a plain shell still shows `[shell exited (0)]` and does
   **not** trigger a reconnect loop.

Report actual results; do not claim success without running it.

## Self-Review notes

- **Spec coverage:** Fix 1 chunking → Task 1; dead-setting removal → Task 2; tmux redraw
  → Task 3; auto-reconnect (close-branch, throw-branch, scheduler, backoff reset,
  registry) → Task 4; VERSION/CHANGELOG/README → Task 5. No gaps.
- **Type consistency:** `_scheduleTermReconnect(termId, dir)` defined in Task 4 Step 4 and
  called in Task 4 Steps 2–3 with the same `(termId, dir)`; `ExRT.term.reconn` added in
  Step 1 and used in Steps 4–5; `_findTermById` / `_mountTerminal` are existing methods.
- **No test runner:** deliberate — this repo verifies with `node --check` +
  `check-mixins` + `compose-test` + manual smoke, not jest/pytest.
- **Ordering:** Task 3 edits the `$nextTick` tail and Task 4 edits the message/close/catch
  handlers of the same `_mountTerminal` — different regions, but implement in order and
  re-read the function before each edit (the earlier edits shift line numbers).
