// Custom actions (form/JSON editing, Monaco actions editor, global toolbar
// actions) and the interactive Script Prompt Protocol. Extracted from app.js
// (2.0 modularization). Methods only; customActions/actionsMgr state stays in app.js.
window.ExplorerActions = {
    _normalizeAction(a) {
        return {
            id: a.id || Util.uid(),
            label: a.label || '',
            command: a.command || '',
            appliesTo: a.appliesTo || '',
            pattern: a.pattern || '',
            output: a.output || 'toast',
            privilege: a.privilege || 'user',
            confirm: !!a.confirm,
            confirmMessage: a.confirmMessage || '',
            preCommand: a.preCommand || '',
            preConfirm: a.preConfirm || '',
            preConfirmLabel: a.preConfirmLabel || '',
            postCommand: a.postCommand || '',
            postConfirm: a.postConfirm || '',
            postConfirmLabel: a.postConfirmLabel || '',
            interactive: !!a.interactive,
            script: a.script || '',
            requiresGh: !!a.requiresGh,
            multi: a.multi !== false,
        };
    },

    async _loadCustomActions(scope) {
        const path = scope === 'user'
            ? this.homePath + ExRT.const.USER_ACTIONS_PATH_SUFFIX
            : ExRT.const.SYSTEM_ACTIONS_PATH;
        try {
            const txt = await FS.readText(path);
            if (txt) {
                const data = JSON.parse(txt);
                if (Array.isArray(data.actions)) {
                    this.customActions[scope] = data.actions.map(a => this._normalizeAction(a));
                }
            }
        } catch (e) {
            // File doesn't exist yet — that's fine
        }
        this.actionsMgr.loaded[scope] = true;
    },

    // Built-in actions ship with the plugin (e.g. the self-update action) and
    // are always current with the installed version. They're loaded from the
    // package dir, NOT the editable /etc file, so updating the plugin updates
    // them and they can't be clobbered or fall out of date.
    async _loadBuiltinActions() {
        let txt = '';
        try {
            const r = await fetch('actions/system-actions.json', { cache: 'no-store' });
            if (r.ok) txt = await r.text();
        } catch (e) {}
        if (!txt) {
            try { txt = await FS.readText('/usr/share/cockpit/explorer/actions/system-actions.json'); } catch (e) {}
        }
        if (!txt) return;
        try {
            const data = JSON.parse(txt);
            const list = Array.isArray(data) ? data : (data && Array.isArray(data.actions) ? data.actions : []);
            this.customActions.builtin = list.map(a => this._normalizeAction(a));
        } catch (e) {
            console.warn('[explorer] could not parse built-in actions:', e);
        }
    },

    // Re-read every custom-action source (user + system + built-in) from disk,
    // so edits made to the actions.json files show up without a page reload.
    async reloadActions() {
        await Promise.all([
            this._loadCustomActions('user'),
            this._loadCustomActions('system'),
            this._loadBuiltinActions(),
        ]);
        // The selected index may now point past the end of a shrunk list.
        this.actionsMgr.editingIdx = null;
        this.toast('Custom actions reloaded from disk', 'success');
    },

    // Upload a local shell script into the current scope's scripts/ folder and
    // wire the action to run it interactively (bash {script}).
    async uploadActionScript(ev) {
        const file = ev && ev.target && ev.target.files && ev.target.files[0];
        if (!file) return;
        const scope = this.actionsMgr.scope;
        const a = this.customActions[scope][this.actionsMgr.editingIdx];
        if (!a) { ev.target.value = ''; return; }
        let text;
        try { text = await file.text(); }
        catch (e) { this.toast('Could not read ' + file.name + ': ' + (e.message || e), 'danger'); ev.target.value = ''; return; }
        const dir = this._scriptsDir(scope);
        const dest = Util.joinPath(dir, file.name);
        try {
            await FS.mkdir(dir, { adminTry: scope === 'system' });
            await FS.writeText(dest, text, { adminTry: scope === 'system' });
        } catch (e) { this.toast('Upload failed: ' + (e.message || e), 'danger'); ev.target.value = ''; return; }
        a.script = file.name;
        a.interactive = true;
        if (!a.command || !a.command.trim()) a.command = 'bash {script}';
        if (a.output === 'toast') a.output = 'pane';
        this.toast('Uploaded ' + file.name + ' → ' + dir);
        ev.target.value = '';
    },

    // Upload a local shell script into the current scope's scripts/ folder and
    // wire the action to run it interactively (bash {script}).
    async uploadActionScript(ev) {
        const file = ev && ev.target && ev.target.files && ev.target.files[0];
        if (!file) return;
        const scope = this.actionsMgr.scope;
        const a = this.customActions[scope][this.actionsMgr.editingIdx];
        if (!a) { ev.target.value = ''; return; }
        let text;
        try { text = await file.text(); }
        catch (e) { this.toast('Could not read ' + file.name + ': ' + (e.message || e), 'danger'); ev.target.value = ''; return; }
        const dir = this._scriptsDir(scope);
        const dest = Util.joinPath(dir, file.name);
        try {
            await FS.mkdir(dir, { adminTry: scope === 'system' });
            await FS.writeText(dest, text, { adminTry: scope === 'system' });
        } catch (e) { this.toast('Upload failed: ' + (e.message || e), 'danger'); ev.target.value = ''; return; }
        a.script = file.name;
        a.interactive = true;
        if (!a.command || !a.command.trim()) a.command = 'bash {script}';
        if (a.output === 'toast') a.output = 'pane';
        this.toast('Uploaded ' + file.name + ' → ' + dir);
        ev.target.value = '';
    },

    async saveCustomActions() {
        // In code view, commit the selected action's JSON/YAML first; abort on error.
        if (!this._commitActionCode()) return; // codeError already set & shown
        const scope = this.actionsMgr.scope;
        const path = scope === 'user'
            ? this.homePath + ExRT.const.USER_ACTIONS_PATH_SUFFIX
            : ExRT.const.SYSTEM_ACTIONS_PATH;
        const dir = Util.dirname(path);
        const data = JSON.stringify({ actions: this.customActions[scope] }, null, 2);
        this.actionsMgr.error = '';
        try {
            await FS.mkdir(dir, { adminTry: scope === 'system' });
            await FS.writeText(path, data, { adminTry: scope === 'system' });
            this.toast('Saved ' + path);
        } catch (e) {
            this.actionsMgr.error = e.message || String(e);
        }
    },

    openActionsManager() {
        this.actionsMgr.scope = 'user';
        this.actionsMgr.editingIdx = this.customActions.user.length ? 0 : null;
        this.actionsMgr.mode = 'form';
        this.actionsMgr.codeError = '';
        this.actionsMgr.monacoFailed = false;
        this._disposeActionsMonaco();
        bootstrap.Modal.getOrCreateInstance(this.actionsModalEl).show();
    },

    // ── Per-action Form ↔ JSON/YAML editing ────────────────────────────
    // The JSON/YAML editor shows ONLY the selected action, as a single object
    // (no { actions: [...] } wrapper and no internal id), so toggling Form /
    // JSON / YAML edits just that one action. The on-disk file stays
    // { actions: [...] }.
    _currentAction() {
        const arr = this.customActions[this.actionsMgr.scope];
        const i = this.actionsMgr.editingIdx;
        return (arr && i != null && i >= 0 && i < arr.length) ? arr[i] : null;
    },

    // Serialize one action to a tidy object. Core fields are always present so
    // a brand-new action shows an "all empty fields" template; optional pre/post
    // and flag fields appear only when set.
    _serializeAction(a, format) {
        a = a || {};
        const o = {
            label: a.label || '',
            command: a.command || '',
            appliesTo: a.appliesTo || '',
            pattern: a.pattern || '',
            output: a.output || 'toast',
            privilege: a.privilege || 'user',
            confirm: !!a.confirm,
            multi: a.multi !== false,
        };
        if (a.confirmMessage) o.confirmMessage = a.confirmMessage;
        if (a.interactive) o.interactive = true;
        if (a.script) o.script = a.script;
        if (a.requiresGh) o.requiresGh = true;
        if (a.preCommand) o.preCommand = a.preCommand;
        if (a.preConfirm) o.preConfirm = a.preConfirm;
        if (a.preConfirmLabel) o.preConfirmLabel = a.preConfirmLabel;
        if (a.postCommand) o.postCommand = a.postCommand;
        if (a.postConfirm) o.postConfirm = a.postConfirm;
        if (a.postConfirmLabel) o.postConfirmLabel = a.postConfirmLabel;
        if (format === 'yaml') {
            return (window.jsyaml ? jsyaml.dump(o, { indent: 2, lineWidth: 100 }) : JSON.stringify(o, null, 2));
        }
        return JSON.stringify(o, null, 2);
    },

    // Parse the single-action editor text back into a normalized action,
    // preserving the selected action's id. Returns the action, or null on a
    // syntax error (sets codeError). Empty text → an empty action (not an
    // error), so toggling views on a fresh action is seamless.
    _parseActionOne() {
        const cur = this._currentAction();
        const id = (cur && cur.id) || Util.uid();
        const text = (this.actionsMgr.codeText || '').trim();
        if (!text) { this.actionsMgr.codeError = ''; return this._normalizeAction({ id }); }
        let data;
        try {
            if (this.actionsMgr.codeFormat === 'yaml') {
                if (!window.jsyaml) throw new Error('YAML support unavailable');
                data = jsyaml.load(text);
            } else {
                data = JSON.parse(text);
            }
        } catch (e) {
            this.actionsMgr.codeError = (this.actionsMgr.codeFormat.toUpperCase()) + ' parse error: ' + (e.message || e);
            return null;
        }
        if (data == null || typeof data !== 'object' || Array.isArray(data)) {
            this.actionsMgr.codeError = 'Expected a single action object, e.g. { "label": "…", "command": "echo {path}" }.';
            return null;
        }
        this.actionsMgr.codeError = '';
        data.id = id;
        return this._normalizeAction(data);
    },

    // When in code view, parse the editor back into the selected action.
    // Returns true on success (or when not in code view), false on parse error.
    _commitActionCode() {
        if (this.actionsMgr.mode !== 'code') return true;
        const parsed = this._parseActionOne();
        if (parsed === null) return false;
        const arr = this.customActions[this.actionsMgr.scope];
        const i = this.actionsMgr.editingIdx;
        if (arr && i != null && i >= 0 && i < arr.length) arr[i] = parsed;
        return true;
    },

    // Load the currently-selected action into the code editor (or clear it).
    _loadActionIntoCode() {
        const a = this._currentAction();
        this._setActionsCode(a ? this._serializeAction(a, this.actionsMgr.codeFormat) : '');
        this.actionsMgr.codeError = '';
    },

    // Select an action from the list. Commits any pending code edit on the
    // current action first; works in both Form and JSON/YAML views.
    selectAction(i) {
        if (i === this.actionsMgr.editingIdx) return;
        if (!this._commitActionCode()) { this.toast('Fix the JSON/YAML errors first', 'danger'); return; }
        this.actionsMgr.editingIdx = i;
        if (this.actionsMgr.mode === 'code') this._loadActionIntoCode();
    },

    setActionsMode(mode) {
        if (mode === this.actionsMgr.mode) return;
        if (mode === 'code') {
            // entering code view → serialize the SELECTED action and mount Monaco
            if (this._currentAction() == null) { this.toast('Select or add an action first', 'info'); return; }
            this.actionsMgr.codeText = this._serializeAction(this._currentAction(), this.actionsMgr.codeFormat);
            this.actionsMgr.codeError = '';
            this.actionsMgr.mode = 'code';
            this.$nextTick(() => this._mountActionsMonaco());
        } else {
            // leaving code view → commit this action's JSON/YAML back to the form
            if (!this._commitActionCode()) return; // stay in code view, error shown
            this.actionsMgr.mode = 'form';
            this._disposeActionsMonaco();
        }
    },

    setActionsCodeFormat(format) {
        if (format === this.actionsMgr.codeFormat) return;
        // commit the text in the OLD format, then re-serialize in the new one
        if (!this._commitActionCode()) return; // parse error in current format
        this.actionsMgr.codeFormat = format;
        this._loadActionIntoCode();
        if (ExRT.actionsEditor.model && window.monaco) {
            try { window.monaco.editor.setModelLanguage(ExRT.actionsEditor.model, format === 'yaml' ? 'yaml' : 'json'); } catch (e) {}
        }
    },

    // Commit the current action, then switch scope tab and select its first action.
    switchActionsScope(scope) {
        if (scope === this.actionsMgr.scope) return;
        if (!this._commitActionCode()) { this.toast('Fix the JSON/YAML errors first', 'danger'); return; }
        this.actionsMgr.scope = scope;
        this.actionsMgr.editingIdx = this.customActions[scope].length ? 0 : null;
        this.actionsMgr.codeError = '';
        if (this.actionsMgr.mode === 'code') this._loadActionIntoCode();
    },

    // ── Monaco-backed code editor for the actions JSON/YAML ──────────────
    _setActionsCode(text) {
        this.actionsMgr.codeText = text;
        if (ExRT.actionsEditor.model) {
            this._actionsCodeSyncing = true;
            try { ExRT.actionsEditor.model.setValue(text); } catch (e) {}
            this._actionsCodeSyncing = false;
        }
    },

    async _mountActionsMonaco() {
        const el = document.getElementById('actionsMonaco');
        if (!el) return;
        try { await this._ensureMonaco(); }
        catch (e) { this.actionsMgr.monacoFailed = true; return; }   // fall back to <textarea>
        if (this.actionsMgr.mode !== 'code') return; // user left while loading
        this._disposeActionsMonaco();
        const lang = this.actionsMgr.codeFormat === 'yaml' ? 'yaml' : 'json';
        const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
        ExRT.actionsEditor.model = window.monaco.editor.createModel(this.actionsMgr.codeText || '', lang);
        ExRT.actionsEditor.editor = window.monaco.editor.create(el, {
            model: ExRT.actionsEditor.model,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            tabSize: 2,
            scrollBeyondLastLine: false,
            theme: dark ? 'vs-dark' : 'vs',
        });
        ExRT.actionsEditor.model.onDidChangeContent(() => {
            if (this._actionsCodeSyncing) return;
            this.actionsMgr.codeText = ExRT.actionsEditor.editor.getValue();
        });
        this.actionsMgr.monacoFailed = false;
    },

    _disposeActionsMonaco() {
        if (ExRT.actionsEditor.editor) { try { ExRT.actionsEditor.editor.dispose(); } catch (e) {} ExRT.actionsEditor.editor = null; }
        if (ExRT.actionsEditor.model) { try { ExRT.actionsEditor.model.dispose(); } catch (e) {} ExRT.actionsEditor.model = null; }
    },

    // A brand-new action starts with all fields empty, so its JSON/YAML view
    // shows an "all empty fields" template the user fills in.
    _blankAction() {
        return {
            id: Util.uid(), label: '', command: '', appliesTo: '', pattern: '',
            output: 'toast', privilege: 'user', confirm: false, confirmMessage: '',
            preCommand: '', preConfirm: '', preConfirmLabel: '',
            postCommand: '', postConfirm: '', postConfirmLabel: '',
            interactive: false, script: '', requiresGh: false, multi: false,
        };
    },

    addCustomAction() {
        // Commit any pending code edit on the current action first.
        if (!this._commitActionCode()) { this.toast('Fix the JSON/YAML errors first', 'danger'); return; }
        const scope = this.actionsMgr.scope;
        this.customActions[scope].push(this._blankAction());
        this.actionsMgr.editingIdx = this.customActions[scope].length - 1;
        if (this.actionsMgr.mode === 'code') this._loadActionIntoCode();
    },

    removeCustomAction() {
        // Form-mode "Delete this action" → delete the one being edited.
        this.removeActionAt(this.actionsMgr.editingIdx);
    },

    // Delete the action at index i; works in both Form and JSON/YAML modes.
    removeActionAt(i) {
        if (i == null || i < 0) return;
        const scope = this.actionsMgr.scope;
        const arr = this.customActions[scope];
        if (i >= arr.length) return;
        // Preserve edits to the *current* action when deleting a different one.
        if (this.actionsMgr.mode === 'code' && i !== this.actionsMgr.editingIdx) {
            if (!this._commitActionCode()) { this.toast('Fix the JSON/YAML errors first', 'danger'); return; }
        }
        const cur = this.actionsMgr.editingIdx;
        arr.splice(i, 1);
        let next;
        if (cur == null) next = null;
        else if (i === cur) next = arr.length ? Math.min(i, arr.length - 1) : null;
        else if (i < cur) next = cur - 1;
        else next = cur;
        this.actionsMgr.editingIdx = next;
        this.actionsMgr.codeError = '';
        if (this.actionsMgr.mode === 'code') {
            if (this._currentAction()) this._loadActionIntoCode();
            else this._setActionsCode('');
        }
    },

    // Is this action a "global" (toolbar) action? Used to split the manager list
    // into the Global Actions / Other Actions sections.
    _isGlobalAction(a) { return (a && (a.appliesTo || '')) === 'global'; },

    // The current scope's actions filtered to one section, each tagged with its
    // real index in the flat array (so select/move/delete still address the right
    // element) plus first/last flags within the section (so the ↑/↓ buttons
    // disable at the section's own ends, not the whole list's).
    _sectionedActions(global) {
        const arr = this.customActions[this.actionsMgr.scope] || [];
        const rows = [];
        for (let i = 0; i < arr.length; i++) {
            if (this._isGlobalAction(arr[i]) === global) rows.push({ a: arr[i], i });
        }
        rows.forEach((r, k) => { r.first = k === 0; r.last = k === rows.length - 1; });
        return rows;
    },
    globalActions() { return this._sectionedActions(true); },
    otherActions() { return this._sectionedActions(false); },

    // Reorder actions within the current scope. The context menu / toolbar list
    // actions in array order (see applicableActions), so moving a row up/down
    // changes that order immediately (in-memory); the new order is written to
    // disk on Save, like every other edit. Keeps the selected action selected as
    // it moves. Section-aware: the move swaps with the nearest neighbour *in the
    // same section* (Global vs Other), so an item never hops across the divide —
    // any other-section items sitting between them keep their relative order.
    moveActionAt(i, dir) {
        const scope = this.actionsMgr.scope;
        const arr = this.customActions[scope];
        if (i == null || i < 0 || i >= arr.length) return;
        const global = this._isGlobalAction(arr[i]);
        let j = i + dir;
        while (j >= 0 && j < arr.length && this._isGlobalAction(arr[j]) !== global) j += dir;
        if (j < 0 || j >= arr.length) return;
        // In code view, commit the pending edit first so a swap can't drop it.
        if (this.actionsMgr.mode === 'code') {
            if (!this._commitActionCode()) { this.toast('Fix the JSON/YAML errors first', 'danger'); return; }
        }
        // Swap arr[i] and arr[j] via splice-replace (the reactive array-mutation
        // convention used elsewhere) — j may be non-adjacent when the other
        // section sits between them, so this is a swap, not an adjacent shift.
        const a = arr[i], b = arr[j];
        arr.splice(j, 1, a);
        arr.splice(i, 1, b);
        const cur = this.actionsMgr.editingIdx;
        if (cur === i) this.actionsMgr.editingIdx = j;
        else if (cur === j) this.actionsMgr.editingIdx = i;
    },
    moveActionUp(i) { this.moveActionAt(i, -1); },
    moveActionDown(i) { this.moveActionAt(i, 1); },

    appliesToLabel(v) {
        return ({
            '': 'all items', both: 'files & directories', file: 'files',
            dir: 'directories', symlink: 'symlinks', archive: 'archives',
            global: 'global (toolbar)',
        })[v || ''] || (v || 'all items');
    },

    applicableActions(file) {
        const tab = this.currentPane();
        if (!tab) return [];
        const sel = this.selectedFiles(tab);
        // Built-in actions (e.g. self-update) ship with the plugin and are
        // authoritative for their ids: drop any stale editable action that was
        // seeded with the same id in a previous version. Each action is tagged
        // with its source so the menu can show a user/system badge.
        const builtin = this.customActions.builtin || [];
        const builtinIds = new Set(builtin.map(a => a.id));
        const tagged = [
            ...builtin.map(a => ({ a, source: 'system' })),
            ...this.customActions.system.filter(a => !builtinIds.has(a.id)).map(a => ({ a, source: 'system' })),
            ...this.customActions.user.filter(a => !builtinIds.has(a.id)).map(a => ({ a, source: 'user' })),
        ];
        const targets = sel.length > 0 ? sel : (file ? [file] : []);
        const anyInCache = targets.some(t => this.insideAnyRepoCache(t.path));
        return tagged.filter(({ a }) => {
            if (a.appliesTo === 'global') return false;   // toolbar-only; never in the file menu
            if (!file && sel.length === 0) return false;
            if (targets.length > 1 && !a.multi) return false;
            if (a.appliesTo) {
                const ok = targets.every(t => {
                    if (a.appliesTo === 'file') return t.type === 'f';
                    if (a.appliesTo === 'dir') return t.type === 'd';
                    if (a.appliesTo === 'both') return t.type === 'f' || t.type === 'd';
                    if (a.appliesTo === 'symlink') return !!t.symlinkTarget || t.type === 'l';
                    if (a.appliesTo === 'archive') return Util.isArchive(t);
                    return true;
                });
                if (!ok) return false;
            }
            if (a.pattern) {
                let re;
                try { re = new RegExp(a.pattern); }
                catch(e) { return false; }
                if (!targets.every(t => re.test(t.name))) return false;
            }
            // Cache-safety: in repo caches, only allow actions whose output mode
            // is read-only by nature (toast/modal/pane), unless explicitly opted in.
            if (anyInCache && !a.allowOnRepoCache) {
                const readOnlyOutput = (a.output === 'toast' || a.output === 'modal' || a.output === 'pane');
                if (!readOnlyOutput) return false;
            }
            return true;
        }).map(({ a, source }) => ({ ...a, _source: source }));
    },

    // Group applicable custom actions for the context menu. When there are more
    // than 3 in total they're split into "User" / "System" flyout submenus;
    // 3 or fewer stay flat. Built-in actions count as System.
    ctxActionGroups(file) {
        const all = this.applicableActions(file);
        const user = all.filter(a => a._source === 'user');
        const system = all.filter(a => a._source !== 'user');
        return { all, user, system, total: all.length, grouped: all.length > 3 };
    },

    // Build the template context (paths + version tokens) for an action.
    _actionContext(files) {
        const first = files[0];
        const m = first.name.match(/^explorer-(\d+\.\d+(?:\.\d+)?)\.zip$/);
        return {
            path: first.path,
            paths: files.map(f => f.path),
            dir: Util.dirname(first.path),
            name: first.name,
            base: first.name.replace(/\.[^.]*$/, ''),
            ext: first.name.includes('.') ? first.name.split('.').pop() : '',
            home: this.homePath || '',
            oldVersion: this.pluginVersion || '(unknown)',
            newVersion: (m && m[1]) || '',
        };
    },

    async runCustomAction(action) {
        if (action.requiresGh && this.gh.state !== 'authed') {
            this.toast('"' + (action.label || 'This action') + '" requires GitHub (gh) — set it up first.', 'warning');
            return;
        }
        // privilege:'ask' → choose elevation now (Cockpit handles admin auth).
        action = await this._resolveActionPrivilege(action);
        if (!action) return;
        const tab = this.currentPane();
        const sel = this.selectedFiles(tab);
        if (!sel.length) return;
        const baseCtx = this._actionContext(sel);

        // 1) Main confirmation (custom message if provided).
        if (action.confirm) {
            const msg = action.confirmMessage
                ? Util.fillText(action.confirmMessage, baseCtx)
                : `Run "${action.label}" on ${sel.length} item(s)?`;
            const ok = await this.askConfirm(action.label || 'Run action', msg, 'Run');
            if (!ok) return;
        }

        // 2) Pre-run command, with its own optional confirmation. The confirm
        // offers Run / Skip / Cancel — Skip runs the action without the step,
        // Cancel aborts everything.
        if (action.preCommand && action.preCommand.trim()) {
            let doPre = true;
            if (action.preConfirm && action.preConfirm.trim()) {
                const choice = await this.askChoice(action.label || 'Before running',
                    Util.fillText(action.preConfirm, baseCtx), [
                        { id: 'cancel', label: 'Cancel', variant: 'outline-secondary' },
                        { id: 'skip', label: 'Skip', variant: 'secondary' },
                        { id: 'run', label: action.preConfirmLabel || 'Run', variant: 'primary' },
                    ]);
                if (choice === 'cancel' || choice == null) return;
                doPre = (choice === 'run');
            }
            if (doPre) await this._runActionStep(action, Util.fillTemplate(action.preCommand, baseCtx), action.label + ' — pre');
        }

        // 3) Main command (per-file when there is no {paths} token).
        const scope = this._actionScope(action);
        const scriptsDir = this._scriptsDir(scope);
        const scriptPath = action.script ? Util.joinPath(scriptsDir, action.script) : '';
        const hasPathsToken = /\{paths\}/.test(action.command);
        const groups = (sel.length > 1 && !hasPathsToken) ? sel.map(f => [f]) : [sel];
        for (const group of groups) {
            const ctx = this._actionContext(group);
            ctx.scripts = scriptsDir;
            ctx.script = scriptPath;
            const cmd = Util.fillTemplate(action.command, ctx);
            if (action.interactive) await this._runInteractivePane(action, cmd, group);
            else await this._runActionCmd(action, cmd, group);
        }

        // 4) Post-run command, with optional confirmation (Run / Skip).
        if (action.postCommand && action.postCommand.trim()) {
            let doPost = true;
            if (action.postConfirm && action.postConfirm.trim()) {
                const choice = await this.askChoice(action.label || 'After running',
                    Util.fillText(action.postConfirm, baseCtx), [
                        { id: 'skip', label: 'Skip', variant: 'secondary' },
                        { id: 'run', label: action.postConfirmLabel || 'Run', variant: 'primary' },
                    ]);
                doPost = (choice === 'run');
            }
            if (doPost) await this._runActionStep(action, Util.fillTemplate(action.postCommand, baseCtx), action.label + ' — post');
        }
    },

    // ── Global (file-independent) actions — run from the toolbar ──────────
    // All actions whose appliesTo === 'global', tagged with their source.
    globalActions() {
        const builtin = this.customActions.builtin || [];
        const builtinIds = new Set(builtin.map(a => a.id));
        return [
            ...builtin.map(a => ({ a, source: 'system' })),
            ...this.customActions.system.filter(a => !builtinIds.has(a.id)).map(a => ({ a, source: 'system' })),
            ...this.customActions.user.filter(a => !builtinIds.has(a.id)).map(a => ({ a, source: 'user' })),
        ].filter(({ a }) => a.appliesTo === 'global').map(({ a, source }) => ({ ...a, _source: source }));
    },
    // Context for a global action: no file, {dir} is the active pane's folder.
    _globalContext(action) {
        const pane = this.currentPane();
        const dir = (pane && pane.path) || this.homePath || '/';
        const scope = this._actionScope(action);
        const scriptsDir = this._scriptsDir(scope);
        return {
            path: '', paths: [], dir, name: '', base: '', ext: '',
            home: this.homePath || '', oldVersion: this.pluginVersion || '(unknown)', newVersion: '',
            scripts: scriptsDir, script: action.script ? Util.joinPath(scriptsDir, action.script) : '',
        };
    },
    openGlobalActions() {
        bootstrap.Modal.getOrCreateInstance(this.globalActionsModalEl).show();
    },
    // Confirm, then run a global action (optionally with pre/post + interactive).
    async runGlobalAction(action) {
        if (action.requiresGh && this.gh.state !== 'authed') {
            this.toast('"' + (action.label || 'This action') + '" requires GitHub (gh) — set it up first.', 'warning');
            return;
        }
        const ctx = this._globalContext(action);
        // Close the picker first so the confirm/output isn't stacked behind it.
        try { bootstrap.Modal.getOrCreateInstance(this.globalActionsModalEl).hide(); } catch (e) {}
        // privilege:'ask' → choose elevation now (Cockpit handles admin auth).
        action = await this._resolveActionPrivilege(action);
        if (!action) return;
        const msg = action.confirmMessage
            ? Util.fillText(action.confirmMessage, ctx)
            : `Run "${action.label || 'action'}"?`;
        const ok = await this.askConfirm(action.label || 'Run action', msg, 'Run');
        if (!ok) return;
        if (action.preCommand && action.preCommand.trim()) {
            await this._runActionStep(action, Util.fillTemplate(action.preCommand, ctx), (action.label || 'action') + ' — pre');
        }
        const cmd = Util.fillTemplate(action.command, ctx);
        if (action.interactive) await this._runInteractivePane(action, cmd, []);
        else await this._runActionCmd(action, cmd, []);
        if (action.postCommand && action.postCommand.trim()) {
            await this._runActionStep(action, Util.fillTemplate(action.postCommand, ctx), (action.label || 'action') + ' — post');
        }
    },

    // Run a pre/post step as a tray operation (streaming output). Failures are
    // reported but don't abort the chain (e.g. "rm -rf" of a missing dir).
    async _runActionStep(action, cmd, label) {
        const adminFlag = action.privilege === 'require' ? { admin: true }
                       : action.privilege === 'try' ? { adminTry: true } : {};
        const op = this._beginOp(label);
        op.outputBuffer = '';
        try {
            const proc = cockpit.spawn(['sh', '-c', cmd], { ...FS.spawnOpts(adminFlag), err: 'out' });
            ExRT.ops.set(op.id, 'cancel', () => { try { proc.close('cancelled'); } catch (e) {} });
            op.canCancel = true;
            proc.stream(d => { if (op.outputBuffer != null) op.outputBuffer += d; });
            await proc;
            this._endOp(op, 'done');
        } catch (e) {
            this._failOp(op, e);
        }
    },
    // Where a scope's uploaded scripts live (sibling of its actions.json).
    _scriptsDir(scope) {
        return (scope === 'system' || scope === 'builtin')
            ? ExRT.const.SYSTEM_SCRIPTS_DIR
            : (this.homePath || '') + ExRT.const.USER_SCRIPTS_DIR_SUFFIX;
    },
    _actionScope(action) {
        if (action && action._source) return action._source;   // menu passes a copy tagged with its source
        if ((this.customActions.system || []).includes(action)) return 'system';
        if ((this.customActions.builtin || []).includes(action)) return 'builtin';
        return 'user';
    },

    // privilege:'ask' lets the user choose elevation at launch instead of
    // baking it into the action. Returns the action unchanged for other
    // privileges; for 'ask' it shows a "Run as me / Run as administrator"
    // choice and returns a shallow clone with privilege resolved to
    // 'user'/'require' (so every step — pre/main/post — runs consistently),
    // or null if the user cancelled. Choosing administrator runs the action
    // through Cockpit's superuser bridge, which handles authentication.
    async _resolveActionPrivilege(action) {
        if (!action || action.privilege !== 'ask') return action;
        const choice = await this.askChoice(
            action.label || 'Run action',
            'How should this action run?',
            [
                { id: 'user',  label: 'Run as me',            variant: 'outline-primary' },
                { id: 'admin', label: 'Run as administrator', variant: 'primary' },
            ]);
        if (choice == null || choice === false || choice === 'cancel') return null;
        return { ...action, privilege: choice === 'admin' ? 'require' : 'user' };
    },

    // Run a command in a streaming output tab that understands the prompt
    // protocol: stdout is scanned for ExRT.const.PROMPT_START..ExRT.const.PROMPT_END blocks; each is
    // parsed as YAML and turned into a dialog whose answer is written back to
    // the script's stdin (kept open), so the script's `read` continues.
    async _runInteractivePane(action, cmd, files) {
        const adminFlag = action.privilege === 'require' ? { admin: true }
                       : action.privilege === 'try' ? { adminTry: true } : {};
        const tab = this._buildTab('/', 'output');
        tab.outputActionLabel = (action.label || 'script') + ' (interactive)';
        tab.outputCommand = cmd;
        tab.outputStatus = 'running';
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        const rtab = this.tabs.find(t => t.id === tab.id) || tab;

        const channel = cockpit.channel({
            payload: 'stream',
            spawn: ['sh', '-c', cmd],
            ...FS.spawnOpts(adminFlag),
            err: 'out',
        });
        rtab.outputChannel = channel;

        let buf = '';
        let inPrompt = false;
        let promptLines = [];
        let queue = Promise.resolve();              // serialize line handling (dialogs are async)
        const enqueue = (fn) => { queue = queue.then(fn).catch(e => this._pushOutputLine(rtab, '[explorer] ' + (e.message || e))); };
        const decode = (d) => (typeof d === 'string' ? d : new TextDecoder().decode(d));

        const handleLine = async (line) => {
            const t = line.trim();
            if (!inPrompt && (t === ExRT.const.PROMPT_START || t === ExRT.const.MSG_START)) { inPrompt = true; promptLines = []; return; }
            if (inPrompt && t === ExRT.const.PROMPT_END) {
                inPrompt = false;
                await this._handleScriptPrompt(rtab, channel, promptLines.join('\n'));
                return;
            }
            if (inPrompt) { promptLines.push(line); return; }
            this._pushOutputLine(rtab, line);   // one entry per line; pane renders join('\n')
        };

        channel.addEventListener('message', (ev, data) => {
            buf += decode(data);
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                enqueue(() => handleLine(line));
            }
        });
        channel.addEventListener('close', (ev, opts) => {
            if (buf.length) { const last = buf; buf = ''; enqueue(() => handleLine(last)); }
            enqueue(async () => {
                rtab.outputStatus = opts.problem ? ('error: ' + (opts.message || opts.problem))
                                                 : ('done (exit ' + (opts['exit-status'] ?? 0) + ')');
                rtab.outputChannel = null;
            });
        });
    },

    // Parse one prompt block (YAML) and show the matching dialog, then send the
    // answer to the script's stdin. Cancel ⇒ abort the script.
    // Make the prompt YAML forgiving: auto-quote plain scalar values so that a
    // colon inside a value (e.g. `text: Running: make foo`) doesn't get parsed
    // as a nested mapping. Leaves list items, `key:` with a block value, flow
    // sequences/maps, already-quoted values, and bools/numbers untouched.
    _preprocessPromptYaml(text) {
        return String(text).split('\n').map(line => {
            const m = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:\s+(\S.*)$/);
            if (!m) return line;
            const indent = m[1], key = m[2], v = m[3].trim();
            if (/^[\[\{"'|>&*#]/.test(v)) return line;                       // flow/quoted/block/anchor/comment
            if (/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(v)) return line;  // bool / null / number
            return indent + key + ': "' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        }).join('\n');
    },

    async _handleScriptPrompt(rtab, channel, yamlText) {
        let spec;
        try { spec = window.jsyaml ? jsyaml.load(this._preprocessPromptYaml(yamlText)) : JSON.parse(yamlText); }
        catch (e) { this._pushOutputLine(rtab, '[explorer] bad prompt block: ' + (e.message || e)); return; }
        if (!spec || typeof spec !== 'object') { this._pushOutputLine(rtab, '[explorer] empty prompt block'); return; }

        const type = String(spec.type || 'text').toLowerCase();
        const title = spec.title || 'Input requested';
        const message = spec.message || spec.prompt || '';

        // Display-only block: show it and let the script continue (no stdin write).
        if (ExRT.const.DISPLAY_TYPES.includes(type)) {
            const text = spec.text != null ? String(spec.text)
                       : spec.message != null ? String(spec.message)
                       : (spec.title || '');
            const level = String(spec.level || 'info').toLowerCase();
            this._pushOutputLine(rtab, '» ' + text);
            const notable = ['success', 'warning', 'danger', 'error'].includes(level);
            if (spec.toast === true || notable) {
                const tl = level === 'error' ? 'danger' : level;
                this.toast(text, ['success', 'warning', 'danger', 'info'].includes(tl) ? tl : 'info');
            }
            return;
        }

        let answer = null;

        if (type === 'radio' || type === 'select' || type === 'choice') {
            const opts = Array.isArray(spec.options) ? spec.options.map(String) : [];
            if (!opts.length) { this._pushOutputLine(rtab, '[explorer] radio prompt has no options; aborting'); try { channel.close('cancelled'); } catch (e) {} return; }
            const buttons = opts.map(o => ({
                id: o, label: o,
                variant: (spec.default != null && String(spec.default) === o) ? 'primary' : 'outline-primary',
            }));
            const choice = await this.askChoice(title, message, buttons);
            if (choice == null || choice === false || choice === 'cancel') { try { channel.close('cancelled'); } catch (e) {} return; }
            answer = String(choice);
        } else {
            const def = spec.default != null ? String(spec.default) : '';
            const val = await this.askPrompt(title, message || 'Enter a value', def);
            if (val == null) { try { channel.close('cancelled'); } catch (e) {} return; }
            answer = String(val);
        }

        rtab.outputLines.push('‹ ' + answer + '\n');             // transcript of what we sent
        try { channel.send(answer + '\n'); }
        catch (e) { rtab.outputLines.push('[explorer] could not send input: ' + (e.message || e) + '\n'); }
    },

    // ───── Interactive scripts (Explorer Script Prompt Protocol) ───────────
    // Where a scope's uploaded scripts live (sibling of its actions.json).
    _scriptsDir(scope) {
        return (scope === 'system' || scope === 'builtin')
            ? ExRT.const.SYSTEM_SCRIPTS_DIR
            : (this.homePath || '') + ExRT.const.USER_SCRIPTS_DIR_SUFFIX;
    },
    _actionScope(action) {
        if (action && action._source) return action._source;   // menu passes a copy tagged with its source
        if ((this.customActions.system || []).includes(action)) return 'system';
        if ((this.customActions.builtin || []).includes(action)) return 'builtin';
        return 'user';
    },

    // Run a command in a streaming output tab that understands the prompt
    // protocol: stdout is scanned for ExRT.const.PROMPT_START..ExRT.const.PROMPT_END blocks; each is
    // parsed as YAML and turned into a dialog whose answer is written back to
    // the script's stdin (kept open), so the script's `read` continues.
    async _runInteractivePane(action, cmd, files) {
        const adminFlag = action.privilege === 'require' ? { admin: true }
                       : action.privilege === 'try' ? { adminTry: true } : {};
        const tab = this._buildTab('/', 'output');
        tab.outputActionLabel = (action.label || 'script') + ' (interactive)';
        tab.outputCommand = cmd;
        tab.outputStatus = 'running';
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        const rtab = this.tabs.find(t => t.id === tab.id) || tab;

        const channel = cockpit.channel({
            payload: 'stream',
            spawn: ['sh', '-c', cmd],
            ...FS.spawnOpts(adminFlag),
            err: 'out',
        });
        rtab.outputChannel = channel;

        let buf = '';
        let inPrompt = false;
        let promptLines = [];
        let queue = Promise.resolve();              // serialize line handling (dialogs are async)
        const enqueue = (fn) => { queue = queue.then(fn).catch(e => rtab.outputLines.push('[explorer] ' + (e.message || e))); };
        const decode = (d) => (typeof d === 'string' ? d : new TextDecoder().decode(d));

        const handleLine = async (line) => {
            const t = line.trim();
            if (!inPrompt && (t === ExRT.const.PROMPT_START || t === ExRT.const.MSG_START)) { inPrompt = true; promptLines = []; return; }
            if (inPrompt && t === ExRT.const.PROMPT_END) {
                inPrompt = false;
                await this._handleScriptPrompt(rtab, channel, promptLines.join('\n'));
                return;
            }
            if (inPrompt) { promptLines.push(line); return; }
            rtab.outputLines.push(line + '\n');   // pane renders join(''), so keep the newline
        };

        channel.addEventListener('message', (ev, data) => {
            buf += decode(data);
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                enqueue(() => handleLine(line));
            }
        });
        channel.addEventListener('close', (ev, opts) => {
            if (buf.length) { const last = buf; buf = ''; enqueue(() => handleLine(last)); }
            enqueue(async () => {
                rtab.outputStatus = opts.problem ? ('error: ' + (opts.message || opts.problem))
                                                 : ('done (exit ' + (opts['exit-status'] ?? 0) + ')');
                rtab.outputChannel = null;
            });
        });
    },

    // Parse one prompt block (YAML) and show the matching dialog, then send the
    // answer to the script's stdin. Cancel ⇒ abort the script.
    // Make the prompt YAML forgiving: auto-quote plain scalar values so that a
    // colon inside a value (e.g. `text: Running: make foo`) doesn't get parsed
    // as a nested mapping. Leaves list items, `key:` with a block value, flow
    // sequences/maps, already-quoted values, and bools/numbers untouched.
    _preprocessPromptYaml(text) {
        return String(text).split('\n').map(line => {
            const m = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:\s+(\S.*)$/);
            if (!m) return line;
            const indent = m[1], key = m[2], v = m[3].trim();
            if (/^[\[\{"'|>&*#]/.test(v)) return line;                       // flow/quoted/block/anchor/comment
            if (/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(v)) return line;  // bool / null / number
            return indent + key + ': "' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        }).join('\n');
    },

    async _handleScriptPrompt(rtab, channel, yamlText) {
        let spec;
        try { spec = window.jsyaml ? jsyaml.load(this._preprocessPromptYaml(yamlText)) : JSON.parse(yamlText); }
        catch (e) { rtab.outputLines.push('[explorer] bad prompt block: ' + (e.message || e) + '\n'); return; }
        if (!spec || typeof spec !== 'object') { rtab.outputLines.push('[explorer] empty prompt block\n'); return; }

        const type = String(spec.type || 'text').toLowerCase();
        const title = spec.title || 'Input requested';
        const message = spec.message || spec.prompt || '';

        // Display-only block: show it and let the script continue (no stdin write).
        if (ExRT.const.DISPLAY_TYPES.includes(type)) {
            const text = spec.text != null ? String(spec.text)
                       : spec.message != null ? String(spec.message)
                       : (spec.title || '');
            const level = String(spec.level || 'info').toLowerCase();
            rtab.outputLines.push('» ' + text + '\n');
            const notable = ['success', 'warning', 'danger', 'error'].includes(level);
            if (spec.toast === true || notable) {
                const tl = level === 'error' ? 'danger' : level;
                this.toast(text, ['success', 'warning', 'danger', 'info'].includes(tl) ? tl : 'info');
            }
            return;
        }

        let answer = null;

        if (type === 'radio' || type === 'select' || type === 'choice') {
            const opts = Array.isArray(spec.options) ? spec.options.map(String) : [];
            if (!opts.length) { rtab.outputLines.push('[explorer] radio prompt has no options; aborting\n'); try { channel.close('cancelled'); } catch (e) {} return; }
            const buttons = opts.map(o => ({
                id: o, label: o,
                variant: (spec.default != null && String(spec.default) === o) ? 'primary' : 'outline-primary',
            }));
            const choice = await this.askChoice(title, message, buttons);
            if (choice == null || choice === false || choice === 'cancel') { try { channel.close('cancelled'); } catch (e) {} return; }
            answer = String(choice);
        } else {
            const def = spec.default != null ? String(spec.default) : '';
            const multiline = (spec.multiline === true || spec.multiline === 'true');
            const val = await this.askPrompt(title, message || 'Enter a value', def, { multiline });
            if (val == null) { try { channel.close('cancelled'); } catch (e) {} return; }
            answer = String(val);
            if (multiline) {
                // The protocol exchanges a single line over stdin, so a
                // multi-line answer is base64-encoded; the script decodes it.
                const oneLine = answer.replace(/\s+/g, ' ').trim();
                this._pushOutputLine(rtab, '‹ ' + (oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine) + '  (multi-line)');
                try { channel.send(this._b64Utf8(answer) + '\n'); }
                catch (e) { this._pushOutputLine(rtab, '[explorer] could not send input: ' + (e.message || e)); }
                return;
            }
        }

        this._pushOutputLine(rtab, '‹ ' + answer);             // transcript of what we sent
        try { channel.send(answer + '\n'); }
        catch (e) { this._pushOutputLine(rtab, '[explorer] could not send input: ' + (e.message || e)); }
    },
    // UTF-8-safe base64 encode (btoa only handles Latin-1).
    _b64Utf8(str) {
        try { return btoa(unescape(encodeURIComponent(String(str)))); }
        catch (e) { try { return btoa(String(str)); } catch (e2) { return ''; } }
    },
};
