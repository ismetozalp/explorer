// Settings (load/save/apply) and the global keyboard router (onKey). Core,
// extracted from app.js (2.0 modularization). Methods only; settings state stays in app.js.
window.ExplorerSettings = {
    _settingsPath() { return this.homePath + '/.config/cockpit/explorer/settings.yml'; },

    async _loadSettings() {
        const path = this._settingsPath();
        let loaded = null;
        try {
            const txt = await FS.readText(path);
            if (txt && window.jsyaml) {
                loaded = jsyaml.load(txt);
            }
        } catch (e) {}

        // Fallback migration from old localStorage settings (if any)
        if (!loaded) {
            try {
                const raw = localStorage.getItem(ExRT.const.LS_KEY_SETTINGS);
                if (raw) {
                    loaded = JSON.parse(raw);
                    // Best-effort migrate to YAML on disk
                    await this._writeSettingsYaml(loaded);
                    try { localStorage.removeItem(ExRT.const.LS_KEY_SETTINGS); } catch (e) {}
                }
            } catch (e) {}
        }

        if (loaded && typeof loaded === 'object') {
            // Deep-merge over defaults so new fields don't disappear
            Object.assign(this.settings, loaded);
            // columns is a nested object — merge defaults under it
            this.settings.columns = Object.assign({}, ExRT.const.DEFAULT_SETTINGS.columns, loaded.columns || {});
        }
        if (!this.settings.columns) this.settings.columns = structuredClone(ExRT.const.DEFAULT_SETTINGS.columns);

        // Apply theme & track system-preference changes if 'system' mode
        this.applyTheme();
        try {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            mq.addEventListener('change', () => {
                if ((this.settings.theme || 'system') === 'system') this.applyTheme();
            });
        } catch (e) {}
    },

    applyTheme() {
        const t = this.settings.theme || 'system';
        const dark = t === 'dark'
            || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
        if (window.monaco && window.monaco.editor) {
            try { window.monaco.editor.setTheme(dark ? 'vs-dark' : 'vs'); } catch (e) {}
        }
    },

    async _writeSettingsYaml(settings) {
        const path = this._settingsPath();
        try {
            await FS.mkdir(Util.dirname(path));
            const yaml = window.jsyaml ? jsyaml.dump(settings, { indent: 2, lineWidth: 100 })
                                       : JSON.stringify(settings, null, 2);
            await FS.writeText(path, yaml);
        } catch (e) {
            this.toast('Could not save settings: ' + (e.message || e), 'danger');
        }
    },

    openSettings() { bootstrap.Modal.getOrCreateInstance(this.settingsModalEl).show(); },

    saveSettings() {
        if (this._suppressSettingsSave) return;   // self-update is wiping the settings file
        // Debounce: collapse multiple rapid changes into one write
        if (this._saveSettingsTimer) clearTimeout(this._saveSettingsTimer);
        this._saveSettingsTimer = setTimeout(() => {
            this._writeSettingsYaml(this.settings);
        }, 400);
    },


    // ───── Shells (/etc/shells) ──────────────────────────────────────────────

    // Turn the raw text of /etc/shells into the list Explorer offers. Pure, so
    // the part with the edge cases is testable away from _initExtensions()'s
    // I/O — see tests/shells-unit.mjs.
    //
    // De-duplication is load-bearing, not tidiness: the list is rendered by an
    // x-for keyed on the shell path (html/modals/toolbar.html), and `:key` must
    // be unique within an x-for. A repeated line in /etc/shells — package
    // installs and hand edits both produce them — gave Alpine two identical
    // keys, and its keyed diff then worked from a stale node reference and
    // threw `Cannot read properties of undefined (reading 'after')`. Since this
    // runs during init, the throw took the whole component with it and Cockpit
    // rendered "Ooops!" instead of the file manager (issue #1).
    //
    // tmux is dropped even when listed: it is driven by the dedicated session
    // manager (toolbar button), never offered as a "default shell".
    //
    // `fallback` (the caller's current list) is returned, normalised the same
    // way, when the file is unreadable, empty, comments-only, or tmux-only —
    // never an empty list, because this.shells[0] is a real code path
    // (js/core/output.js).
    _parseShells(txt, fallback) {
        const norm = (lines) => [...new Set(
            lines.map(s => String(s).trim()).filter(s => s && !s.startsWith('#'))
        )].filter(s => s.replace(/.*\//, '') !== 'tmux');
        const shells = norm(String(txt == null ? '' : txt).split('\n'));
        return shells.length ? shells : norm(fallback || []);
    },

    // Keep the configured default shell if the host still offers it; otherwise
    // prefer bash, then whatever is first. Pure — see tests/shells-unit.mjs.
    _pickDefaultShell(shells, current) {
        if (current && shells.includes(current)) return current;
        return shells.find(s => s.endsWith('/bash')) || shells[0] || '';
    },


    // ───── Keyboard ──────────────────────────────────────────────────────────
    onKey(ev) {
        // Don't intercept when typing in inputs
        const tag = (ev.target.tagName || '').toLowerCase();
        const inField = (tag === 'input' || tag === 'textarea' || ev.target.isContentEditable);
        const tab = this.activeTab();
        const pane = this.currentPane();
        const ctrl = ev.ctrlKey || ev.metaKey;

        if (ctrl && ev.key.toLowerCase() === 't') { ev.preventDefault(); this.newTab(pane ? pane.path : this.homePath); return; }
        if (ctrl && ev.key.toLowerCase() === 'w') { ev.preventDefault(); if (tab) this.closeTab(tab.id); return; }

        // Escape closes the top-most open popup. The editor/preview window and
        // the folder picker set Bootstrap's keyboard:false (so a native Esc
        // can't bypass the unsaved-changes prompt / forced choice), so we close
        // them here through the same paths that guard unsaved edits. This runs
        // BEFORE the inField guard below so it still fires while the Monaco
        // editor (a focused textarea) has focus. Every other modal keeps
        // Bootstrap's own Esc-to-close, so we only special-case these two.
        if (ev.key === 'Escape') {
            const shown = [...document.querySelectorAll('.modal.show')];
            const top = shown.length ? shown.reduce((a, b) =>
                (parseInt(getComputedStyle(b).zIndex) || 0) >= (parseInt(getComputedStyle(a).zIndex) || 0) ? b : a) : null;
            if (top === this.windowHostEl && this.activeWinId) { ev.preventDefault(); this.closeActiveWindow(); return; }
            if (top === this.dirPickerEl && this.dirPicker.open) { ev.preventDefault(); this._dpCancel(); return; }
        }

        // Preview ◀/▶ with arrow keys when a preview window is focused. Plain
        // arrows only — Alt+←/→ must keep reaching goBack/goForward below.
        if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')
            && !ev.altKey && !ev.ctrlKey && !ev.metaKey
            && this.hostVisible && this.activeWin() && this.activeWin().kind === 'preview' && this.activeWin().nav) {
            const t = ev.target;
            const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
            if (!typing) { ev.preventDefault(); this.previewStep(this.activeWin().id, ev.key === 'ArrowRight' ? 1 : -1); return; }
        }

        if (inField) return;

        if (ev.key === 'F5') { ev.preventDefault(); if (pane) this.reload(pane); return; }
        if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); if (pane) this.goBack(pane); return; }
        if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); if (pane) this.goForward(pane); return; }
        if (ev.altKey && ev.key === 'ArrowUp') { ev.preventDefault(); if (pane) this.goUp(pane); return; }
        // Tab / Ctrl-Tab moves focus between panes in dual mode
        if (ev.key === 'Tab' && tab && tab.dual) {
            ev.preventDefault();
            tab.activePaneId = tab.activePaneId === 'b' ? 'a' : 'b';
            return;
        }

        if (ev.key === ' ' && pane && pane.kind === 'dir') {
            const sel = this.selectedFiles(pane);
            // siblings: same as the double-click path (js/core/fileops.js), so a
            // Space-opened preview also gets the ◀/▶ folder navigation.
            if (sel.length === 1 && this.isPreviewable(sel[0])) { ev.preventDefault(); this.openPreview(sel[0], { siblings: pane.files || [] }); }
            return;
        }
        if (ev.key === 'F2' && tab) { ev.preventDefault(); this.renameSelected(); return; }
        if (ev.key === 'Delete' && tab) { ev.preventDefault(); this.deleteSelected(); return; }
        if (ev.key === 'Enter' && pane) {
            const sel = this.selectedFiles(pane);
            if (sel.length === 1) { ev.preventDefault(); this.openFile(pane, sel[0]); }
            return;
        }
        // Only stage files for Copy/Cut when the user isn't selecting text. A
        // live text selection (e.g. in a file Preview's <pre>, which is not a
        // form field so `inField` above is false) must fall through to the
        // browser's native copy — otherwise Ctrl/⌘+C is hijacked into file-copy
        // and selected text can never be copied. Normal file browsing keeps
        // file names unselectable (user-select:none), so this stays empty then.
        const hasTextSelection = !!(window.getSelection && String(window.getSelection()).trim());
        if (ctrl && ev.key.toLowerCase() === 'c' && tab && !hasTextSelection) { ev.preventDefault(); this.copyToClipboard('copy'); return; }
        if (ctrl && ev.key.toLowerCase() === 'x' && tab && !hasTextSelection) { ev.preventDefault(); this.copyToClipboard('cut'); return; }
        if (ctrl && ev.key.toLowerCase() === 'v' && tab) { ev.preventDefault(); this.paste(); return; }
        if (ctrl && ev.key.toLowerCase() === 'a' && pane) {
            ev.preventDefault();
            pane.selection = this.sortedFiles(pane).map(f => f.path);
            return;
        }
        if (ctrl && ev.key.toLowerCase() === 'f' && tab) {
            ev.preventDefault();
            const inp = document.querySelector('.tab-pane:not([style*="display: none"]) .search-box input');
            if (inp) inp.focus();
            return;
        }
        if (ev.key === 'Escape' && this.ctxMenu.open) { this.closeContextMenu(); return; }
    },

    // ═════════════════════════════════════════════════════════════════════════
    // ═══════════════ RUN COMMAND & GITHUB INTEGRATION ════════════════════════
    // ═════════════════════════════════════════════════════════════════════════

};
