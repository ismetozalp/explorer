// Integrated terminals (xterm.js + Cockpit PTY), the tmux session manager,
// and the sub-tab path popover. Extracted from app.js (2.0 modularization).
// Methods only; terminal/tmux/shells reactive state stays in app.js; xterm
// instances live on window.ExRT.term.
window.ExplorerTerminal = {
    // Architecture:
    //   tab.terminals     — reactive [{ id, dir, label }]
    //   tab.activeTermId  — id of the currently visible terminal (sub-tab)
    //   tab.splitOpen     — dir-kind tabs only: is the right-side pane open
    //   tab.splitWidth    — dir-kind tabs only: pane width in px
    //   tab.kind='terminal' — full-tab terminal stack, no file list
    //
    // The xterm Terminal + cockpit channel for each terminal live in the
    // module-scope ExRT.term.map Map keyed by *terminal* id (not tab id).
    // Keeping them out of Alpine's reactive walk is essential — same lesson
    // as ExRT.ops.cbs (operations cancel-fn bug, v1.0.4).

    _defaultTermLabel(dir, existing) {
        let base = Util.basename(dir) || '/';
        const taken = new Set((existing || []).map(t => t.label));
        if (!taken.has(base)) return base;
        let i = 2;
        while (taken.has(base + ' ' + i)) i++;
        return base + ' ' + i;
    },

    _findTermById(termId) {
        for (const tab of this.tabs) {
            const t = (tab.terminals || []).find(x => x.id === termId);
            if (t) return t;
        }
        return null;
    },

    // Add a new terminal sub-tab inside this tab. Opens split pane for dir tabs.
    addTerminalToTab(tab, dir, opts) {
        opts = opts || {};
        if (!tab) tab = this.activeTab();
        if (!tab) return;
        // Re-acquire the reactive proxy from this.tabs. Callers may hand
        // us a stale raw reference (e.g. newTerminalTab passes the local
        // `tab` variable from before this.tabs.push). Alpine/Vue3 reactivity
        // is tracked through the Proxy in the array — mutations via the raw
        // reference don't trigger template updates. This is why the sub-tab
        // bar was rendering empty on first open after newTerminalTab.
        const reactive = this.tabs.find(t => t && t.id === tab.id);
        if (reactive) tab = reactive;

        if (!dir) dir = tab.path || this.homePath || '/';
        if (!tab.terminals) tab.terminals = [];

        const termId = Util.uid();
        const term = { id: termId, dir: dir, label: this._defaultTermLabel(dir, tab.terminals) };
        // tmux-backed terminal: attach to (or create) a named session. The
        // session persists across tab/app close (no destroy-unattached) so it
        // can be re-attached and restored later.
        if (opts.tmux) { term.tmux = opts.tmux; term.label = opts.tmux; }
        tab.terminals.push(term);
        tab.activeTermId = termId;

        if (tab.kind === 'dir') {
            tab.splitOpen = true;
            if (!tab.splitWidth) tab.splitWidth = 480;
        }

        // opts.mount === false defers the xterm/PTY mount until the tab is
        // activated (a hidden container has zero height, so mounting now would
        // just spin and fail). _ensureTerminalsMounted handles it on activate.
        if (opts.mount !== false) this.$nextTick(() => this._mountTerminal(termId, dir));
        return term;
    },

    // Convenience for the toolbar/context-menu — opens split if closed,
    // creates the first terminal at `path`, or focuses the existing active.
    openIntegratedTerminal(tab, path) {
        if (!tab) tab = this.activeTab();
        if (!tab) return;
        if (!tab.terminals) tab.terminals = [];
        if (tab.terminals.length === 0) {
            this.addTerminalToTab(tab, path || tab.path);
        } else {
            if (tab.kind === 'dir') tab.splitOpen = true;
            const active = tab.activeTermId || tab.terminals[0].id;
            this.selectTerminal(tab, active);
        }
    },

    // Sub-tab-bar "+" dispatcher: plain tabs get a new shell; tmux tabs get a
    // new tmux session (same prompt as the header manager).
    addPaneToTab(tab) {
        if (this.termKindOf(tab) === 'tmux') return this.newTmuxSessionInTab(tab);
        return this.addTerminalToTab(tab, tab.path);
    },

    async newTmuxSessionInTab(tab) {
        const name = await this._promptTmuxName();
        if (name) this.addTmuxSessionToTab(tab, name);
    },

    // Add (or focus) a tmux session as a sub-tab inside an existing tmux tab.
    addTmuxSessionToTab(tab, name, opts) {
        const existing = (tab.terminals || []).find(t => t.tmux === name);
        if (existing) { this.selectTerminal(tab, existing.id); return existing; }
        return this.addTerminalToTab(tab, tab.path, Object.assign({ tmux: name }, opts || {}));
    },

    // Create a new MAIN tab whose only content is a terminal stack.
    newTerminalTab(dir) {
        dir = dir || this.activeTab()?.path || this.homePath || '/';
        const raw = this._buildTab(dir, 'terminal');
        this.tabs.push(raw);
        this.activeTabId = raw.id;
        // After push, this.tabs contains a reactive proxy wrapping `raw`.
        // Pass the *proxy* to $nextTick so mutations inside addTerminalToTab
        // trigger template updates (sub-tab bar re-render).
        const reactive = this.tabs.find(t => t.id === raw.id);
        this.$nextTick(() => this.addTerminalToTab(reactive, dir));
        return reactive;
    },

    // ───── tmux session manager ──────────────────────────────────────────────
    async _hasTmux() {
        try {
            const out = await cockpit.spawn(['sh', '-c', 'command -v tmux 2>/dev/null'], { err: 'ignore' });
            const p = (out || '').trim().split('\n')[0];
            if (p) { this.tmux.bin = p; return true; }
        } catch (e) {}
        return false;
    },

    async _listTmuxSessions() {
        const bin = this.tmux.bin || 'tmux';
        let out = '';
        try {
            // Put the variable-length session name LAST and separate the two
            // leading numeric fields with plain spaces. Avoids any control
            // characters in the spawn arguments (a control byte like 0x1F can
            // make cockpit-ws drop the whole transport), and parses correctly
            // even when a session name contains spaces or colons.
            out = await cockpit.spawn(
                [bin, 'list-sessions', '-F', '#{session_windows} #{?session_attached,1,0} #{session_name}'],
                { err: 'message' });
        } catch (e) {
            // "no server running" simply means there are no sessions yet.
            const msg = (e && (e.message || e.toString())) || '';
            if (/no server running|no such file|failed to connect|error connecting/i.test(msg)) return [];
            throw e;
        }
        return (out || '').split('\n').filter(l => l.length).map(l => {
            const m = l.match(/^(\d+)\s+([01])\s+(.*)$/);
            if (!m) return null;
            return { name: m[3], windows: parseInt(m[1], 10) || 1, attached: m[2] === '1' };
        }).filter(Boolean);
    },

    async refreshTmuxSessions() {
        this.tmux.loading = true;
        this.tmux.error = '';
        this._checkTmuxConf();
        try {
            this.tmux.sessions = await this._listTmuxSessions();
        } catch (e) {
            this.tmux.error = (e && (e.message || e)) || 'Could not list tmux sessions';
            this.tmux.sessions = [];
        } finally {
            this.tmux.loading = false;
        }
    },

    _tmuxConfPath() { return (this.homePath || '') + '/.tmux.conf'; },

    // Show the "Edit .tmux.conf" button only when the user actually has one.
    async _checkTmuxConf() {
        try {
            const out = await cockpit.spawn(['sh', '-c', `test -f ${Util.shq(this._tmuxConfPath())} && echo Y`], { err: 'message' });
            this.tmux.hasConf = (out || '').trim() === 'Y';
        } catch (e) { this.tmux.hasConf = false; }
    },

    async _statSize(path) {
        try { const o = await cockpit.spawn(['stat', '-c', '%s', path], { err: 'message' }); return parseInt((o || '').trim(), 10) || 0; }
        catch (e) { return 0; }
    },

    async editTmuxConf() {
        const path = this._tmuxConfPath();
        this.tmux.open = false;
        const size = await this._statSize(path);
        await this.openEditor({ path, name: '.tmux.conf', type: 'f', size });
    },

    toggleTmuxPanel(ev) {
        this.tmux.open = !this.tmux.open;
        if (this.tmux.open) {
            try {
                const r = ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect
                    ? ev.currentTarget.getBoundingClientRect() : null;
                if (r) {
                    this.tmux.top = Math.round(r.bottom + 4);
                    this.tmux.right = Math.max(4, Math.round(window.innerWidth - r.right));
                }
            } catch (e) {}
            this.refreshTmuxSessions();
        }
    },

    // The single tmux container tab — every tmux session lives here as a sub-tab.
    _tmuxTab() {
        return this.tabs.find(t => t.kind === 'terminal' && this.termKindOf(t) === 'tmux');
    },
    // Locate an open session's tab + sub-terminal by session name.
    _findTmuxSubtab(name) {
        for (const tab of this.tabs) {
            if (tab.kind !== 'terminal') continue;
            const term = (tab.terminals || []).find(t => t.tmux === name);
            if (term) return { tab, term };
        }
        return null;
    },
    isTmuxSessionOpen(name) { return !!this._findTmuxSubtab(name); },

    // Open a tmux session as a sub-tab of the single tmux container tab:
    // focus it if already open, else add it to the existing tmux tab, else
    // create the tmux tab with it as the first session.
    openTmuxSession(name) {
        this.tmux.open = false;
        if (!name) return;
        const hit = this._findTmuxSubtab(name);
        if (hit) {
            this.activateTab(hit.tab.id);
            this.selectTerminal(hit.tab, hit.term.id);
            return;
        }
        const container = this._tmuxTab();
        if (container) {
            this.activateTab(container.id);
            this.addTmuxSessionToTab(container, name);
            return;
        }
        this.newTmuxTerminalTab(name);
    },

    // Shared "New tmux session" prompt + validation, used by both the header
    // manager and the sub-tab-bar "+". Returns a clean name, or null if
    // cancelled/invalid (an invalid name toasts before returning null).
    async _promptTmuxName() {
        const name = await this.askPrompt('New tmux session', 'Session name (letters, digits, - or _)', '');
        const clean = (name || '').trim();
        if (!clean) return null;
        if (/[\s.:]/.test(clean)) {
            this.toast('Session name can\'t contain spaces, "." or ":"', 'warning');
            return null;
        }
        return clean;
    },

    async newTmuxSession() {
        this.tmux.open = false;
        const name = await this._promptTmuxName();
        if (name) this.openTmuxSession(name);
    },

    async killTmuxSession(name) {
        const ok = await this.askConfirm('Kill tmux session',
            'Kill tmux session "' + name + '"? Anything running inside it will be terminated.', 'Kill');
        if (!ok) return;
        const bin = this.tmux.bin || 'tmux';
        try { await cockpit.spawn([bin, 'kill-session', '-t', name], { err: 'message' }); }
        catch (e) { this.toast('Could not kill session: ' + (e.message || e), 'danger'); }
        // Close any open terminal/tab bound to it.
        const hit = this._findTmuxSubtab(name);
        if (hit) this.closeTerminal(hit.tab, hit.term.id);
        this.refreshTmuxSessions();
    },

    // A terminal tab bound to a single tmux session.
    newTmuxTerminalTab(name, opts) {
        opts = opts || {};
        const activate = opts.activate !== false;
        const dir = this.activeTab()?.path || this.homePath || '/';
        const raw = this._buildTab(dir, 'terminal');
        raw.termKind = 'tmux';                          // kind marker (label, routing, "+")
        raw.tmux = name;                               // tab-level marker (legacy fallback for termKindOf only)
        this.tabs.push(raw);
        const reactive = this.tabs.find(t => t.id === raw.id);
        if (activate) this.activeTabId = raw.id;
        this.$nextTick(() => {
            // When restoring in the background (activate:false) the tab is
            // hidden, so don't mount the terminal yet — it would just fail to
            // size. The sub-tab still shows and it mounts on first activation.
            this.addTerminalToTab(reactive, dir, { tmux: name, mount: activate });
            this._persistTabs();
        });
        return reactive;
    },

    // Make sure every terminal in a tab has a live xterm/channel instance.
    // Used when activating a (restored) terminal tab whose terminals were
    // declared but never mounted because the tab wasn't visible yet.
    _ensureTerminalsMounted(tab) {
        if (!tab || tab.kind !== 'terminal' || !tab.terminals) return;
        for (const t of tab.terminals) {
            if (!ExRT.term.get(t.id)) {
                this.$nextTick(() => this._mountTerminal(t.id, t.dir));
            }
        }
    },

    // Re-open tmux terminal tabs saved last session, but only for sessions
    // that are still alive on the tmux server. Any saved session that no
    // longer exists is pruned from the persisted tab list (so it isn't kept
    // around or retried on later loads) and is never opened.
    // Create an empty tmux container tab (no sessions yet), in the background.
    // Restore adds sessions synchronously in saved order via this; interactive
    // session creation still goes through newTmuxTerminalTab.
    _newTmuxContainerTab() {
        const raw = this._buildTab(this.homePath || '/', 'terminal');
        raw.termKind = 'tmux';
        this.tabs.push(raw);
        return this.tabs.find(t => t.id === raw.id);
    },

    async _restoreTmuxTabs() {
        const names = this._savedTmuxTabs || [];
        this._savedTmuxTabs = null;
        if (!names.length || !this.tmux.available) return;
        let live = [];
        // If we can't query tmux (transient error), leave the saved list
        // untouched and try again next load rather than wrongly pruning.
        try { live = await this._listTmuxSessions(); } catch (e) { return; }
        const liveNames = new Set(live.map(s => s.name));
        let pruned = false;
        let container = this._tmuxTab();
        for (const name of names) {
            if (!liveNames.has(name)) { pruned = true; continue; }  // gone → drop
            if (this._findTmuxSubtab(name)) continue;               // already open
            if (!container) container = this._newTmuxContainerTab(); // empty tmux tab
            this.addTmuxSessionToTab(container, name, { mount: false });
        }
        // Rewrite tabs.yml so dead sessions fall out (rebuilt from open tabs).
        if (pruned) this._persistTabs();
    },

    // Write a bash rcfile that sources the user's normal startup files and
    // then appends an OSC 7 emitter to PROMPT_COMMAND. Spawning bash with
    // --rcfile <this> makes every prompt report the live cwd, which our
    // terminal OSC 7 handler turns into the sub-tab path label. Idempotent.
    async _ensureOsc7Rc() {
        if (this._osc7RcPath) return this._osc7RcPath;
        const dir = Util.joinPath(this.homePath || '/root', '.config/cockpit/explorer');
        const path = Util.joinPath(dir, 'osc7.bash');
        const content =
            '# Auto-generated by the Cockpit explorer plugin.\n' +
            '# Sources your normal bash startup, then reports cwd via OSC 7 so\n' +
            '# the file-explorer terminal sub-tabs can show the live path.\n' +
            '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc\n' +
            '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n' +
            '__explorer_osc7() { printf \'\\033]7;file://%s%s\\033\\\\\' "${HOSTNAME:-localhost}" "$PWD"; }\n' +
            'case ";${PROMPT_COMMAND};" in\n' +
            '  *__explorer_osc7*) ;;\n' +
            '  *) PROMPT_COMMAND="__explorer_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;\n' +
            'esac\n' +
            '__explorer_osc7\n';
        try {
            await cockpit.spawn(['mkdir', '-p', dir]);
            await cockpit.file(path).replace(content);
            this._osc7RcPath = path;
        } catch (e) {
            console.warn('[explorer] could not write OSC7 rcfile:', e);
            this._osc7RcPath = null;
        }
        return this._osc7RcPath;
    },

    // Update a terminal's tracked working directory (from OSC 7) and refresh
    // its sub-tab label. Searches all tabs since termId is globally unique.
    _updateTerminalDir(termId, dir) {
        if (!dir) return;
        for (const tab of this.tabs) {
            if (!tab.terminals) continue;
            const t = tab.terminals.find(x => x.id === termId);
            if (t) { if (t.dir !== dir) t.dir = dir; return; }
        }
    },

    // ── Sub-tab path hover popover (full path + copy) ──────────────────
    showTermPath(ev, t) {
        clearTimeout(this._termPathTimer);
        const r = ev.currentTarget.getBoundingClientRect();
        this.termPathPop = { open: true, top: Math.round(r.bottom + 3), left: Math.round(r.left), path: t.dir || '/' };
    },
    hideTermPath() {
        clearTimeout(this._termPathTimer);
        this._termPathTimer = setTimeout(() => { this.termPathPop.open = false; }, 250);
    },
    keepTermPath() { clearTimeout(this._termPathTimer); },
    _copyToClipboard(text) {
        const p = text || '';
        let ok = false;
        try {
            const ta = document.createElement('textarea');
            ta.value = p; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.focus(); ta.select();
            ok = document.execCommand('copy');
            ta.remove();
        } catch (e) {}
        if (!ok && navigator.clipboard) { try { navigator.clipboard.writeText(p); ok = true; } catch (e) {} }
        return ok;
    },

    copyTermPath() {
        const ok = this._copyToClipboard(this.termPathPop.path || '');
        this.toast(ok ? 'Path copied' : 'Could not copy path', ok ? 'info' : 'error');
        this.termPathPop.open = false;
    },

    // Double-clicking a terminal sub-tab copies its working directory.
    copyTermDir(t) {
        const p = (t && t.dir) || '';
        const ok = this._copyToClipboard(p);
        this.toast(ok ? ('Copied path: ' + p) : 'Could not copy path', ok ? 'info' : 'error');
    },

    selectTerminal(tab, termId) {
        if (!tab || !tab.terminals) return;
        if (!tab.terminals.find(t => t.id === termId)) return;
        tab.activeTermId = termId;
        // Newly-visible xterm has stale dimensions if it was display:none;
        // refit and refocus on next tick.
        this.$nextTick(() => {
            const inst = ExRT.term.get(termId);
            if (inst) {
                try { inst.fitAddon.fit(); } catch (e) {}
                try { inst.term.focus(); } catch (e) {}
            }
        });
    },

    closeTerminal(tab, termId) {
        if (!tab || !tab.terminals) return;
        const idx = tab.terminals.findIndex(t => t.id === termId);
        if (idx < 0) return;

        const inst = ExRT.term.get(termId);
        if (inst && inst.onWinResize) {
            try { window.removeEventListener('resize', inst.onWinResize); } catch (e) {}
        }
        ExRT.term.del(termId);

        tab.terminals.splice(idx, 1);

        if (tab.activeTermId === termId) {
            if (tab.terminals.length === 0) {
                tab.activeTermId = null;
                if (tab.kind === 'dir') {
                    tab.splitOpen = false;
                } else if (tab.kind === 'terminal') {
                    // Closing last terminal in a terminal-kind tab closes the tab.
                    this.closeTab(tab.id);
                    return;
                }
            } else {
                const next = tab.terminals[Math.min(idx, tab.terminals.length - 1)];
                this.selectTerminal(tab, next.id);
            }
        }
    },

    closeSplit(tab) {
        // Close the entire split pane (and all its terminals) on a dir tab.
        if (!tab || !tab.terminals) return;
        const ids = tab.terminals.map(t => t.id);
        for (const id of ids) {
            const inst = ExRT.term.get(id);
            if (inst && inst.onWinResize) {
                try { window.removeEventListener('resize', inst.onWinResize); } catch (e) {}
            }
            ExRT.term.del(id);
        }
        tab.terminals = [];
        tab.activeTermId = null;
        if (tab.kind === 'dir') tab.splitOpen = false;
    },

    _mountTerminal(termId, dir, attempt) {
        if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) {
            this.toast('xterm.js not loaded — terminal unavailable', 'error');
            return;
        }
        attempt = attempt || 0;
        const container = document.getElementById('term-container-' + termId);
        if (!container || container.offsetHeight === 0) {
            // Container not yet in DOM, or DOM in but parent has no height
            // yet (terminal-tab-body still flex-calculating). Retry up to ~1s.
            if (attempt < 20) {
                setTimeout(() => this._mountTerminal(termId, dir, attempt + 1), 50);
            } else if (ExRT.term.reconn.has(termId)) {
                // Reconnect-driven mount of a backgrounded terminal (its container
                // is display:none → 0-height while another tab is active). Don't
                // error or keep hammering at the wrong size: drop the backoff entry
                // and let _ensureTerminalsMounted remount it at the correct size
                // when the user activates its tab. The visible terminal, whose
                // container IS sized, reconnects actively via the backoff above.
                ExRT.term.reconn.delete(termId);
            } else {
                console.warn('[explorer] terminal container never sized; giving up', termId);
                this.toast('Terminal failed to size — try toggling the tab', 'error');
            }
            return;
        }

        const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
        const xterm = new window.Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
            scrollback: 5000,
            allowProposedApi: false,
            theme: isDark
                ? { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: '#264f78' }
                : { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: '#a8c8ee' },
        });

        const fitAddon = new window.FitAddon.FitAddon();
        xterm.loadAddon(fitAddon);
        xterm.open(container);
        try { fitAddon.fit(); } catch (e) {}

        // Image/video paste: intercept a clipboard image or video (capture phase, so we run
        // before xterm's own paste handler) and upload it instead of letting it
        // hit the shell. Text / non-image pastes are untouched — we neither
        // preventDefault nor stopPropagation, so xterm's native paste proceeds.
        // Uses the DOM paste event (clipboardData), which exposes image data on
        // both http and https with no permission prompt.
        if (xterm.textarea) {
            xterm.textarea.addEventListener('paste', (e) => {
                const items = (e.clipboardData && e.clipboardData.items) || [];
                for (const it of items) {
                    if (it.kind === 'file' && this._isPasteableMedia(it.type)) {
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

        // Clipboard: xterm does NOT copy the selection on its own. Wire the
        // standard terminal copy gestures — select-to-copy, plus Ctrl/Cmd+Shift+C
        // and Ctrl+Insert — to the OS clipboard. Ctrl+C is left as SIGINT.
        // (Paste with Ctrl+Shift+V is handled natively by xterm's textarea, so
        // it is deliberately left untouched here to avoid a double paste.)
        xterm.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;
            const mod = e.ctrlKey || e.metaKey;
            const isCopy = (mod && e.shiftKey && e.code === 'KeyC') || (e.ctrlKey && e.code === 'Insert');
            if (isCopy) {
                const sel = xterm.getSelection();
                if (sel) this.copyTextToClipboard(sel);
                return false; // swallow the chord so it never reaches the shell
            }
            return true;
        });
        // Copy-on-select (silent) — selecting text with the mouse also copies it,
        // matching common terminal UX. Best-effort; the Ctrl+Shift+C path above is
        // the reliable fallback if the browser blocks the background write.
        try {
            xterm.onSelectionChange(() => {
                const sel = xterm.getSelection();
                if (sel && navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(sel).catch(() => {});
                }
            });
        } catch (e) {}

        // OSC 7 (file://host/path) lets the shell report its working directory
        // on each prompt; many distros configure bash/zsh to emit it. When
        // present, keep the sub-tab path label in sync with the live pwd.
        try {
            xterm.parser.registerOscHandler(7, (data) => {
                let p = data || '';
                if (p.startsWith('file://')) {
                    p = p.slice(7);
                    const slash = p.indexOf('/');
                    p = slash >= 0 ? p.slice(slash) : '/';
                }
                try { p = decodeURIComponent(p); } catch (e) {}
                if (p && p.startsWith('/')) this._updateTerminalDir(termId, p);
                return true; // fully handled
            });
        } catch (e) {}

        // OSC 52 (ESC ] 52 ; <targets> ; <base64|?> BEL) — "set clipboard".
        // This is how programs that own the mouse (tmux with `mouse on`, vim,
        // etc.) push a copy out to the OUTER terminal's clipboard. Our
        // select-to-copy / Ctrl+Shift+C read xterm's own selection, which tmux
        // never populates (it grabs the drag for its copy-mode), so without this
        // handler copying from inside tmux is lost. We honour writes only; a "?"
        // read/query is ignored (never expose the clipboard to the shell).
        try {
            xterm.parser.registerOscHandler(52, (data) => {
                const i = (data || '').indexOf(';');
                if (i < 0) return true;
                const payload = data.slice(i + 1);
                if (!payload || payload === '?') return true; // ignore queries
                let text = '';
                try { text = decodeURIComponent(escape(atob(payload))); }   // UTF-8 aware
                catch (e) { try { text = atob(payload); } catch (e2) { return true; } }
                // Robust write: on a non-secure (http) origin navigator.clipboard
                // is undefined, so _copyToClipboard falls back to execCommand.
                // (On https this stays a plain navigator.clipboard write.) Without
                // the fallback, copying out of tmux/vim silently fails on http.
                if (text) this._copyToClipboard(text);
                return true; // fully handled
            });
        } catch (e) {}

        const shell = (this.settings && this.settings.defaultShell) || '/bin/bash';
        // For bash, launch with our rcfile so each prompt reports cwd via OSC 7.
        // The rcfile sources the user's own ~/.bashrc first, so their prompt /
        // aliases are untouched.
        const isBash = /(^|\/)bash$/.test(shell);
        // `-i` (interactive) is understood by the usual shells, but not by
        // terminal multiplexers / other programs a user might pick (e.g. tmux,
        // which errors "unknown option -- i" and exits). Only pass -i to known
        // interactive shells; launch anything else bare.
        const INTERACTIVE_SHELLS = ['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh', 'mksh', 'csh', 'tcsh', 'fish'];
        const shellBase = shell.replace(/.*\//, '');
        // Is this terminal bound to a tmux session (via the session manager)?
        const termObj = this._findTermById(termId);
        const tmuxSession = termObj && termObj.tmux;
        let spawnArgs;
        if (tmuxSession) {
            // Attach to the named session, creating it if it doesn't exist
            // (`new-session -A`). Deliberately NO destroy-unattached: the
            // session must survive closing the tab / browser so it can be
            // re-attached and restored next launch.
            spawnArgs = [(this.tmux.bin || 'tmux'), 'new-session', '-A', '-s', tmuxSession];
        } else if (isBash && this._osc7RcPath) {
            spawnArgs = [shell, '--rcfile', this._osc7RcPath, '-i'];
        } else if (shellBase === 'tmux') {
            // Closing a terminal only detaches the tmux client; the server keeps
            // the session alive in the background, so sessions would pile up.
            // Create a fresh session per terminal and mark it destroy-unattached
            // so it is torn down the moment its client detaches (i.e. when we
            // close the channel, or the browser disconnects).
            spawnArgs = [shell, 'new-session', ';', 'set-option', 'destroy-unattached', 'on'];
        } else if (INTERACTIVE_SHELLS.includes(shellBase)) {
            spawnArgs = [shell, '-i'];
        } else {
            spawnArgs = [shell];
        }

        // Match Cockpit's own terminal plugin: interactive shell, UTF-8 stream.
        let channel;
        try {
            channel = cockpit.channel({
                payload: 'stream',
                spawn: spawnArgs,
                pty: true,
                environ: ['TERM=xterm-256color', 'COLORTERM=truecolor', 'PAGER=cat'],
                directory: dir,
            });
        } catch (e) {
            console.error('[explorer] failed to spawn shell:', e);
            try { xterm.dispose(); } catch (e2) {}
            // Transport likely still down mid-reconnect — keep polling instead of
            // giving up. (First-ever mount will also retry, which is harmless.)
            this._scheduleTermReconnect(termId, dir);
            return;
        }

        xterm.onData(data => { try { channel.send(data); } catch (e) {} });
        let _gotData = false;
        channel.addEventListener('message', (ev, data) => {
            if (!_gotData) {
                _gotData = true;
                // Channel is live again — clear any reconnect backoff for this term.
                if (ExRT.term.reconn.has(termId)) ExRT.term.reconn.delete(termId);
            }
            try { xterm.write(data); } catch (e) { console.warn('[explorer] xterm.write failed:', e); }
        });
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
        xterm.onResize(({ cols, rows }) => {
            try { channel.control({ command: 'options', window: { rows, cols } }); } catch (e) {}
        });

        const onWinResize = () => {
            const inst = ExRT.term.get(termId);
            if (!inst) return;
            try { inst.fitAddon.fit(); } catch (e) {}
        };
        window.addEventListener('resize', onWinResize);

        ExRT.term.set(termId, { term: xterm, channel, fitAddon, container, onWinResize });

        // Final fit + force initial PTY resize. Without an initial control
        // message, some shells start with 80x24 default and don't redraw.
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
            else { this.toast('Terminal could not reconnect — reopen the tab', 'warning'); }
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

    _startTermResize(ev, tab) {
        ev.preventDefault();
        const horizontal = !!tab.dual; // dual-pane → terminal docks at the bottom
        const startX = ev.clientX, startY = ev.clientY;
        const startW = tab.splitWidth || 480;
        const startH = tab.splitHeight || 260;

        const onMove = (e) => {
            if (horizontal) {
                // Resizer sits on the TOP edge of the bottom terminal pane;
                // dragging up grows the terminal.
                const dy = startY - e.clientY;
                const maxH = Math.max(120, window.innerHeight - 220);
                tab.splitHeight = Math.max(120, Math.min(maxH, startH + dy));
            } else {
                // Resizer on the LEFT edge of the right terminal pane.
                const dx = startX - e.clientX;
                const maxW = Math.max(300, window.innerWidth - 280);
                tab.splitWidth = Math.max(220, Math.min(maxW, startW + dx));
            }
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (tab.activeTermId) {
                const inst = ExRT.term.get(tab.activeTermId);
                if (inst) { try { inst.fitAddon.fit(); } catch (e) {} }
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    },
};
