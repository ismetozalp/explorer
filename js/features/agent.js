// AI CLI tabs — run `claude` / `codex` in Explorer's integrated terminal with a
// live git working-tree diff beside it. Sessions are ordinary TERMINAL RECORDS
// in tab.terminals[] (so _findTermById / selectTerminal / closeTerminal / mount /
// reconnect all work unchanged) decorated with agent fields. The CLI is launched
// by SENDING it to the PTY after mount (term.initCommand → channel.send), so the
// working directory goes through the engine's `directory:` option (no shell `cd`,
// no injection) and a real shell remains after the CLI exits.
//
// Reactive session/browser state lives in app.js; pure helpers + orchestration
// live here. Diff-poll timers live in a plain Map (off the reactive proxy).
(function () {
    const _aiTimers = new Map();   // sessionId -> setTimeout handle
    const _aiPollGen = new Map();  // sessionId -> current poll generation (retires superseded ticks)

    window.ExplorerAgent = {

        // ───────── pure helpers (unit-tested; no this/I-O) ─────────

        _aiValidDir(d) { return typeof d === 'string' && d.startsWith('/'); },
        // tmux rejects "." and ":" in session names, so allow only letters,
        // digits, "_" and "-".
        _aiValidTmux(n) { return typeof n === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(n); },
        // Looser check for a RESTORED tmux name: it came from a real, possibly
        // externally-created session (spaces, Unicode, "+", … are all valid tmux
        // session names — only "." and ":" are target-spec separators). The name
        // is passed as argv (injection-safe), so restoring must accept these
        // rather than reject a live session down to a fresh shell — reject only
        // empty/oversized names and control chars / "." / ":".
        _aiValidTmuxRestore(n) {
            if (typeof n !== 'string' || n.length === 0 || n.length > 200) return false;
            if (n.indexOf('.') !== -1 || n.indexOf(':') !== -1) return false;   // tmux target separators
            for (let i = 0; i < n.length; i++) if (n.charCodeAt(i) < 0x20) return false;   // no control chars
            return true;   // spaces, "+", "-", Unicode, ... are all valid tmux session names
        },
        // Coerce any string into a VALID tmux name (the generated default must
        // always pass _aiValidTmux): map runs of disallowed chars (incl. "." from
        // folder names like app.js) to "-", trim stray "-", fall back to "session"
        // if empty, and cap at 64.
        _aiSanitizeTmux(s) {
            const n = String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'session';
            return n;
        },
        // Sanitize `base` and append `suffix` (e.g. "-11d5c0a4") keeping the whole
        // name ≤ 64 and valid — the BASE is truncated to make room, never the
        // suffix (so a resume redirect can't collapse back onto the occupied name).
        _aiTmuxName(base, suffix) {
            let b = this._aiSanitizeTmux(base);
            if (!suffix) return b;
            b = b.slice(0, Math.max(1, 64 - suffix.length)).replace(/-+$/, '') || 'session';
            return (b + suffix).slice(0, 64);
        },
        _aiValidUuid(id) { return typeof id === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id); },

        // The command to type into the PTY. Returns null on an invalid resume id
        // so the caller can error instead of silently starting a NEW session.
        _aiCliCommand(tool, resumeId) {
            const t = tool === 'codex' ? 'codex' : 'claude';
            if (resumeId != null && resumeId !== '') {
                if (!this._aiValidUuid(resumeId)) return null;
                return t === 'codex' ? ('codex resume ' + resumeId) : ('claude --resume ' + resumeId);
            }
            return t;
        },

        // Group resume rows by project folder (cwd). Each group: the sessions
        // (newest first), the latest one, and a count. Groups are ordered by
        // their latest session, so the most-recently-used project is on top.
        _aiGroupByProject(rows) {
            const map = new Map();
            for (const r of (rows || [])) {
                const key = r.cwd || '(unknown folder)';
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(r);
            }
            const groups = [];
            for (const [cwd, sessions] of map) {
                sessions.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
                groups.push({ cwd, sessions, latest: sessions[0], count: sessions.length });
            }
            groups.sort((a, b) => (b.latest.mtime || 0) - (a.latest.mtime || 0));
            return groups;
        },

        _aiNextLabel(sessions, tool) {
            const n = (sessions || []).filter(s => s.tool === tool).length + 1;
            return n > 1 ? (tool + ' ' + n) : tool;
        },

        // Shell body (run as `sh -c <body> sh <dir>`) that prints the working-tree
        // diff for `mode`, capped so a giant/generated diff can't freeze the UI.
        //  - staged   : git diff --staged
        //  - unstaged : git diff            + untracked (new) files
        //  - all      : git diff HEAD (or the empty-tree diff when HEAD is unborn,
        //               so initial staged files show) + untracked files
        // `cd "$1"` uses the dir as a POSITIONAL arg (no interpolation); `true`
        // swallows git's non-zero exits (e.g. `diff --no-index` on a new file).
        _aiDiffScript(mode) {
            const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
            // color.ui=false → no ANSI codes (a host color.ui=always would break
            // parsing); core.quotePath=false → non-ASCII paths appear raw in
            // headers. DOPTS pins the a/ b/ prefixes and skips external diff tools
            // so `diff --git a/… b/…` and hunk headers stay in the standard shape.
            const Q = 'git -c color.ui=false -c core.quotePath=false';
            // --no-color also overrides a host color.diff=always (which color.ui
            // does not); explicit prefixes survive diff.noprefix/mnemonicPrefix.
            const DOPTS = ' --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/';
            const tracked = mode === 'staged' ? Q + ' diff' + DOPTS + ' --staged 2>/dev/null'
                : mode === 'unstaged' ? Q + ' diff' + DOPTS + ' 2>/dev/null'
                : '{ ' + Q + ' diff' + DOPTS + ' HEAD 2>/dev/null || ' + Q + ' diff' + DOPTS + ' ' + EMPTY_TREE + ' 2>/dev/null; }';
            // Untracked (new) files: enumerate NUL-delimited (byte-exact — handles
            // spaces, non-ASCII, tabs, quotes; dash's `read` has no -d, so pipe
            // through `xargs -0`) and diff each against /dev/null.
            const untracked = mode === 'staged' ? ''
                : '; git ls-files --others --exclude-standard -z | xargs -0 -r -I{} ' + Q + ' diff' + DOPTS + ' --no-index -- /dev/null {} 2>/dev/null';
            // Run from the repo TOPLEVEL (fallback: the session dir) so tracked
            // (git diff) and untracked (ls-files) paths share one base — the repo
            // root — and the "open in editor" join is correct even for a session
            // rooted in a subdirectory.
            return 'r=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null); cd "${r:-$1}" 2>/dev/null || exit 0; { ' + tracked + untracked + '; } | head -c 300000; true';
        },

        // Decode git's C-style path quoting: the octal "\ooo" escapes are UTF-8
        // BYTES, so assemble the byte sequence and decode it as UTF-8 (via
        // decodeURIComponent — present in every JS realm, unlike TextDecoder).
        // Input is the ESCAPED content between the quotes.
        _aiDecodeGitPath(s) {
            const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
            const hx = b => '%' + (b & 0xff).toString(16).padStart(2, '0');
            // Build a percent-encoded string: escaped bytes as %XX, and LITERAL
            // runs UTF-8-encoded via encodeURIComponent (so raw Unicode kept by
            // core.quotePath=false — possibly mixed with escapes — isn't corrupted
            // by a naive charCodeAt&0xff). One decodeURIComponent yields the name.
            let enc = '', lit = '';
            const flush = () => { if (lit) { enc += encodeURIComponent(lit); lit = ''; } };
            for (let i = 0; i < s.length; i++) {
                const c = s[i];
                if (c !== '\\') { lit += c; continue; }
                flush();
                const nx = s[i + 1];
                if (nx >= '0' && nx <= '7') {
                    let o = '';
                    while (o.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') o += s[++i];
                    enc += hx(parseInt(o, 8));
                } else if (nx !== undefined && Object.prototype.hasOwnProperty.call(simple, nx)) {
                    enc += hx(simple[nx]); i++;
                } else if (nx !== undefined) {
                    lit += s[i + 1]; i++;                    // unknown escape → literal next char
                }
            }
            flush();
            try { return decodeURIComponent(enc); } catch (e) { return s; }
        },

        // The b-side path from a "diff --git a/… b/…" header. This header is
        // AMBIGUOUS for names with spaces (`a/a b/x b/a b/x`), so it is only a
        // fallback for sections without +++/--- markers (binary/mode-only); the
        // real path comes from _aiPathFromMarker. Handles git's quoted form.
        _aiDiffFilePath(line) {
            let m = / "b\/((?:\\.|[^"\\])*)"\s*$/.exec(line);   // quoted b-side
            if (m) return this._aiDecodeGitPath(m[1]);
            m = / b\/(.+)$/.exec(line);                          // plain b-side (best effort)
            if (m) return m[1];
            return line.slice(11) || '?';
        },

        // The file path from a "+++ b/…" / "--- a/…" marker line — UNAMBIGUOUS
        // (one path, everything after the prefix), so it disambiguates names with
        // spaces. Empty for "/dev/null" (a create's --- or a delete's +++).
        _aiPathFromMarker(line) {
            const body = line.slice(4).replace(/\s+$/, '');     // after "+++ " / "--- "
            if (body === '/dev/null') return '';
            if (body[0] === '"') { const m = /^"(.*)"$/.exec(body); if (m) return this._aiDecodeGitPath(m[1]).replace(/^[ab]\//, ''); }
            return body.replace(/^[ab]\//, '');
        },

        // Parse a unified diff into a changed-files strip. Track whether we're
        // INSIDE a hunk so a content line beginning "+++"/"---" (added/removed
        // text that itself starts with "++"/"--") is counted, not mistaken for a
        // file header — otherwise the +/- counts undercount or read zero.
        _aiDiffFiles(diffText) {
            const files = []; let cur = null, inHunk = false, oldp = '', newp = '';
            const settle = () => { if (cur) cur.file = newp || oldp || cur.file; };
            for (const line of String(diffText || '').split('\n')) {
                if (line.startsWith('diff --git ')) {
                    settle();
                    cur = { file: this._aiDiffFilePath(line), added: 0, removed: 0 };
                    files.push(cur); inHunk = false; oldp = ''; newp = ''; continue;
                }
                if (!cur) continue;
                if (line.startsWith('@@')) { settle(); inHunk = true; continue; }
                if (!inHunk) {                          // header section (index, ---, +++, …)
                    if (line.startsWith('--- ')) oldp = this._aiPathFromMarker(line);
                    else if (line.startsWith('+++ ')) newp = this._aiPathFromMarker(line);
                    continue;
                }
                if (line[0] === '+') cur.added++;
                else if (line[0] === '-') cur.removed++;
            }
            settle();
            return files;
        },

        // Split a unified diff into per-file sections [{ file, text }], so the
        // pane can show one or several files back-to-back.
        _aiDiffSections(diffText) {
            const sections = []; let cur = null, inHunk = false, oldp = '', newp = '';
            const settle = () => { if (cur) cur.file = newp || oldp || cur.file; };
            for (const line of String(diffText || '').split('\n')) {
                if (line.startsWith('diff --git ')) {
                    settle();
                    if (cur) sections.push(cur);
                    cur = { file: this._aiDiffFilePath(line), text: line };
                    inHunk = false; oldp = ''; newp = '';
                } else if (cur) {
                    cur.text += '\n' + line;
                    if (!inHunk) {
                        if (line.startsWith('@@')) { settle(); inHunk = true; }
                        else if (line.startsWith('--- ')) oldp = this._aiPathFromMarker(line);
                        else if (line.startsWith('+++ ')) newp = this._aiPathFromMarker(line);
                    }
                }
            }
            settle();
            if (cur) sections.push(cur);
            return sections;
        },

        // The diff text to display: everything, or — when files are selected in
        // the strip — just those files' sections, concatenated back-to-back.
        _aiVisibleDiffText(session) {
            const sel = (session && session.diff && session.diff.selected) || [];
            const text = (session && session.diff && session.diff.text) || '';
            if (!sel.length) return text;
            return this._aiDiffSections(text).filter(s => sel.indexOf(s.file) !== -1).map(s => s.text).join('\n');
        },

        // Render the visible diff as colored, HTML-escaped lines with old/new
        // line-number gutters (parsed from each "@@ -a,b +c,d @@" hunk header).
        // Returned as one HTML string for x-html — far cheaper than an Alpine node
        // per line for a large (capped 300 KB) diff.
        aiDiffHtml(session) {
            const text = this._aiVisibleDiffText(session);
            if (!text) return '';
            const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const out = [];
            let oldn = 0, newn = 0, inHunk = false;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const raw = lines[i];
                if (raw === '' && i === lines.length - 1) break;   // trailing split artifact
                let cls = 'ctx', lo = '', ln = '';
                if (raw.startsWith('diff --git ')) {
                    cls = 'meta'; inHunk = false;                  // start of a file's header section
                } else if (raw.startsWith('@@')) {
                    cls = 'hunk'; inHunk = true;
                    const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
                    if (m) { oldn = parseInt(m[1], 10); newn = parseInt(m[2], 10); }
                } else if (!inHunk) {
                    cls = 'meta';                                  // header lines (index, ---, +++, new file, …)
                } else if (raw[0] === '\\') {
                    cls = 'meta';                                  // "\ No newline at end of file"
                } else if (raw[0] === '+') {
                    cls = 'add'; ln = newn++;                      // inside a hunk: content, even if it starts "+++"
                } else if (raw[0] === '-') {
                    cls = 'del'; lo = oldn++;                      // inside a hunk: content, even if it starts "---"
                } else {
                    cls = 'ctx'; lo = oldn++; ln = newn++;         // context line (leading space)
                }
                out.push('<div class="adl ' + cls + '"><span class="ln">' + lo + '</span><span class="ln">' + ln
                    + '</span><span class="lc">' + (esc(raw) || '&nbsp;') + '</span></div>');
            }
            return out.join('');
        },

        // Changed-files strip interactions.
        aiDiffFileSelected(session, file) {
            return !!(session && session.diff && (session.diff.selected || []).indexOf(file) !== -1);
        },
        aiDiffToggleFile(session, file) {
            if (!session || !session.diff) return;
            session.diff.focus = '';   // manual selection change drops any tree-pinned focus
            const sel = session.diff.selected || (session.diff.selected = []);
            const i = sel.indexOf(file);
            if (i === -1) sel.push(file); else sel.splice(i, 1);
        },
        aiDiffClearSelection(session) { if (session && session.diff) { session.diff.selected = []; session.diff.focus = ''; } },

        // Open a changed file in the Monaco editor (same editor as the file list).
        async aiOpenDiffFile(session, file) {
            if (!session || !file) return;
            // Diff paths are relative to the repo root (see _aiDiffScript); fall
            // back to the session dir when the root isn't known yet / not a repo.
            // (`file` is already git-unquoted by _aiDiffFilePath.)
            const base = (session.diff && session.diff.root) || session.dir;
            const path = Util.joinPath(base, file);
            // Stat for the real size so openEditor's size limit is respected — a
            // huge generated file must not be force-loaded into Monaco just
            // because it appears (capped) in the diff.
            let size = 0;
            try { const st = await FS.statOne(path); if (st) size = st.size || 0; } catch (e) {}
            await this.openEditor({ path, name: (file.split('/').pop() || file), type: 'f', size });
        },
        // Same path resolution as aiOpenDiffFile, but opens the file in the
        // preview pane (👁 in the changed-files strip) instead of the editor.
        async aiPreviewDiffFile(session, file) {
            if (!session || !file) return;
            const base = (session.diff && session.diff.root) || session.dir;
            const path = Util.joinPath(base, file);
            let size = 0;
            try { const st = await FS.statOne(path); if (st) size = st.size || 0; } catch (e) {}
            await this.openPreview({ path, name: (file.split('/').pop() || file), type: 'f', size });
        },

        _aiHashStr(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); },
        _aiDiffChanged(session, text) {
            const h = this._aiHashStr(text);
            if (session.diff.hash === h) return false;
            session.diff.hash = h; return true;
        },

        // ───────── I/O probes ─────────

        async _aiDirExists(dir) { try { await cockpit.spawn(['sh', '-c', 'test -d "$1"', 'sh', dir]); return true; } catch (e) { return false; } },
        // Exact-match check ("=name"): `-t name` alone prefix-matches, which would
        // make "claude-explorer" falsely report as existing when only
        // "claude-explorer-<id>" does — breaking the resume-collision redirect.
        async _aiTmuxExists(name) { try { await cockpit.spawn(['tmux', 'has-session', '-t', '=' + name]); return true; } catch (e) { return false; } },

        async aiDetect() {
            // Detect in the SAME interactive shell the terminal will launch, so a
            // CLI on a shell-specific PATH (e.g. ~/.local/bin added in ~/.zshrc or
            // ~/.bashrc) is resolved the way the terminal actually resolves it —
            // falling back to bash. Cockpit's default spawn PATH is minimal and
            // would miss these CLIs entirely.
            // Probe in EXACTLY the shell the terminal will launch (interactive,
            // so its startup files set PATH the same way) — not bash-as-fallback,
            // which could report a tool the configured shell can't actually run.
            const shell = (this.settings && this.settings.defaultShell) || '/bin/bash';
            const has = async (bin) => {
                try { const o = await cockpit.spawn([shell, '-ic', 'command -v "$1" 2>/dev/null', shell, bin], { err: 'message' }); return !!(o && o.trim()); }
                catch (e) { return false; }
            };
            this.ai.have = { claude: await has('claude'), codex: await has('codex') };
        },

        // ───────── orchestration ─────────

        aiActiveSession(tab) { return tab && tab.terminals ? tab.terminals.find(t => t.id === tab.activeTermId) : null; },

        // The toolbar AI dropdown is position:fixed (so .tab-bar's overflow:hidden
        // can't clip it); anchor it under the button from the click's rect, like
        // the tmux panel does.
        toggleAiMenu(ev) {
            this.ui.aiMenuOpen = !this.ui.aiMenuOpen;
            if (this.ui.aiMenuOpen) {
                try {
                    const r = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect ? ev.currentTarget.getBoundingClientRect() : null;
                    if (r) { this.ui.aiMenuTop = Math.round(r.bottom + 4); this.ui.aiMenuRight = Math.max(4, Math.round(window.innerWidth - r.right)); }
                } catch (e) {}
            }
        },

        // In-tab "＋▾" add-session menu — also fixed (the agent tabbar clips a
        // dropdown), anchored under the button and left-aligned to it.
        toggleAgentAddMenu(ev) {
            this.ui.agentAddOpen = !this.ui.agentAddOpen;
            if (this.ui.agentAddOpen) {
                try {
                    const r = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect ? ev.currentTarget.getBoundingClientRect() : null;
                    if (r) { this.ui.agentAddTop = Math.round(r.bottom + 4); this.ui.agentAddLeft = Math.round(r.left); }
                } catch (e) {}
            }
        },

        // Pick a folder (browse / search / create) before opening a NEW agent
        // TAB. Cancel (null) aborts without opening anything.
        async aiPickAndOpen(tool, startDir) {
            const start = this._aiValidDir(startDir) ? startDir : ((this.currentPane() && this.currentPane().path) || this.homePath);
            const dir = await this.askDirectory('Start ' + tool + ' in…', start);
            if (dir) this.openAgentTab(tool, dir);
        },

        // Pick a folder before adding a session to an EXISTING agent tab.
        async aiPickAndAdd(tab, tool, startDir) {
            const start = this._aiValidDir(startDir) ? startDir : ((tab && tab.path) || (this.currentPane() && this.currentPane().path) || this.homePath);
            const dir = await this.askDirectory('Start ' + tool + ' in…', start);
            if (dir) this.aiAddSession(tab, tool, { dir });
        },

        openAgentTab(tool, dir, opts) {
            opts = opts || {};
            dir = this._aiValidDir(dir) ? dir : ((this.currentPane() && this.currentPane().path) || this.homePath || '/');
            const tab = { id: Util.uid(), kind: 'agent', title: '✦ ' + tool, path: dir, terminals: [], activeTermId: null };
            this.tabs.push(tab);
            this.activeTabId = tab.id;
            this.$nextTick(async () => {
                const t = await this.aiAddSession(tab, tool, { dir, resumeId: opts.resumeId || null });
                // If setup was cancelled/invalid (e.g. the tmux-name prompt was
                // dismissed), don't leave a permanently empty agent tab behind.
                if (!t) { const rt = this.tabs.find(x => x.id === tab.id); if (rt && (!rt.terminals || rt.terminals.length === 0)) this.closeTab(tab.id); }
            });
            return tab;
        },

        async aiAddSession(tab, tool, opts) {
            opts = opts || {};
            tab = (tab && this.tabs.find(t => t.id === tab.id)) || tab;
            let dir = opts.dir || (this.currentPane() && this.currentPane().path) || this.homePath || '/';
            if (!this._aiValidDir(dir)) dir = this.homePath || '/';
            const resumeId = opts.resumeId || null;

            if (resumeId && !this._aiValidUuid(resumeId)) { this.toast('Invalid session id — cannot resume.', 'danger'); return; }
            // Validate the working dir for EVERY resume AND restore (not just
            // resumes): a saved project folder can be moved/deleted between
            // launches, and _mountTerminal passes it straight to the channel's
            // `directory` — a nonexistent one stops the shell/tmux client from
            // starting at all, even when the tmux session is still alive. Fall
            // back to an existing folder so the session (and its diff) still open.
            if ((resumeId || opts.restore) && !(await this._aiDirExists(dir))) {
                this.toast('That project folder no longer exists — opening in the current folder.', 'warning');
                dir = (this.currentPane() && this.currentPane().path) || this.homePath || '/';
            }
            const cli = this._aiCliCommand(tool, resumeId);
            if (cli == null) { this.toast('Invalid session id — cannot resume.', 'danger'); return; }

            let tmuxName = null, sendInit = true;
            // A RESTORED session reuses its saved launch mode/name (no prompt);
            // otherwise the Settings choice applies.
            let useTmux = opts.restore ? (opts.launch === 'tmux') : (this.settings.aiLaunch === 'tmux');
            if (useTmux && !(this.tmux && this.tmux.available)) {
                if (!opts.restore) this.toast('tmux is not installed — launching in a shell instead.', 'warning');
                useTmux = false;
            }
            if (useTmux && opts.restore) {
                // Restore: reuse the saved tmux name (attach if it's still alive,
                // else re-create and run the CLI) — no prompt, no collision redirect.
                // sendInit is NOT decided here: a restored tab mounts lazily on
                // activation, and the session may appear/disappear in between, so
                // the create-vs-attach check is deferred to _aiResolveRestoredTmux.
                // Use the saved name EXACTLY — no trim: a tmux session's name can
                // have leading/trailing spaces, and trimming would target a
                // different (or nonexistent) session instead of reattaching.
                tmuxName = (typeof opts.tmuxName === 'string') ? opts.tmuxName : '';
                // If the saved name fails our validator, DON'T just drop to a shell
                // while keeping the name — that path still attaches to the live
                // session (via addTerminalToTab's tmux opt) AND sends the CLI as an
                // initCommand, injecting `claude`/`codex` into its foreground
                // process. Clear the name too so it falls back to a clean shell.
                if (!this._aiValidTmuxRestore(tmuxName)) { useTmux = false; tmuxName = null; }
            } else if (useTmux) {
                // Default the tmux name to the FOLDER (tool-leaf), never a sticky
                // last-used value — a sticky default collides across projects
                // (resuming explorer would offer "claude-manifest" and, if that
                // session exists, attach to it instead of resuming explorer). For
                // a RESUME, suffix the session id so the name is unique to this
                // session and it always creates+runs `--resume` rather than
                // attaching to an unrelated same-named session.
                const leaf = dir.split('/').filter(Boolean).pop() || 'session';
                const def = this._aiTmuxName(tool + '-' + leaf, resumeId ? ('-' + resumeId.slice(0, 8)) : '');
                tmuxName = await this.askPrompt('tmux session', 'tmux session name (attaches if it exists, else creates)', def, {});
                if (tmuxName == null) return;                 // cancelled
                tmuxName = String(tmuxName).trim();
                if (!this._aiValidTmux(tmuxName)) { this.toast('Invalid tmux name — use letters, digits, _ . - only.', 'danger'); return; }
                // A RESUME must actually run `claude --resume <id>`, which only
                // happens when tmux CREATES the session (attaching ignores the
                // launch command). If the chosen name is already taken by ANOTHER
                // session (e.g. the user trimmed the default down to a name that
                // collides with a running one), redirect to the id-unique name so
                // the resume runs instead of silently attaching to the wrong
                // session. If that id-unique name already exists, it IS this
                // resumed session — attach to it. (A name already ending in the
                // id suffix is left alone so re-resuming just re-attaches.)
                if (resumeId) {
                    const suffix = '-' + resumeId.slice(0, 8);
                    if (!tmuxName.endsWith(suffix) && await this._aiTmuxExists(tmuxName)) {
                        const unique = this._aiTmuxName(tmuxName, suffix);
                        if (!(await this._aiTmuxExists(unique))) {
                            this.toast('A tmux session “' + tmuxName + '” already exists — resuming into “' + unique + '”.', 'info');
                        }
                        tmuxName = unique;
                    }
                }
                // Attaching to an existing tmux session ignores the launch command,
                // so only send the CLI when we are CREATING the session.
                sendInit = !(await this._aiTmuxExists(tmuxName));
            }

            const label = this._aiNextLabel(tab.terminals, tool);
            // Capture the tab's active session BEFORE addTerminalToTab (which always
            // sets activeTermId to the new one) — a background restore must not
            // steal a sub-tab the user already activated/selected mid-restore.
            const prevActive = (this.tabs.find(t => t.id === tab.id) || tab || {}).activeTermId || null;
            const created = this.addTerminalToTab(tab, dir, { tmux: tmuxName || undefined, mount: false });
            if (!created) return;
            // addTerminalToTab returns the RAW record; mutating it (diff state) and
            // polling on it would not trigger Alpine reactivity, so the live diff
            // would silently stay stale until some other event forced a repaint
            // (the reported "no files until I switch modes" bug). Re-acquire the
            // reactive proxy from this.tabs and drive everything through it.
            const rtab = this.tabs.find(t => t.id === tab.id) || tab;
            const term = (rtab.terminals || []).find(t => t.id === created.id) || created;
            term.isAgent = true; term.tool = tool; term.resumeId = resumeId; term.launch = useTmux ? 'tmux' : 'shell';
            term.label = (opts.restore && opts.label) ? opts.label : label;
            term.diff = { text: '', mode: 'all', repo: true, files: [], hash: '', note: '', selected: [], root: '', rootFor: '' };
            // Repo-tree panel state (js/features/agent.js aiTree*). Rooted at the
            // diff's resolved toplevel; dirs lazy-load their children, git status
            // colors each entry. All transient (rebuilt on load) — not persisted.
            term.tree = { root: '', rootFor: '', expanded: {}, children: {}, status: {}, dirty: {}, statusHash: '', loading: {} };
            if (this._sccEnsure) this._sccEnsure(term);   // js/features/scc.js — code-census pane state
            if (opts.restore && useTmux && term.tmux) {
                // Decide "run the CLI vs just attach" when the tab is activated
                // (mounted), not now — the tmux session's liveness may have changed.
                term._tmuxRestoreCli = cli;
            } else if (sendInit) {
                term.initCommand = cli;
            }
            if (opts.restore) {
                // Background restore: don't steal focus. Keep whatever session was
                // active before (a prior restored one, or one the user selected
                // mid-restore); only the FIRST restored session (no prior active)
                // becomes active. Activation mounts the hidden terminal + polls.
                if (prevActive && (rtab.terminals || []).some(t => t.id === prevActive)) {
                    rtab.activeTermId = prevActive;
                }
                return term;
            }
            rtab.activeTermId = term.id;
            this.$nextTick(() => { this._mountTerminal(term.id, dir); this.aiStartDiffPoll(rtab, term); });
            return term;
        },

        aiSelectSession(tab, id) {
            this.selectTerminal(tab, id);   // mounts via _mountTerminal, which resolves a pending restored-tmux session
            for (const s of (tab.terminals || [])) this.aiStopDiffPoll(s);
            const s = (tab.terminals || []).find(t => t.id === id);
            if (s) this.aiStartDiffPoll(tab, s);
            // If the scc pane is open, initialize it for the newly-active session
            // (probe/detect + start its analysis) — the toggle isn't re-run on a
            // session switch, so without this the pane would sit blank.
            if (s && tab.aiSccCollapsed === false && this.aiSccOpen) this.aiSccOpen(s);
        },

        // The tmux session names among a tab's sessions (only tmux-launched ones
        // carry `.tmux`); used to offer termination when a tab/session is closed.
        _aiTabTmuxNames(tab) {
            return ((tab && tab.terminals) || []).filter(t => t && t.tmux).map(t => t.tmux);
        },
        async _aiKillTmux(name) {
            if (!name) return;
            try { await cockpit.spawn(['tmux', 'kill-session', '-t', '=' + name]); }
            catch (e) { /* already gone / no server — nothing to kill */ }
        },
        // Ask whether to terminate the given tmux session(s) before closing.
        // Returns 'kill' | 'keep' | null (null = dismissed → abort the close).
        async _aiAskTerminateTmux(names, title) {
            const many = names.length > 1;
            const which = many ? ('the ' + names.length + ' tmux sessions (' + names.join(', ') + ')') : ('the tmux session “' + names[0] + '”');
            return this.askChoice(title,
                'This ' + (many ? 'tab uses ' : 'session runs in ') + which + '. Terminate '
                + (many ? 'them' : 'it') + ', or keep ' + (many ? 'them' : 'it') + ' running so you can re-attach later?',
                [{ id: 'kill', label: many ? 'Terminate all' : 'Terminate tmux session', variant: 'danger' },
                 { id: 'keep', label: 'Keep running (detach)', variant: 'secondary' }]);
        },

        async aiCloseSession(tab, id) {
            const s = (tab.terminals || []).find(t => t.id === id);
            if (s && s.tmux) {
                const choice = await this._aiAskTerminateTmux([s.tmux], 'Close session');
                if (choice == null) return;                    // dismissed → keep the session open
                if (choice === 'kill') await this._aiKillTmux(s.tmux);
            }
            if (s) this.aiStopDiffPoll(s);
            this.closeTerminal(tab, id);                       // closes the agent tab when the last session goes (see terminal.js)
            const a = (tab.terminals || []).find(t => t.id === tab.activeTermId);
            if (a) {
                this.aiStartDiffPoll(tab, a);
                // closeTerminal reselects the neighbor via the low-level
                // selectTerminal (not aiSelectSession), so re-initialize the scc
                // pane for the newly-active session when it's open — else it sits
                // blank (installed stays null) until the pane is toggled.
                if (tab.aiSccCollapsed === false && this.aiSccOpen) this.aiSccOpen(a);
            }
        },

        // User-facing tab close (the tab's × / middle-click). For an AGENT tab
        // whose sessions run in tmux, first ask whether to terminate those tmux
        // sessions — otherwise they keep running, detached. All other tabs (and
        // agent tabs with no tmux sessions) close immediately.
        async closeTabAsk(tab) {
            if (tab && tab.kind === 'agent') {
                const names = this._aiTabTmuxNames(tab);
                if (names.length) {
                    const choice = await this._aiAskTerminateTmux(names, 'Close AI tab');
                    if (choice == null) return;                // dismissed → don't close
                    if (choice === 'kill') { for (const n of names) await this._aiKillTmux(n); }
                }
            }
            this.closeTab(tab.id);
        },

        aiRenameSession(tab, id) {
            const s = (tab.terminals || []).find(t => t.id === id);
            if (!s) return;
            this.askPrompt('Rename session', 'Label', s.label, {}).then(v => { if (v != null && String(v).trim()) s.label = String(v).trim(); });
        },

        // ───────── live diff pane ─────────

        async aiRefreshDiff(session) {
            if (!session || !session.diff) return;
            // A request generation + captured (dir, mode): concurrent refreshes
            // (Refresh / mode switch / poll) can finish out of order, so only the
            // NEWEST request may publish — an older one that resolves late must not
            // overwrite the current mode's diff or clear its selection.
            const req = (session.diff.req || 0) + 1; session.diff.req = req;
            const dir = session.dir, mode = session.diff.mode;
            const stale = () => session.diff.req !== req;
            try {
                await cockpit.spawn(['git', '-C', dir, 'rev-parse', '--is-inside-work-tree'], { err: 'message' });
                if (stale()) return;
                session.diff.repo = true;
                // The repo root — the base every diff path is relative to (see
                // _aiDiffScript) and what "open in editor" resolves against. Cached
                // per dir and re-resolved if the shell cd's elsewhere, so a stale
                // root can't point the editor at the wrong repository.
                if (session.diff.rootFor !== dir) {
                    const root = ((await cockpit.spawn(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { err: 'message' }).catch(() => '')) || '').trim() || dir;
                    if (stale()) return;
                    session.diff.root = root; session.diff.rootFor = dir;
                }
                // One bounded shell pass: tracked diff for the mode (with an
                // empty-tree fallback for unborn HEAD) + untracked files, capped
                // at 300 KB so a giant/generated diff can't freeze the browser.
                const out = await cockpit.spawn(['sh', '-c', this._aiDiffScript(mode), 'sh', dir], { err: 'message' }).catch(() => '');
                if (stale()) return;
                session.diff.note = out.length >= 300000 ? 'diff truncated — showing the first 300 KB' : '';
                if (this._aiDiffChanged(session, out)) {
                    session.diff.text = out;
                    session.diff.files = this._aiDiffFiles(out);
                    // Drop any selected file that no longer has changes (e.g. it was
                    // committed/reverted) — but KEEP an explicitly tree-focused file
                    // even when it has no changes, so a click on a clean file keeps
                    // showing ITS (empty) diff instead of the prune emptying
                    // `selected` and the pane snapping back to all changes.
                    const present = session.diff.files.map(f => f.file);
                    const focus = session.diff.focus;
                    session.diff.selected = (session.diff.selected || []).filter(f => present.indexOf(f) !== -1 || f === focus);
                }
            } catch (e) {
                if (stale()) return;
                // Clear the hash too, so an identical diff after a transient failure
                // (or after leaving and returning to the repo) is re-published
                // instead of being rejected as "unchanged" and stuck on No changes.
                session.diff.repo = false; session.diff.text = ''; session.diff.files = []; session.diff.note = ''; session.diff.hash = '';
            }
        },

        aiSetDiffMode(session, mode) { if (!session) return; session.diff.mode = mode; session.diff.hash = ''; session.diff.focus = ''; this.aiRefreshDiff(session); },

        // Hide/show the right-side diff pane; the terminal widens to fill. Refit
        // the active xterm after the layout settles so it uses the new width.
        aiToggleDiff(tab) {
            if (!tab) return;
            tab.aiDiffCollapsed = !tab.aiDiffCollapsed;
            this.$nextTick(() => {
                const s = this.aiActiveSession(tab);
                if (!s) return;
                const inst = ExRT.term.get(s.id);
                if (inst && inst.fitAddon) { try { inst.fitAddon.fit(); } catch (e) {} }
            });
        },

        // ───────── repo tree panel ─────────

        // The repo root the tree hangs off — the diff's already-resolved
        // toplevel, so the two panes always agree on what "the repo" is.
        _aiTreeRoot(session) {
            return (session && session.diff && session.diff.repo && session.diff.root) || '';
        },
        // Hide/show the tree column; refit the terminal after the width change.
        // Default is collapsed (aiTreeCollapsed is undefined) to keep the classic
        // two-pane layout; opening it lazy-loads the root listing on demand.
        aiToggleTree(tab) {
            if (!tab) return;
            tab.aiTreeCollapsed = (tab.aiTreeCollapsed === false);   // undefined/true → expand; false → collapse
            if (tab.aiTreeCollapsed === false) {
                const s = this.aiActiveSession(tab);
                if (s) this._aiTreeEnsureRoot(s);
            }
            this.$nextTick(() => {
                const s = this.aiActiveSession(tab);
                if (!s) return;
                const inst = ExRT.term.get(s.id);
                if (inst && inst.fitAddon) { try { inst.fitAddon.fit(); } catch (e) {} }
            });
        },
        // Ensure the root listing is loaded (once per repo root) and the status
        // colors are current. Cheap to call every poll tick — the child load is
        // guarded and the status refresh is hash-gated.
        async _aiTreeEnsureRoot(session) {
            const root = this._aiTreeRoot(session);
            if (!root) return;
            if (!session.tree) session.tree = { root: '', rootFor: '', expanded: {}, children: {}, status: {}, dirty: {}, statusHash: '', loading: {} };
            // Coalesce: on a slow/large repo a full `git status --untracked-files=all`
            // (plus re-listing) can outrun the poll interval. Without this guard the
            // poll would fire a fresh, overlapping refresh every tick — concurrent
            // git processes and out-of-order updates. One refresh at a time.
            if (session.tree._busy) return;
            session.tree._busy = true;
            try {
                if (session.tree.rootFor !== root) {
                    // Shell cd'd into a different repo → reset the tree to the new root.
                    session.tree.root = root; session.tree.rootFor = root;
                    session.tree.expanded = {}; session.tree.children = {}; session.tree.loading = {};
                    session.tree.status = {}; session.tree.dirty = {}; session.tree.statusHash = ''; session.tree.listedAt = 0;
                }
                if (!session.tree.children[root]) await this._aiTreeLoadChildren(session, root);
                const changed = await this.aiRefreshTree(session);
                // Re-list the loaded/visible dirs when git status moved (agent edits
                // appear at once) OR on a throttle — empty dirs and ignored files
                // never move git status or HEAD, so the status hash alone can't catch
                // them; a periodic re-list keeps the tree honest without a tight loop.
                const now = Date.now();
                if (changed || now - (session.tree.listedAt || 0) >= 4000) {
                    session.tree.listedAt = now;
                    await this._aiTreeReloadLoaded(session);
                }
            } finally { session.tree._busy = false; }
        },
        // Lazy-load one directory's entries (dirs first, then files, alpha). The
        // .git internals are hidden; other dotfiles stay (git may track them).
        async _aiTreeLoadChildren(session, dir) {
            if (!session.tree || session.tree.loading[dir]) return;
            session.tree.loading[dir] = true;
            try {
                let entries = await FS.listDir(dir);
                entries = entries.filter(e => !(e.type === 'd' && e.name === '.git'));
                entries.sort((a, b) => {
                    const ad = a.type === 'd', bd = b.type === 'd';
                    if (ad !== bd) return ad ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
                session.tree.children[dir] = entries.map(e => ({ name: e.name, path: e.path, type: e.type }));
            } catch (e) {
                session.tree.children[dir] = [];
            } finally {
                delete session.tree.loading[dir];
            }
        },
        aiTreeToggleDir(session, node) {
            if (!session || !session.tree || !node || node.type !== 'd') return;
            const ex = session.tree.expanded;
            if (ex[node.path]) { delete ex[node.path]; }
            else {
                ex[node.path] = true;
                if (!session.tree.children[node.path]) this._aiTreeLoadChildren(session, node.path);
            }
        },
        // One `git status --porcelain -z` pass → per-file status class + a
        // "contains changes" mark on every ancestor dir (so collapsed folders
        // still hint at edits inside). Keyed by ABSOLUTE path to line up with the
        // tree's FS paths. Hash-gated so an unchanged status skips the repaint.
        async aiRefreshTree(session) {
            const root = this._aiTreeRoot(session);
            if (!root || !session.tree) return;
            try {
                // NO -z: cockpit.spawn returns EMPTY for a NUL-separated (-z) stream
                // on a text channel, so `git status -z` read directly here silently
                // yields nothing (the diff pane sidesteps this by piping -z through a
                // shell). Newline porcelain + core.quotePath=false brings ordinary
                // (incl. non-ASCII) paths through plainly; see _aiParsePorcelain.
                const out = (await cockpit.spawn(['git', '-C', root, '-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all'], { err: 'message' }).catch(() => '')) || '';
                // Fold HEAD into the change hash: a switch between two CLEAN branches
                // (or a commit/checkout) with different files leaves porcelain empty
                // both times, so status alone would never invalidate the cached
                // listings — the tree would keep showing the old branch's files.
                const head = ((await cockpit.spawn(['git', '-C', root, 'rev-parse', 'HEAD'], { err: 'ignore' }).catch(() => '')) || '').trim();
                const h = this._aiHashStr(head + '\n' + out);
                if (session.tree.statusHash === h) return false;
                session.tree.statusHash = h;
                const parsed = this._aiParsePorcelain(out, root);
                session.tree.status = parsed.status;
                session.tree.dirty = parsed.dirty;
                return true;   // status moved — caller re-lists loaded dirs at once
            } catch (e) { /* keep last-known colors */ }
            return false;
        },
        // Re-list every directory whose children we've loaded (the root plus any
        // still-expanded dir). Called only when git status changed, so it's not a
        // hot loop; each per-dir load is guarded against re-entrancy.
        async _aiTreeReloadLoaded(session) {
            const t = session.tree; if (!t) return;
            for (const d of Object.keys(t.children)) {
                if (d === t.root || t.expanded[d]) {
                    await this._aiTreeLoadChildren(session, d);   // visible → re-list now
                } else if (!t.loading[d]) {
                    delete t.children[d];   // collapsed → drop stale cache so re-expand re-lists fresh
                }
            }
        },
        // PURE (unit-tested): newline `git status --porcelain` output → { status, dirty }.
        //  status: absolute path → 'untracked' | 'new' | 'mod' (the color class).
        //  dirty:  absolute path of every ANCESTOR dir of a changed file → true,
        //          so a collapsed folder still signals edits inside it.
        // One record per line: "XY <path>"; a rename/copy is "XY <old> -> <new>" —
        // we color the NEW path. (No -z here — see aiRefreshTree for why.)
        _aiParsePorcelain(out, root) {
            const status = {}, dirty = {};
            // git still C-quotes a path with control chars/quotes/backslashes even
            // under core.quotePath=false; strip the wrapping quotes and decode the
            // escapes so the key matches the real filesystem name.
            const unquote = (p) => (p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"')
                ? this._aiDecodeGitPath(p.slice(1, -1)) : p;
            for (const line of String(out || '').split('\n')) {
                if (!line || line.length < 4) continue;
                const x = line[0], y = line[1];
                const spec = line.slice(3);
                let rel;
                if (x === 'R' || x === 'C') {
                    // rename/copy ONLY: "<old> -> <new>", each side possibly C-quoted.
                    // Find the " -> " OUTSIDE the (quoted) old name so an arrow inside
                    // a quoted old name isn't mistaken for the separator. (Doing this
                    // split for every line would corrupt an ordinary name with " -> ".)
                    let i = 0;
                    if (spec[0] === '"') { i = 1; while (i < spec.length) { if (spec[i] === '\\') { i += 2; continue; } if (spec[i] === '"') { i++; break; } i++; } }
                    const arrow = spec.indexOf(' -> ', i);
                    rel = unquote(arrow !== -1 ? spec.slice(arrow + 4) : spec);
                } else {
                    rel = unquote(spec);
                }
                let cls;
                if (x === '?' && y === '?') cls = 'untracked';       // not in the repo (red)
                else if (x === 'A' || y === 'A') cls = 'new';        // added/new (green)
                else cls = 'mod';                                    // modified/renamed/deleted (blue)
                status[root + '/' + rel] = cls;
                const segs = rel.split('/');
                let acc = root;
                for (let k = 0; k < segs.length - 1; k++) { acc = acc + '/' + segs[k]; dirty[acc] = true; }
            }
            return { status, dirty };
        },
        // Flatten the expanded tree into an ordered, depth-tagged list for x-for
        // (Alpine has no recursive templates). Recomputed each render off the
        // reactive children/expanded/status maps; lazy-expand keeps it bounded.
        _aiTreePush(session, dir, depth, out) {
            const kids = session.tree.children[dir] || [];
            for (const e of kids) {
                const isDir = e.type === 'd';
                const expanded = isDir && !!session.tree.expanded[e.path];
                const cxMap = session.tree.cx;   // filled by the scc Complexity pane
                out.push({
                    name: e.name, path: e.path, type: e.type, depth, expanded,
                    cls: isDir ? (session.tree.dirty[e.path] ? 'dir-dirty' : '') : (session.tree.status[e.path] || ''),
                    cx: (!isDir && cxMap && cxMap[e.path] != null) ? cxMap[e.path] : null,
                });
                if (expanded) this._aiTreePush(session, e.path, depth + 1, out);
            }
        },
        aiTreeNodes(session) {
            if (!session || !session.tree || !this._aiTreeRoot(session)) return [];
            const out = [];
            this._aiTreePush(session, session.tree.root, 0, out);
            return out;
        },
        _aiTreeRel(session, path) {
            const root = session.tree && session.tree.root;
            return (root && path.indexOf(root + '/') === 0) ? path.slice(root.length + 1) : path;
        },
        // Reveal the diff pane and focus this file's diff (select-only). A dir
        // row toggles instead. If the file has no changes the pane still opens
        // (showing "No changes"), which is the honest answer.
        aiTreeShowDiff(tab, session, node) {
            if (!tab || !session || !node || node.type === 'd') return;
            const rel = this._aiTreeRel(session, node.path);
            tab.aiDiffCollapsed = false;
            // Focus ONLY the clicked file — even when it has no changes, so the
            // pane shows this file's own (empty) diff rather than leaving the
            // previously-selected file's diff (or all changes) misleadingly up.
            // `focus` pins the file so a diff refresh (triggered by an UNRELATED
            // file changing) can't prune it from `selected` and snap the pane
            // back to all changes; it clears on any manual selection change.
            session.diff.focus = rel;
            session.diff.selected = [rel];
            this.$nextTick(() => {
                const inst = ExRT.term.get(session.id);
                if (inst && inst.fitAddon) { try { inst.fitAddon.fit(); } catch (e) {} }
            });
        },
        async aiTreeEdit(session, node) {
            if (!session || !node || node.type === 'd') return;
            let size = 0;
            try { const st = await FS.statOne(node.path); if (st) size = st.size || 0; } catch (e) {}
            await this.openEditor({ path: node.path, name: node.name, type: 'f', size });
        },
        async aiTreePreview(session, node) {
            if (!session || !node || node.type === 'd') return;
            let size = 0;
            try { const st = await FS.statOne(node.path); if (st) size = st.size || 0; } catch (e) {}
            await this.openPreview({ path: node.path, name: node.name, type: 'f', size });
        },
        aiTreeHasDiff(session, node) {
            if (!session || !node || node.type === 'd' || !session.diff) return false;
            return (session.diff.files || []).some(f => f.file === this._aiTreeRel(session, node.path));
        },

        aiStartDiffPoll(tab, session) {
            if (!session) return;
            this.aiStopDiffPoll(session);   // bumps the generation, retiring any in-flight tick
            const gen = (_aiPollGen.get(session.id) || 0) + 1;
            _aiPollGen.set(session.id, gen);
            const tick = async () => {
                if (_aiPollGen.get(session.id) !== gen) return;   // a newer poll superseded this chain
                const at = this.activeTab && this.activeTab();
                const hidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
                if (!at || at.id !== tab.id || tab.activeTermId !== session.id || hidden) { _aiTimers.delete(session.id); return; }
                await this.aiRefreshDiff(session);
                // A Refresh / tab-switch during the await starts a new chain and
                // retires this one — don't publish stale results or reschedule.
                if (_aiPollGen.get(session.id) !== gen) return;
                // Keep the repo tree's git-status colors live alongside the diff,
                // but only while its pane is open (no cost when it's collapsed).
                // Awaited (not fire-and-forget) so a slow refresh can't overlap the
                // next tick; re-check the generation afterwards before rescheduling.
                if (session.diff.repo && tab.aiTreeCollapsed === false) {
                    await this._aiTreeEnsureRoot(session);
                    if (_aiPollGen.get(session.id) !== gen) return;
                }
                // Repo: fast live updates. Non-repo: keep polling SLOWLY (not a
                // tight loop) so `git init` in that folder is picked up on its own
                // instead of the pane being frozen forever.
                _aiTimers.set(session.id, setTimeout(tick, session.diff.repo ? 1500 : 6000));
            };
            _aiTimers.set(session.id, setTimeout(tick, 250));
        },
        // Bump the generation so an in-flight tick won't reschedule, and clear the
        // pending timer.
        aiStopDiffPoll(session) {
            if (!session) return;
            _aiPollGen.set(session.id, (_aiPollGen.get(session.id) || 0) + 1);
            const t = _aiTimers.get(session.id); if (t) { clearTimeout(t); _aiTimers.delete(session.id); }
        },

        // Move a RUNNING terminal session (shell or tmux — e.g. one where you
        // launched claude/codex yourself) into the AI split view: it keeps its
        // live PTY and on-screen xterm and gains the live git-diff pane beside it.
        // The xterm's DOM element is re-parented into the new agent container so
        // the process is never restarted (works for both shell and tmux).
        async moveTerminalToAiView(srcTab, termId) {
            srcTab = (srcTab && this.tabs.find(t => t.id === srcTab.id)) || srcTab;
            const src = ((srcTab && srcTab.terminals) || []).find(t => t.id === termId);
            if (!src) return;
            const inst = ExRT.term.get(termId);
            if (!inst || !inst.term || !inst.term.element) { this.toast('This terminal isn’t ready yet — try again in a moment.', 'warning'); return; }
            if (src.isAgent) { this.toast('This session is already in AI view.', 'info'); return; }

            // Resolve the session's REAL working directory for the diff. A tmux
            // session's record dir is where `tmux attach` ran — NOT where the shell
            // (and claude/codex) inside it is now — so ask tmux for the pane's
            // current path; otherwise the diff would target the wrong/empty repo.
            let realDir = src.dir;
            if (src.tmux) {
                try {
                    // The ACTIVE pane's cwd (where the CLI runs) — not merely the
                    // first pane, which in a split window may be a different repo.
                    const script = 'tmux list-panes -t "=$1" -F "#{pane_active}|#{pane_current_path}" 2>/dev/null'
                        + ' | awk -F"|" \'NR==1{f=$2} $1==1{print $2;d=1;exit} END{if(!d)print f}\'';
                    const out = await cockpit.spawn(['sh', '-c', script, 'sh', src.tmux], { err: 'message' });
                    const p = String(out || '').trim();
                    if (p && p[0] === '/') realDir = p;
                } catch (e) { /* keep src.dir */ }
            }

            // The record may have been closed while we awaited tmux — re-check.
            if (!((srcTab && srcTab.terminals) || []).find(t => t.id === termId)) return;

            // Decorate the existing record as an agent session (same id/PTY/xterm).
            src.isAgent = true;
            if (!src.tool) src.tool = 'claude';                 // generic — only picks the ✦/◆ icon
            // A tmux-backed terminal keeps its tmux mode so persistence saves it
            // as tmux and a later restore REATTACHES instead of relaunching.
            if (src.tmux && src.launch !== 'tmux') src.launch = 'tmux';
            else if (!src.launch) src.launch = 'shell';
            src.dir = realDir || src.dir || srcTab.path || this.homePath || '/';
            src.diff = src.diff || { text: '', mode: 'all', repo: true, files: [], hash: '', note: '', selected: [], root: '', rootFor: '' };
            src.tree = src.tree || { root: '', rootFor: '', expanded: {}, children: {}, status: {}, dirty: {}, statusHash: '', loading: {} };
            if (this._sccEnsure) this._sccEnsure(src);
            if (!src.label) src.label = src.tmux || src.tool;

            // New agent tab; MOVE the record into it (out of the source tab).
            const agentTab = { id: Util.uid(), kind: 'agent', title: '✦ ' + (src.tool || 'ai'), path: src.dir, terminals: [], activeTermId: null };
            this.tabs.push(agentTab);
            const at = this.tabs.find(t => t.id === agentTab.id);
            const si = srcTab.terminals.findIndex(t => t.id === termId);
            if (si >= 0) srcTab.terminals.splice(si, 1);
            // The moved record is gone from the source tab — re-point its active
            // terminal to a survivor (or clear it), else returning to that tab
            // would show no terminal (every remaining container's x-show is false).
            if (srcTab.activeTermId === termId) {
                srcTab.activeTermId = srcTab.terminals.length ? srcTab.terminals[Math.min(si, srcTab.terminals.length - 1)].id : null;
            }
            at.terminals.push(src);
            const moved = at.terminals.find(t => t.id === termId) || src;   // reactive proxy in the new tab
            at.activeTermId = termId;
            this.activeTabId = at.id;

            // The source tab (terminal/agent) owns its tab → close it if now empty;
            // a dir tab just loses its split.
            if ((srcTab.kind === 'terminal' || srcTab.kind === 'agent') && srcTab.terminals.length === 0) {
                const ti = this.tabs.findIndex(t => t.id === srcTab.id);
                if (ti >= 0) this.tabs.splice(ti, 1);
            } else if (srcTab.kind === 'dir' && srcTab.terminals.length === 0) {
                srcTab.splitOpen = false;
            }

            // Re-parent the live xterm into the new agent container, then poll diff.
            this.$nextTick(() => {
                const container = document.getElementById('term-container-' + termId);
                if (container && inst.term.element) {
                    try { container.appendChild(inst.term.element); inst.container = container; } catch (e) {}
                    try { inst.fitAddon && inst.fitAddon.fit(); } catch (e) {}
                    try { inst.term.focus(); } catch (e) {}
                }
                this.aiStartDiffPoll(at, moved);
            });
            this.toast('Moved to AI view — live diff enabled.', 'success');
        },

        // Restart the active agent session's poll (called on tab activate + when
        // the page becomes visible again).
        aiResumePollForActive() {
            const tab = this.activeTab && this.activeTab();
            if (!tab) return;
            // A dir tab with the inline repo panel open: its diff poll's tick dies
            // on document-hidden, so restart it when the tab/page is visible again.
            if (tab.kind === 'dir') { if (tab.repoPanelOpen && this._repoStartPoll) this._repoStartPoll(tab); return; }
            if (tab.kind !== 'agent') return;
            const s = this.aiActiveSession(tab);
            if (s) this.aiStartDiffPoll(tab, s);   // restart regardless of prior repo state (the tick re-checks)
        },

        // Rebuild AI tabs saved last session (persistTabs). Each session reuses
        // its saved launch mode: a tmux session RE-ATTACHES if still alive (the
        // running claude/codex comes right back) or is re-created (running the
        // CLI) if gone; a shell session re-runs the CLI (resuming when it has a
        // resume id, else a fresh prompt). Restored tabs mount lazily on activate,
        // so this doesn't steal focus from the restored active tab.
        async aiRestoreAgentTabs(saved) {
            const list = (saved && Array.isArray(saved.agentTabs)) ? saved.agentTabs : [];
            for (const at of list) {
                const sessions = (at && Array.isArray(at.sessions)) ? at.sessions.filter(s => s && (s.tool === 'claude' || s.tool === 'codex')) : [];
                if (!sessions.length) continue;
                const tab = { id: Util.uid(), kind: 'agent', title: '✦ ' + sessions[0].tool, path: sessions[0].dir || this.homePath || '/', terminals: [], activeTermId: null };
                if (at.title) tab.customTitle = at.title;   // restore user-set tab title (double-click)
                this.tabs.push(tab);
                const rtab = this.tabs.find(t => t.id === tab.id);
                for (const s of sessions) {
                    await this.aiAddSession(rtab, s.tool, {
                        dir: s.dir, resumeId: s.resumeId || null, label: s.label || null,
                        restore: true, launch: s.launch === 'tmux' ? 'tmux' : 'shell', tmuxName: s.tmux || null,
                    });
                    // aiAddSession appends the new session to rtab.terminals; restore
                    // its user-set sub-tab title onto that record.
                    if (s.title && rtab.terminals.length) rtab.terminals[rtab.terminals.length - 1].customTitle = s.title;
                }
                // Drop a tab that produced no sessions (e.g. addTerminalToTab failed).
                if (!rtab.terminals || !rtab.terminals.length) {
                    const i = this.tabs.findIndex(t => t.id === rtab.id);
                    if (i >= 0) this.tabs.splice(i, 1);
                    continue;
                }
                // If the user activated this tab while we were still (async) adding
                // its sessions, activation found it empty and mounted nothing — mount
                // the active session now (the shell/tmux path resolves on mount).
                if (this.activeTabId === rtab.id) {
                    this._ensureTerminalsMounted(rtab);
                    if (this.aiResumePollForActive) this.aiResumePollForActive();
                }
            }
        },

        // Resolve a restored tmux session's create-vs-attach decision at the exact
        // moment it mounts (called from _mountTerminal's guard, so every mount path
        // is covered). It only commits when the session's container is actually
        // VISIBLE — and re-checks after the async tmux lookup — so if the user
        // switches away mid-check the decision stays PENDING and is re-evaluated
        // against fresh liveness next time. Run the CLI only when creating the
        // session; attach silently when it's alive.
        _aiMountRestoredTmux(termId, dir, attempt) {
            const term = this._findTermById(termId);
            if (!term || term._tmuxRestoreCli == null || !term.tmux) return;
            attempt = attempt || 0;
            const visible = () => { const c = document.getElementById('term-container-' + termId); return !!(c && c.offsetHeight > 0); };
            if (!visible()) {
                // Container not sized yet (tab still laying out). Retry briefly, like
                // _mountTerminal; give up after ~1s so a session that stayed hidden
                // remains pending and is re-evaluated on the next activation.
                if (attempt < 20) setTimeout(() => this._aiMountRestoredTmux(termId, dir, attempt + 1), 50);
                return;
            }
            const cli = term._tmuxRestoreCli;
            this._aiTmuxExists(term.tmux).then(exists => {
                const t2 = this._findTermById(termId);
                if (!t2 || t2._tmuxRestoreCli == null) return; // closed/resolved during the await
                if (!visible()) return;                        // switched away → keep pending, re-check later
                t2.initCommand = exists ? null : cli;          // create → run CLI; attach → nothing
                t2._tmuxRestoreCli = null;
                if (!ExRT.term.get(termId)) this._mountTerminal(termId, dir);
            }).catch(() => {});
        },

        // ───────── session browser (resume) ─────────

        async openAgentSessions() {
            // Set loading BEFORE showing, so the modal's first paint already has
            // the spinner (no empty flash while the scan runs).
            this.agentBrowser.loading = true; this.agentBrowser.rows = [];
            bootstrap.Modal.getOrCreateInstance(this.agentSessionsModalEl).show();
            try {
                if (!this._aiHome) this._aiHome = (await cockpit.spawn(['sh', '-c', 'echo $HOME'])).trim();
                this.agentBrowser.rows = await this.scanAiSessions(this.settings, this._aiHome);
            } catch (e) { this.toast('Could not read AI sessions: ' + (e.message || e), 'danger'); }
            finally { this.agentBrowser.loading = false; }
        },

        aiFilteredSessions() {
            const b = this.agentBrowser, q = (b.q || '').toLowerCase();
            return (b.rows || []).filter(r => (b.filter === 'all' || r.tool === b.filter) &&
                (!q || ((r.cwd || '') + ' ' + (r.title || '')).toLowerCase().includes(q)));
        },

        // Filtered rows, grouped by project folder for the disclosure list.
        aiGroupedSessions() { return this._aiGroupByProject(this.aiFilteredSessions()); },

        aiRelTime(epoch) {
            const s = Math.max(0, Math.floor(Date.now() / 1000 - (epoch || 0)));
            if (s < 60) return s + 's ago';
            if (s < 3600) return Math.floor(s / 60) + 'm ago';
            if (s < 86400) return Math.floor(s / 3600) + 'h ago';
            return Math.floor(s / 86400) + 'd ago';
        },

        aiResume(row) {
            if (!(this.ai.have && this.ai.have[row.tool])) { this.toast(row.tool + ' is not installed on this host — cannot resume this session.', 'danger'); return; }
            try { bootstrap.Modal.getOrCreateInstance(this.agentSessionsModalEl).hide(); } catch (e) {}
            this.openAgentTab(row.tool, row.cwd, { resumeId: row.id });
        },

        // Delete session transcript files. Only OUR files: absolute `.jsonl` paths
        // (they always come from a `find` under a configured session dir), passed
        // as argv to `rm -f --` — never shell-interpolated. Returns true on success.
        async _aiDeletePaths(paths) {
            const valid = (paths || []).filter(p => typeof p === 'string' && p.startsWith('/') && p.endsWith('.jsonl'));
            if (!valid.length) return false;
            try { await cockpit.spawn(['rm', '-f', '--', ...valid], { err: 'message' }); return true; }
            catch (e) { this.toast('Could not delete: ' + (e.message || e), 'danger'); return false; }
        },

        async aiDeleteSession(row) {
            if (!(await this.askConfirm('Delete session',
                `Delete this ${row.tool} session? It removes the transcript file permanently and the session can no longer be resumed.` +
                (row.title ? `\n\n“${row.title}”` : ''), 'Delete'))) return;
            if (!(await this._aiDeletePaths([row.path]))) return;
            this.agentBrowser.rows = this.agentBrowser.rows.filter(r => r.path !== row.path);
            this.toast('Session deleted.', 'success');
        },

        async aiDeleteGroup(group) {
            if (!(await this.askConfirm('Delete all sessions',
                `Delete ALL ${group.count} ${group.count === 1 ? 'session' : 'sessions'} for this project? This permanently removes their transcript files.\n\n${group.cwd}`,
                'Delete all'))) return;
            const paths = group.sessions.map(s => s.path);
            if (!(await this._aiDeletePaths(paths))) return;
            const gone = new Set(paths);
            this.agentBrowser.rows = this.agentBrowser.rows.filter(r => !gone.has(r.path));
            this.toast(`Deleted ${paths.length} session${paths.length === 1 ? '' : 's'}.`, 'success');
        },
    };
})();
