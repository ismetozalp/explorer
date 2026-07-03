// Dialogs (confirm/prompt/choice), the directory picker, and toasts. Core,
// extracted from app.js (2.0 modularization). Methods only; dialog state stays in app.js.
window.ExplorerDialogs = {
    askConfirm(title, message, confirmLabel) {
        return new Promise(resolve => {
            this.confirmDlg = { title, message, confirmLabel: confirmLabel || 'OK', cancelLabel: 'Cancel', buttons: null, result: undefined, resolve };
            bootstrap.Modal.getOrCreateInstance(this.confirmModalEl).show();
        });
    },

    // Multi-button choice dialog. buttons: [{ id, label, variant }].
    // Resolves with the chosen id, or null if dismissed.
    askChoice(title, message, buttons) {
        return new Promise(resolve => {
            this.confirmDlg = { title, message, confirmLabel: 'OK', cancelLabel: 'Cancel', buttons: buttons || null, result: undefined, resolve };
            bootstrap.Modal.getOrCreateInstance(this.confirmModalEl).show();
        });
    },

    // Record the choice and start hiding. The promise is resolved by the
    // modal's 'hidden.bs.modal' handler so the NEXT dialog (which reuses this
    // same modal element) only opens after this one is fully closed —
    // otherwise Bootstrap's show/hide animations race and the second dialog
    // silently fails to appear.
    resolveConfirm(value) {
        if (!this.confirmDlg.resolve) return;
        this.confirmDlg.result = value;
        bootstrap.Modal.getOrCreateInstance(this.confirmModalEl).hide();
    },

    askPrompt(title, label, defaultValue, opts) {
        opts = opts || {};
        return new Promise(resolve => {
            this.promptDlg = { title, label, value: defaultValue || '', multiline: !!opts.multiline, resolve };
            bootstrap.Modal.getOrCreateInstance(this.promptModalEl).show();
        });
    },

    resolvePrompt(value) {
        const r = this.promptDlg.resolve;
        this.promptDlg.resolve = null;
        bootstrap.Modal.getOrCreateInstance(this.promptModalEl).hide();
        if (r) r(value);
    },

    // ───── Directory picker ────────────────────────────────────────────────
    // Returns a Promise<string|null> resolving to the chosen directory path.
    askDirectory(title, startPath) {
        return new Promise(resolve => {
            this.dirPicker = { open: true, title: title || 'Select a folder', path: '', entries: [], loading: true, resolve, pathInput: '' };
            bootstrap.Modal.getOrCreateInstance(this.dirPickerEl).show();
            this._dpLoad(startPath || this.homePath);
        });
    },
    async _dpLoad(path) {
        this.dirPicker.loading = true;
        this.dirPicker.path = path;
        this.dirPicker.pathInput = path;
        try {
            const list = await FS.listDir(path);
            this.dirPicker.entries = list
                .filter(e => e.type === 'd' || e.type === 'l')
                .filter(e => this.settings.showHidden || !e.name.startsWith('.'))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch (e) {
            this.toast('Cannot open ' + path + ': ' + (e.message || e), 'danger');
            this.dirPicker.entries = [];
        } finally {
            this.dirPicker.loading = false;
        }
    },
    _dpUp() {
        const parent = Util.dirname(this.dirPicker.path);
        if (parent && parent !== this.dirPicker.path) this._dpLoad(parent);
    },
    _dpEnter(entry) { this._dpLoad(entry.path); },
    _dpGoTo() { if (this.dirPicker.pathInput) this._dpLoad(this.dirPicker.pathInput); },
    async _dpNewFolder() {
        const name = await this.askPrompt('New folder', 'Folder name (created inside ' + this.dirPicker.path + ')', 'new-folder');
        if (!name) return;
        const np = Util.joinPath(this.dirPicker.path, name);
        try { await FS.mkdir(np); this._dpLoad(np); }
        catch (e) { this.toast('mkdir failed: ' + (e.message || e), 'danger'); }
    },
    _dpChoose() {
        const r = this.dirPicker.resolve;
        const chosen = this.dirPicker.pathInput || this.dirPicker.path;
        this.dirPicker.resolve = null;
        this.dirPicker.open = false;
        bootstrap.Modal.getOrCreateInstance(this.dirPickerEl).hide();
        if (r) r(chosen);
    },
    _dpCancel() {
        const r = this.dirPicker.resolve;
        this.dirPicker.resolve = null;
        this.dirPicker.open = false;
        bootstrap.Modal.getOrCreateInstance(this.dirPickerEl).hide();
        if (r) r(null);
    },

    // ───── Toasts ────────────────────────────────────────────────────────────
    toast(message, kind) {
        const id = Util.uid();
        this.toasts.push({ id, message, kind: kind || 'secondary' });
        setTimeout(() => this.dismissToast(id), 4000);
    },

    dismissToast(id) {
        const idx = this.toasts.findIndex(t => t.id === id);
        if (idx >= 0) this.toasts.splice(idx, 1);
    },


};
