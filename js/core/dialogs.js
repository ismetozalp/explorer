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

    // When a modal opens, put the cursor in its first field IF that field is a
    // text input or textarea — so users can type immediately without clicking.
    // Wired to the global `shown.bs.modal` event (bootstrap fires it once the
    // modal is actually visible; an x-init/autofocus at page-load time can't
    // focus a hidden element). The decision is based on the FIRST visible
    // control in the modal body: if it's a checkbox/select/button (e.g. the
    // Settings modal) nothing is focused. Editor widgets (Monaco/Quill/xterm)
    // manage their own focus and are skipped. Covers the interactive Script
    // Prompt Protocol too, since it prompts via askPrompt → #promptModal.
    _focusFirstField(root) {
        if (!root) return;
        const scope = root.querySelector('.modal-body') || root;
        const isText = (el) => {
            const tag = el.tagName.toLowerCase();
            if (tag === 'textarea') return true;
            if (tag !== 'input') return false;
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            return ['text', 'search', 'url', 'email', 'password', 'number', 'tel', ''].includes(type);
        };
        // Visible and not inside an editor widget that manages its own focus
        // (Monaco, xterm, and Quill's toolbar/tooltip — the latter live as
        // siblings of .ql-container, so list them explicitly).
        const usable = (el) => el.getClientRects().length > 0
            && !el.disabled && !el.readOnly
            && !el.closest('.monaco-editor, .ql-container, .ql-toolbar, .ql-tooltip, .xterm');
        const focus = (el) => {
            try {
                el.focus();
                // Cursor to the end so a prefilled default can be edited/appended.
                const v = el.value;
                if (typeof v === 'string' && el.setSelectionRange) {
                    try { el.setSelectionRange(v.length, v.length); } catch (e) {}
                }
            } catch (e) {}
        };
        // 1) Explicit opt-in wins, in DOM order, regardless of preceding
        //    controls — for modals whose primary field is preceded by other
        //    chrome (e.g. Run-command's textarea after a shell <select>, the
        //    dir-picker path input after an "up" button, the GitHub token input).
        for (const el of scope.querySelectorAll('[autofocus]')) {
            if (usable(el) && isText(el)) { focus(el); return; }
        }
        // 2) Otherwise: if the FIRST visible control is a text input/textarea,
        //    focus it. If it's a checkbox/select/button (e.g. Settings), do
        //    nothing — never reach past it into the middle of a form.
        for (const el of scope.querySelectorAll('input, textarea, select, button')) {
            if (el.getClientRects().length === 0
                || el.closest('.monaco-editor, .ql-container, .ql-toolbar, .ql-tooltip, .xterm')) continue;
            if (isText(el) && !el.disabled && !el.readOnly) focus(el);
            return;  // decide from the first visible control, whatever it is
        }
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
