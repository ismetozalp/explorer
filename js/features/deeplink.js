// Deep-link entry point — a sibling Cockpit plugin (ctop) navigates the shell
// with cockpit.jump("/explorer#open=" + encodeURIComponent(absPath)); Explorer
// reads the open= hash param on startup and on every hashchange, opens the
// directory (or a file's parent + selects it), then clears the param.
window.ExplorerDeepLink = {
    // Robust scan: hash may be "open=%2F..." or "/?open=..." or carry other params.
    _openParamFromHash() {
        try {
            const h = (window.location.hash || '').replace(/^#/, '');
            const m = h.match(/(?:^|[#/?&])open=([^&]+)/);
            return m ? decodeURIComponent(m[1]) : null;
        } catch (e) { return null; }
    },

    // Remove ONLY the open= key; leave any other hash content intact.
    // replaceState does NOT fire hashchange, so this cannot re-enter.
    _clearOpenHash() {
        try {
            const h = (window.location.hash || '').replace(/^#/, '');
            const rest = h.replace(/(?:^|[#/?&])open=[^&]+/, '').replace(/^[#/?&]+/, '');
            const url = window.location.pathname + window.location.search + (rest ? '#' + rest : '');
            window.history.replaceState(null, '', url);
        } catch (e) { /* ignore */ }
    },

    _initDeepLink() {
        window.addEventListener('hashchange', () => this._handleDeepLink());
    },

    async _handleDeepLink() {
        if (this._openInFlight) return;                 // re-entrancy guard
        const raw = this._openParamFromHash();
        if (!raw) return;
        this._openInFlight = true;
        this._clearOpenHash();                          // clear BEFORE await -> dedupes double-fire
        try {
            const path = Util.normalizePath(raw);
            let st = await FS.statOne(path);
            let target = path;
            if (st && st.type === 'l') {                // symlink -> resolve to its target
                const real = await FS.readlinkResolved(path);
                if (real) { target = real; st = await FS.statOne(real); }
            }
            if (!st) { this.toast('Path not accessible: ' + path, 'danger'); return; }
            if (st.type === 'd') {
                this.newTab(target);                    // always a new focused tab; loads dir
            } else {
                await this._openParentAndSelect(target);
            }
        } catch (e) {
            this.toast('Could not open path: ' + raw, 'danger');
        } finally {
            this._openInFlight = false;
        }
    },

    // Open the parent dir in a new focused tab, load it, then select + scroll to the file.
    async _openParentAndSelect(filePath) {
        const parent = Util.dirname(filePath);
        const raw = this._buildTab(parent, 'dir');
        this.tabs.push(raw);
        this.activeTabId = raw.id;
        const tab = this.tabs.find(t => t.id === raw.id);   // reactive proxy (raw refs don't trigger Alpine re-render)
        this._refreshTabGit(tab);                        // authoritative reconcile — see newTab() in js/core/tabs.js
        await this._loadDir(tab);                       // single awaited load (not newTab's $nextTick load)
        tab.selection = [filePath];
        this.$nextTick(() => this._scrollToPath(filePath));
    },

    _scrollToPath(path) {
        try {
            const sel = (window.CSS && CSS.escape) ? CSS.escape(path) : path;
            const el = document.querySelector('tr[data-path="' + sel + '"]');
            if (el) el.scrollIntoView({ block: 'center' });
        } catch (e) { /* ignore */ }
    },
};
