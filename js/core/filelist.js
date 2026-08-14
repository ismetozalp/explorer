// File list — selection, sorting/display, context menu, search. Core,
// extracted from app.js (2.0 modularization). Methods only; list state stays in app.js.
window.ExplorerFileList = {
    onRowClick(ev, tab, file) {
        if (ev.shiftKey && tab.lastClickedPath) {
            const sorted = this.sortedFiles(tab);
            const idxA = sorted.findIndex(f => f.path === tab.lastClickedPath);
            const idxB = sorted.findIndex(f => f.path === file.path);
            if (idxA >= 0 && idxB >= 0) {
                const [lo, hi] = [Math.min(idxA, idxB), Math.max(idxA, idxB)];
                tab.selection = sorted.slice(lo, hi + 1).map(f => f.path);
                return;
            }
        }
        if (ev.ctrlKey || ev.metaKey) {
            this.toggleSelect(tab, file);
        } else {
            tab.selection = [file.path];
        }
        tab.lastClickedPath = file.path;
    },

    toggleSelect(tab, file) {
        const idx = tab.selection.indexOf(file.path);
        if (idx >= 0) tab.selection.splice(idx, 1);
        else tab.selection.push(file.path);
        tab.lastClickedPath = file.path;
    },

    toggleSelectAll(tab, checked) {
        tab.selection = checked ? this.sortedFiles(tab).map(f => f.path) : [];
    },

    clearSelection(tab) {
        if (tab) tab.selection = [];
        else if (this.currentPane()) this.currentPane().selection = [];
    },

    selectedFiles(tab) {
        tab = tab || this.currentPane();
        if (!tab) return [];
        const m = new Map(tab.files.map(f => [f.path, f]));
        return tab.selection.map(p => m.get(p)).filter(Boolean);
    },

    selectionSummary(tab) {
        const sel = this.selectedFiles(tab);
        const total = sel.reduce((s, f) => s + (f.type === 'f' ? f.size : 0), 0);
        return `${sel.length} selected · ${Util.humanSize(total)}`;
    },

    statusText(tab) {
        if (tab.kind !== 'dir') return tab.outputStatus || '';
        if (tab.loading) return 'Loading…';
        const dirs = tab.files.filter(f => f.type === 'd').length;
        const files = tab.files.length - dirs;
        return `${tab.files.length} item(s) · ${dirs} folder(s) · ${files} file(s)`;
    },


    // ───── Sorting & display helpers ────────────────────────────────────────
    visibleColumnCount() {
        const c = this.settings.columns;
        // 3 = col-check + col-name + col-menu (all always visible).
        return 3 + (c.size ? 1 : 0) + (c.modified ? 1 : 0) + (c.perms ? 1 : 0) + (c.owner ? 1 : 0) + (c.type ? 1 : 0);
    },

    setSort(tab, col) {
        if (tab.sortColumn === col) tab.sortDirection = -tab.sortDirection;
        else { tab.sortColumn = col; tab.sortDirection = 1; }
    },

    sortIndicator(tab, col) {
        if (tab.sortColumn !== col) return '';
        return tab.sortDirection > 0 ? '▲' : '▼';
    },

    sortedFiles(tab) {
        const col = tab.sortColumn;
        const dir = tab.sortDirection;
        const items = tab.files.slice();
        items.sort((a, b) => {
            // Always sort directories before files (unless explicit type column)
            if (a.type === 'd' && b.type !== 'd') return -1;
            if (a.type !== 'd' && b.type === 'd') return 1;
            let av = a[col], bv = b[col];
            if (col === 'name') { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); }
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
        return items;
    },

    humanSize: Util.humanSize,
    formatDate: Util.formatDate,
    fileIcon: Util.fileIcon,
    typeLabel: Util.typeLabel,
    isTextLike: Util.isTextLike,
    isArchive: Util.isArchive,
    // Single source of truth (js/utils.js) — a local copy here went stale and
    // left .md/.docx/.xlsx un-previewable from the Space shortcut even though
    // double-click opened them.
    isPreviewable: Util.isPreviewable,


    // ───── Context menu ──────────────────────────────────────────────────────
    closeContextMenu() { this.ctxMenu.open = false; },

    openContextMenu(ev, pane, file) {
        const tab = this.activeTab();
        this._activatePaneRef(tab, pane);
        this.ctxMenu = { open: true, x: ev.clientX, y: ev.clientY, kind: 'empty', target: null, tabId: tab ? tab.id : null, flyLeft: false };
        this._clampCtxMenu();
    },

    onRowContextMenu(ev, pane, file) {
        const tab = this.activeTab();
        this._activatePaneRef(tab, pane);
        // If the row isn't in current selection, select just it.
        if (!pane.selection.includes(file.path)) pane.selection = [file.path];
        let x = ev.clientX, y = ev.clientY;
        // Keyboard-activating the ⋮ button (Enter/Space) fires a click with
        // clientX/clientY = 0 — anchor the menu to the button, not the corner.
        if (!x && !y && ev.currentTarget && ev.currentTarget.getBoundingClientRect) {
            const r = ev.currentTarget.getBoundingClientRect();
            x = Math.round(r.left); y = Math.round(r.bottom);
        }
        this.ctxMenu = { open: true, x, y, kind: 'file', target: file, tabId: tab ? tab.id : null, flyLeft: false };
        this._clampCtxMenu();
    },

    _clampCtxMenu() {
        this.$nextTick(() => {
            const m = document.querySelector('.context-menu');
            if (!m) return;
            const r = m.getBoundingClientRect();
            const vw = window.innerWidth, vh = window.innerHeight;
            if (r.right > vw) this.ctxMenu.x = Math.max(0, vw - r.width - 4);
            if (r.bottom > vh) this.ctxMenu.y = Math.max(0, vh - r.height - 4);
            // Open submenu flyouts to the left when there isn't room on the right.
            const FLYOUT_W = 240;
            this.ctxMenu.flyLeft = (Math.min(r.right, vw) + FLYOUT_W) > vw;
        });
    },


    // ───── Search ────────────────────────────────────────────────────────────
    async runSearch(tab) {
        const q = tab.search.query.trim();
        if (!q) { this.clearSearch(tab); return; }

        // Build a JS regex up front if regex mode is on, so we can report a
        // bad pattern before spawning anything. The "case-insensitive" option
        // maps to the regex 'i' flag, so the two work together consistently.
        let rx = null;
        if (tab.search.regex) {
            try {
                rx = new RegExp(q, tab.search.caseInsensitive ? 'i' : '');
            } catch (e) {
                tab.error = 'Invalid regular expression: ' + (e.message || e);
                tab.errorRetryAsAdmin = false;
                return;
            }
        }

        tab.loading = true;
        tab.error = null;
        try {
            let results;
            if (tab.search.mode === 'content') {
                // grep does the regex itself: -E for extended regex, -F for
                // a literal string. -i for case-insensitive either way.
                results = await FS.searchContent(
                    tab.path, q, tab.search.recursive,
                    tab.search.caseInsensitive, tab.search.regex);
            } else {
                // Filename: list candidates, match in JS so regex + case
                // semantics are exactly JS RegExp's.
                const all = await FS.listForSearch(tab.path, tab.search.recursive);
                if (rx) {
                    results = all.filter(f => rx.test(f.name));
                } else if (tab.search.caseInsensitive) {
                    const needle = q.toLowerCase();
                    results = all.filter(f => f.name.toLowerCase().includes(needle));
                } else {
                    results = all.filter(f => f.name.includes(q));
                }
            }
            if (!this.settings.showHidden) results = results.filter(f => !f.name.startsWith('.'));
            tab.files = results;
            tab.selection = [];
            tab.search.active = true;
        } catch (e) {
            tab.error = e.message || 'Search failed';
        } finally {
            tab.loading = false;
        }
    },

    clearSearch(tab) {
        tab.search.active = false;
        tab.search.query = '';
        this._loadDir(tab);
    },


};
