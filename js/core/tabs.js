// Tabs — tab management, pane accessors, navigation. Core, extracted from
// app.js (2.0 modularization). Methods only; tab/pane reactive state stays in app.js.
window.ExplorerTabs = {
    _buildTab(path, kind) {
        // Only three kinds are valid; coerce anything else to 'dir' so a
        // stale on-disk file can't conjure broken-state tabs on restore.
        if (kind !== 'dir' && kind !== 'output' && kind !== 'terminal') kind = 'dir';
        const tab = {
            id: Util.uid(),
            kind: kind, // 'dir' | 'output' | 'terminal'
            path: path || this.homePath,
            files: [],
            selection: [],
            sortColumn: 'name',
            sortDirection: 1, // 1 asc, -1 desc
            loading: false,
            error: null,
            errorRetryAsAdmin: false,
            listAdminPath: null,
            history: [path || this.homePath],
            historyIdx: 0,
            editingPath: false,      // per-pane path bar (dual mode)
            editingPathTop: false,   // top toolbar path bar (independent flag)
            lastClickedPath: null,
            search: { query: '', mode: 'name', recursive: false, caseInsensitive: false, regex: false, active: false },
            // for output panes
            outputLines: [],
            outputStatus: 'idle',
            outputCommand: '',
            outputActionLabel: '',
            outputChannel: null,
            follow: true,        // stay pinned to the bottom of a streaming pane
            _outBuf: '',         // partial-line buffer for chunked streaming
            _scrollRaf: 0,       // pending rAF id for coalesced auto-scroll
            _autoScrollUntil: 0, // ignore 'scroll' events until this timestamp (our own auto-scrolls)
            // ── Terminals (v1.2) ───────────────────────────────────────
            // Reactive collection only; the actual xterm Terminal /
            // cockpit channel instances live in module-scope ExRT.term.map
            // keyed by terminal.id. Used by both kind='dir' (split pane)
            // and kind='terminal' (full-tab terminal stack).
            terminals: [],          // [{ id, dir, label }]
            activeTermId: null,
            termKind: 'plain',      // terminal tabs: 'plain' | 'tmux' (source of truth)
            splitOpen: false,       // dir tabs: is the terminal pane visible?
            splitWidth: 480,        // single-pane: terminal pane width (vertical split)
            splitHeight: 260,       // dual-pane: terminal pane height (horizontal split)
            // ── Dual pane (Midnight Commander style) (v1.4) ────────────
            // Pane A is the tab itself (its path/files/selection/etc.).
            // Pane B, when present, is a sibling pane object with the same
            // shape. activePaneId selects which one the toolbar + file
            // operations act on. For a non-dual tab, activePane() === tab,
            // so single-pane behaviour is unchanged.
            dual: false,
            paneB: null,
            activePaneId: 'a',
            gitInfo: null,
            gitChecked: false,
        };
        return tab;
    },

    // A pane is a directory view. Pane A is the tab; pane B is one of these.
    _buildPane(path) {
        return {
            kind: 'dir',
            paneId: Util.uid(),
            path: path || this.homePath,
            files: [],
            selection: [],
            sortColumn: 'name',
            sortDirection: 1,
            loading: false,
            loaded: false,
            error: null,
            errorRetryAsAdmin: false,
            listAdminPath: null,
            history: [path || this.homePath],
            historyIdx: 0,
            editingPath: false,
            lastClickedPath: null,
            search: { query: '', mode: 'name', recursive: false, caseInsensitive: false, regex: false, active: false },
            gitInfo: null,
            gitChecked: false,
        };
    },

    // ── Pane accessors ─────────────────────────────────────────────────
    paneList(tab) {
        return (tab && tab.dual && tab.paneB) ? [tab, tab.paneB] : [tab];
    },
    activePane(tab) {
        if (tab && tab.dual && tab.activePaneId === 'b' && tab.paneB) return tab.paneB;
        return tab;
    },
    currentPane() {
        const tab = this.activeTab();
        return tab ? this.activePane(tab) : null;
    },
    isActivePane(tab, pane) {
        return this.activePane(tab) === pane;
    },
    _activatePaneRef(tab, pane) {
        if (tab && tab.dual) tab.activePaneId = (pane === tab.paneB) ? 'b' : 'a';
    },

    toggleDualPane(tabRef) {
        // Re-acquire the reactive proxy from this.tabs so the mutations below
        // trigger Alpine re-render (raw refs don't — same lesson as elsewhere).
        const tab = (tabRef && this.tabs.find(t => t.id === tabRef.id)) || this.activeTab();
        if (!tab || tab.kind !== 'dir') return;
        if (tab.dual) {
            // Collapse back to single pane (keep pane A = the tab).
            tab.dual = false;
            tab.activePaneId = 'a';
            tab.paneB = null;
        } else {
            tab.paneB = this._buildPane(tab.path);
            tab.activePaneId = 'a';
            tab.dual = true;
            // Load pane B once its DOM exists.
            this.$nextTick(() => {
                const pane = tab.paneB;
                if (!pane) return;
                this._loadDir(pane);
                this._refreshTabGit(pane);
            });
        }
    },

    // Reorder a main tab to a new index (@alpinejs/sort handler:
    // id = the x-sort:item value, position = the item's new index).
    moveTab(id, position) {
        const from = this.tabs.findIndex(t => t.id === id);
        if (from < 0) return;
        const [t] = this.tabs.splice(from, 1);
        const pos = Math.max(0, Math.min(position, this.tabs.length));
        this.tabs.splice(pos, 0, t);
        this._persistTabs();
    },

    // Reorder a terminal/tmux sub-tab within its owning tab. Re-acquires the
    // reactive tab proxy from this.tabs so the splice triggers Alpine re-render.
    moveTerminal(tabRef, id, position) {
        const tab = (tabRef && this.tabs.find(t => t.id === tabRef.id)) || tabRef;
        if (!tab || !tab.terminals) return;
        const from = tab.terminals.findIndex(x => x.id === id);
        if (from < 0) return;
        const [term] = tab.terminals.splice(from, 1);
        const pos = Math.max(0, Math.min(position, tab.terminals.length));
        tab.terminals.splice(pos, 0, term);
        this._persistTabs();
    },

    newTab(path) {
        const raw = this._buildTab(path || this.homePath);
        this.tabs.push(raw);
        this.activeTabId = raw.id;
        // Re-acquire the reactive proxy (see comment in addTerminalToTab).
        const tab = this.tabs.find(t => t.id === raw.id);
        if (tab.kind === 'dir') this.$nextTick(() => this._loadDir(tab));
        return tab;
    },

    closeTab(id) {
        const idx = this.tabs.findIndex(t => t.id === id);
        if (idx < 0) return;
        const tab = this.tabs[idx];
        // Clean up streaming output channel
        if (tab.outputChannel) try { tab.outputChannel.close(); } catch(e){}
        // Clean up all terminals owned by this tab (v1.2)
        try { (tab.terminals || []).forEach(t => ExRT.term.del(t.id)); } catch(e){}
        this.tabs.splice(idx, 1);
        if (this.activeTabId === id) {
            this.activeTabId = this.tabs[Math.max(0, idx - 1)]?.id || null;
        }
        if (this.tabs.length === 0) this.newTab(this.homePath);
    },

    activateTab(id) {
        this.activeTabId = id;
        const tab = this.tabs.find(t => t.id === id);
        if (!tab) return;
        if (tab.kind === 'dir' && !tab.loaded && !tab.loading) this._loadDir(tab);
        // Safety: a terminal-kind tab with no shells inside (e.g. restored
        // from a buggy state, or addTerminalToTab silently failed earlier)
        // is useless. Spawn one so the user always sees a working shell.
        if (tab.kind === 'terminal' && (!tab.terminals || tab.terminals.length === 0)) {
            this.$nextTick(() => this.addTerminalToTab(tab, tab.path));
        } else if (tab.kind === 'terminal') {
            // Restored tmux tabs declare their terminals up front but can't
            // mount while hidden — mount them now the tab is visible.
            this._ensureTerminalsMounted(tab);
        }
        this._refreshTabGit(tab);
    },
    activeTab() { return this.tabs.find(t => t.id === this.activeTabId); },
    currentTab() { return this.activeTab(); },

    // Terminal tabs are either a stack of plain shells ('plain') or a group of
    // tmux sessions ('tmux'). termKind is the source of truth; fall back to
    // inferring it for tabs persisted before the field existed.
    termKindOf(tab) {
        if (!tab || tab.kind !== 'terminal') return '';
        if (tab.termKind) return tab.termKind;
        return (tab.tmux || (tab.terminals || []).some(t => t.tmux)) ? 'tmux' : 'plain';
    },

    tabLabel(tab) {
        if (tab.kind === 'output') return '▶ ' + (tab.outputActionLabel || 'output');
        if (tab.kind === 'terminal') {
            if (this.termKindOf(tab) === 'tmux') {
                const act = (tab.terminals || []).find(t => t.id === tab.activeTermId);
                return '⧉ ' + ((act && act.tmux) || 'tmux');
            }
            return '❯ Terminal';
        }
        if (tab.path === '/') return '/';
        return Util.basename(tab.path) || tab.path;
    },

    // Sub-tab label: tmux session name for tmux terminals, else the live cwd.
    termLabel(t) {
        if (!t) return '';
        return t.tmux ? ('⧉ ' + t.tmux) : ('❯ ' + this.shortenTermPath(t.dir));
    },

    // Front-truncate a path to fit a sub-tab, keeping whole trailing segments:
    //   /home/ismet/Videos  →  /home/ismet/Videos  (fits)
    //   /a/very/long/path/here → .../path/here
    shortenTermPath(p, max) {
        max = max || 26;
        if (!p) return '/';
        if (p.length <= max) return p;
        const segs = p.split('/').filter(Boolean);
        if (!segs.length) return p;
        let tail = segs[segs.length - 1];
        for (let i = segs.length - 2; i >= 0; i--) {
            const cand = segs[i] + '/' + tail;
            if (('.../' + cand).length > max) break;
            tail = cand;
        }
        return '.../' + tail;
    },
    isTermPathShortened(p) {
        return this.shortenTermPath(p) !== p;
    },

    duplicateTab(id) {
        const src = this.tabs.find(t => t.id === id);
        if (!src) return;
        const raw = this._buildTab(src.path, 'dir');
        this.tabs.splice(this.tabs.findIndex(t => t.id === id) + 1, 0, raw);
        this.activeTabId = raw.id;
        const tab = this.tabs.find(t => t.id === raw.id);
        this._loadDir(tab);
    },

    closeOtherTabs(id) {
        this.tabs.slice().forEach(t => { if (t.id !== id) this.closeTab(t.id); });
    },
    closeTabsLeft(id) {
        const idx = this.tabs.findIndex(t => t.id === id);
        this.tabs.slice(0, idx).reverse().forEach(t => this.closeTab(t.id));
    },
    closeTabsRight(id) {
        const idx = this.tabs.findIndex(t => t.id === id);
        this.tabs.slice(idx + 1).reverse().forEach(t => this.closeTab(t.id));
    },

    openTabMenu(ev, tabId) {
        this.ctxMenu = { open: true, x: ev.clientX, y: ev.clientY, kind: 'tab', target: null, tabId };
    },

    _persistTabs() {
        if (!this.settings.persistTabs) return;
        // Debounce — tabs change frequently (active switches, navigation, etc)
        if (this._persistTabsTimer) clearTimeout(this._persistTabsTimer);
        this._persistTabsTimer = setTimeout(async () => {
            const path = this.homePath + '/.config/cockpit/explorer/tabs.yml';
            try {
                const dirTabs = this.tabs.filter(t => t.kind === 'dir');
                const idx = Math.max(0, dirTabs.findIndex(t => t.id === this.activeTabId));
                // tmux terminal tabs (by session name) so they can be re-attached
                // and restored next launch, in tab order.
                // All tmux session names across the tmux container tab, in
                // sub-tab order, so the whole group is restored next launch.
                const tmuxTabs = Array.from(new Set(this.tabs
                    .filter(t => t.kind === 'terminal' && this.termKindOf(t) === 'tmux')
                    .flatMap(t => (t.terminals || []).filter(x => x.tmux).map(x => x.tmux))));
                const data = {
                    tabs: dirTabs.map(t => ({ path: t.path, kind: t.kind })),
                    activeIdx: idx,
                    tmuxTabs: tmuxTabs,
                    windows: this.windows.filter(w => w.path).map(w => ({ kind: w.kind, path: w.path })),
                    activeWinPath: (this.activeWin() && this.activeWin().path) || null,
                    hostVisible: !!this.hostVisible,
                };
                await FS.mkdir(Util.dirname(path));
                const yaml = window.jsyaml ? jsyaml.dump(data, { indent: 2 }) : JSON.stringify(data, null, 2);
                await FS.writeText(path, yaml);
            } catch (e) {}
        }, 400);
    },


    // Reopen the preview/editor windows that were open in the previous
    // session. Files are re-read fresh from disk (unsaved edits aren't kept,
    // same as closing). Missing files are skipped silently.
    async _restoreWindows(saved) {
        if (!saved) return;
        const list = Array.isArray(saved.windows) ? saved.windows : [];
        for (const it of list) {
            if (!it || !it.path) continue;
            try {
                const f = await FS.statOne(it.path);
                if (!f || f.type !== 'f') continue;
                if (it.kind === 'editor') await this.openEditor(f, { minimized: true });
                else await this.openPreview(f, { minimized: true });
            } catch (e) {}
        }
        if (!this.windows.length) return;
        // Choose the previously-active window (or the first) and show the host
        // only if it was visible last session.
        let target = saved.activeWinPath ? this.windows.find(w => w.path === saved.activeWinPath) : null;
        if (!target) target = this.windows[0];
        this.activeWinId = target.id;
        if (saved.hostVisible) this._showHost();
        else this.$nextTick(() => this._syncActiveEditor());
    },


    // ───── Navigation ────────────────────────────────────────────────────────
    async _loadDir(tab, opts) {
        if (tab.kind !== 'dir') return;
        // Render the git bar instantly from the repo cache (no subprocess),
        // before the directory listing (or the authoritative git status
        // kicked off by navigate()) resolves. Covers every path that loads a
        // directory — navigate, back/forward, new/duplicate tab, tab
        // activation, dual-pane — from one place; see _prefillGitFromCache's
        // own comment for why it's safe to call unconditionally here.
        this._prefillGitFromCache(tab);
        opts = opts || {};
        // Admin listing sticks to the path it was granted for, so reloads and
        // post-save refreshes of the same directory don't drop back to a
        // normal-user listing (and re-show the "Retry as administrator" banner).
        const admin = (opts.admin !== undefined) ? opts.admin : (tab.listAdminPath === tab.path);
        tab.loading = true;
        tab.error = null;
        tab.errorRetryAsAdmin = false;
        try {
            let files = await FS.listDir(tab.path, { admin });
            if (!this.settings.showHidden) files = files.filter(f => !f.name.startsWith('.'));
            tab.files = files;
            // Prune selection to items still present
            const visible = new Set(files.map(f => f.path));
            tab.selection = tab.selection.filter(p => visible.has(p));
            tab.loaded = true;
            if (admin) tab.listAdminPath = tab.path;
            else if (tab.listAdminPath === tab.path) tab.listAdminPath = null;
        } catch (e) {
            tab.error = e.message || 'Failed to read directory';
            tab.errorRetryAsAdmin = e.permissionDenied || !admin;
            tab.files = [];
        } finally {
            tab.loading = false;
        }
    },

    async navigate(tab, path, opts) {
        opts = opts || {};
        path = Util.normalizePath(path);
        // Symlink resolution if needed
        if (this.settings.followSymlinks) {
            try {
                const resolved = await FS.readlinkResolved(path);
                if (resolved) path = resolved;
            } catch (e) {}
        }
        tab.path = path;
        tab.selection = [];
        tab.search.active = false;
        // history
        tab.history = tab.history.slice(0, tab.historyIdx + 1);
        if (tab.history[tab.history.length - 1] !== path) tab.history.push(path);
        tab.historyIdx = tab.history.length - 1;
        // Authoritative reconcile, fired now (not awaited) so it runs
        // alongside the directory listing rather than gating navigate() on
        // it. This is what turns the optimistic cache-based bar — rendered
        // synchronously by _prefillGitFromCache inside _loadDir below — into
        // the real status within moments, and is also what self-corrects a
        // stale/moved cached repo instead of leaving a false bar up until
        // the next 8s poll tick.
        this._refreshTabGit(tab);
        await this._loadDir(tab, opts);
    },

    goBack(tab) {
        if (tab.historyIdx <= 0) return;
        tab.historyIdx--;
        tab.path = tab.history[tab.historyIdx];
        tab.selection = [];
        this._loadDir(tab);
    },
    goForward(tab) {
        if (tab.historyIdx >= tab.history.length - 1) return;
        tab.historyIdx++;
        tab.path = tab.history[tab.historyIdx];
        tab.selection = [];
        this._loadDir(tab);
    },
    goUp(tab) { this.navigate(tab, Util.dirname(tab.path)); },
    goHome(tab) { this.navigate(tab, this.homePath); },
    reload(tab, opts) { return this._loadDir(tab, opts); },

    pathSegments(p) { return Util.pathSegments(p); },


};
