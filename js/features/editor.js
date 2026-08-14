// Preview + editor (Monaco / Quill WYSIWYG) + multi-window management.
// Extracted from app.js (2.0 modularization). Methods only; window/preview/
// editor reactive state stays in app.js; Monaco/Quill instances on window.ExRT.
window.ExplorerEditor = {
    // Line-number gutter text for the code preview: "1\n2\n…\nN", one per line
    // the <pre> renders (content.split('\n') — a trailing newline counts, as it
    // does in the pre). white-space:pre means lines don't wrap, so this aligns
    // one-to-one with the highlighted code beside it.
    pvLineNumbers(content) {
        const n = (content == null ? '' : String(content)).split('\n').length;
        return Array.from({ length: n }, (_, i) => i + 1).join('\n');
    },

    // Copy the text of the active text-preview window to the clipboard. Reuses
    // the terminal's execCommand-based helper so it also works over plain HTTP
    // (no secure-context clipboard). Shows a brief "Copied ✓" on the button.
    copyPreviewContent() {
        const w = this.activeWin();
        if (!w || w.kind !== 'preview' || !w.pv || w.pv.kind !== 'text') return;
        const ok = this._copyToClipboard(w.pv.content || '');
        if (!ok) { this.toast('Could not copy to clipboard', 'danger'); return; }
        this.copiedWinId = w.id;   // scoped to this window so other previews don't show it
        this.toast('Copied file contents to clipboard', 'success');
        clearTimeout(this._previewCopiedTimer);
        this._previewCopiedTimer = setTimeout(() => { this.copiedWinId = null; }, 1500);
    },

    async openPreview(file, opts) {
        opts = opts || {};
        if (!file) return;
        // Already open in a window? Just focus it.
        const existing = this.windows.find(w => w.kind === 'preview' && w.path === file.path);
        if (existing) { this.activateWindow(existing.id, !opts.minimized); return; }

        const id = this._newWinId();
        const nav = (opts.siblings && opts.siblings.length)
            ? (() => {
                const list = opts.siblings.filter(Util.isPreviewable);
                const idx = list.findIndex(s => s.path === file.path);
                return idx >= 0 && list.length > 1 ? { list, idx } : null;
            })()
            : null;
        this.windows.push({
            id, kind: 'preview', path: file.path, _file: file,
            title: this._winTitle(file.path, 'preview'),
            pv: { kind: null, content: '', lang: '', url: null, reason: '', permissionDenied: false },
            loading: true, nav,
        });
        this.activateWindow(id, !opts.minimized);
        await this._loadPreviewInto(id, file);
    },

    // Free a preview's blob URL once the element that referenced it is gone.
    // Revoking while the <video>/<img> is still mounted makes the browser
    // re-request a now-dead blob: URL (net::ERR_FILE_NOT_FOUND in the console,
    // observed live), so this waits for Alpine to unmount it first.
    _revokePvUrl(url) {
        if (!url) return;
        this.$nextTick(() => { try { URL.revokeObjectURL(url); } catch (e) {} });
    },

    previewCanStep(id, dir) {
        const w = this._win(id);
        if (!w || !w.nav) return false;
        const next = w.nav.idx + dir;
        return next >= 0 && next < w.nav.list.length;
    },
    async previewStep(id, dir) {
        const w = this._win(id);
        if (!w || !w.nav) return;
        const next = w.nav.idx + dir;
        if (next < 0 || next >= w.nav.list.length) return;      // clamp
        if (this._teardownPreviewVideo) this._teardownPreviewVideo(id); // stop any hls/ffmpeg (Task 5)
        // Free the outgoing blob URL: paging through a folder of large photos
        // otherwise retains every decoded image until the page is reloaded
        // (only the last window's URL was ever revoked, in _removeWindow).
        if (w.pv) this._revokePvUrl(w.pv.url);
        ExRT.preview.workbooks.delete(id);
        w.nav.idx = next;
        const file = w.nav.list[next];
        w._file = file;
        w.path = file.path;
        w.title = this._winTitle(file.path, 'preview');
        w.pv = { kind: null, content: '', lang: '', url: null, reason: '', permissionDenied: false };
        w.loading = true;
        await this._loadPreviewInto(id, file);
    },

    _looksPermissionDenied(e) {
        if (!e) return false;
        if (e.permissionDenied) return true;
        const m = ((e.message || '') + ' ' + (e.problem || '')).toLowerCase();
        return /permission denied|eacces|access-denied|not permitted|not authorized|operation not permitted/.test(m);
    },

    async retryPreviewAsAdmin(id) {
        const w = this._win(id);
        if (!w || !w._file) return;
        w.loading = true;
        await this._loadPreviewInto(id, w._file, true);
    },

    async _loadPreviewInto(id, file, admin) {
        // Per-window load generation (mirrors ExRT.video.gen for HLS starts).
        // _loadPreviewInto is called concurrently for one window on rapid
        // ◀/▶: without this, a slow-finishing OLDER load can win the race
        // against a newer one and overwrite pv / the workbook registry with
        // stale data (observed: the spreadsheet branch registers the workbook
        // AFTER its own set(), so a slow older xlsx load left the previous
        // file's workbook paired with the newer pv.sheets, and the sheet
        // picker then threw). Bumping here, before any await, means every
        // write below can cheaply check "is my generation still current?"
        // and no-op if a newer call already superseded it.
        const gen = (ExRT.preview.gen.get(id) || 0) + 1;
        ExRT.preview.gen.set(id, gen);
        const isCurrent = () => ExRT.preview.gen.get(id) === gen;
        const limit = (this.settings.previewLimitMB || 10) * 1024 * 1024;
        const ropts = admin ? { admin: true } : undefined;
        // Replacing pv drops whatever the previous load allocated for this
        // window: an object URL (revoked here, not left to the GC — blobs are
        // not collected while a URL handle exists) and the parsed workbook.
        const set = (pv) => {
            // Superseded: a newer load already took the next generation. Free
            // whatever THIS call allocated (e.g. an object URL) instead of
            // leaking it, and leave the newer load's pv / workbook alone.
            if (!isCurrent()) { if (pv && pv.url) this._revokePvUrl(pv.url); return; }
            const w = this._win(id);
            if (!w) return;
            if (w.pv && w.pv.url && w.pv.url !== pv.url) this._revokePvUrl(w.pv.url);
            ExRT.preview.workbooks.delete(id);
            w.pv = Object.assign({ permissionDenied: false }, pv);
            w.loading = false;
        };
        if (Util.isMarkdown(file)) {
            if (file.size > limit) { set({ kind: 'binary', reason: `File too large (${Util.humanSize(file.size)}).` }); return; }
            try {
                const txt = await FS.readText(file.path, ropts);
                // Source mode reuses the text preview's Prism-highlighted <pre>;
                // without the grammar loaded it renders unhighlighted.
                if (window.loadPrismLanguage) await window.loadPrismLanguage('markdown');
                await this._ensureMarked();
                const html = this._renderMarkdown(txt);
                // mdMode:'source' so this fallback state is coherent with the toggle
                // logic below (no srcdoc exists to render, so it must read as
                // already-in-source-mode, not "undefined").
                if (html == null) set({ kind: 'text', content: txt || '', lang: 'markdown', mdMode: 'source' });
                // content (not just md) so toggleMarkdownMode's 'text' state — which
                // reuses the existing text-preview template bound to pv.content — has
                // something to show.
                else set({ kind: 'markdown', md: txt || '', content: txt || '', mdMode: 'rendered', lang: 'markdown', srcdoc: this._docIframeShell(html) });
            } catch (e) { set({ kind: 'binary', reason: e.message || 'Could not read file.', permissionDenied: !admin && this._looksPermissionDenied(e) }); }
            return;
        }
        if (Util.isDocx(file)) {
            if (file.size > limit) { set({ kind: 'binary', reason: `File too large (${Util.humanSize(file.size)}; limit ${this.settings.previewLimitMB} MB).` }); return; }
            try {
                const buf = await (await FS.readBinaryAsBlob(file.path, ropts)).arrayBuffer();
                await this._ensureMammoth();
                const res = await window.mammoth.convertToHtml({ arrayBuffer: buf });
                set({ kind: 'docx', srcdoc: this._docIframeShell(res.value || '<p>(empty document)</p>') });
            } catch (e) { set({ kind: 'binary', reason: 'Could not render .docx: ' + (e.message || e) }); }
            return;
        }
        if (Util.isSpreadsheet(file)) {
            if (file.size > limit) { set({ kind: 'binary', reason: `File too large (${Util.humanSize(file.size)}; limit ${this.settings.previewLimitMB} MB).` }); return; }
            try {
                const buf = await (await FS.readBinaryAsBlob(file.path, ropts)).arrayBuffer();
                await this._ensureXlsx();
                const wb = XLSX.read(buf, { type: 'array' });
                const sheets = wb.SheetNames.slice();
                const html = sheets.length ? XLSX.utils.sheet_to_html(wb.Sheets[sheets[0]]) : '<p>(no sheets)</p>';
                set({ kind: 'sheet', sheets, sheetIdx: 0, srcdoc: this._docIframeShell(html) });
                // After set() (which clears this window's registry entry): the
                // workbook is a large self-referential object and stays off
                // reactive state — only the sheet names + rendered srcdoc are
                // reactive. Dropped in set()/previewStep/_removeWindow. Gated on
                // isCurrent() same as set(): a superseded load must not pair a
                // stale workbook with whatever newer pv.sheets is now showing.
                if (isCurrent()) ExRT.preview.workbooks.set(id, wb);
            } catch (e) { set({ kind: 'binary', reason: 'Could not render spreadsheet: ' + (e.message || e) }); }
            return;
        }
        if (Util.isVideo(file)) {
            const ff = await this._vpProbeFfmpeg();
            const nativeLimit = 60 * 1024 * 1024;
            const canNative = Util.isVideoNative(file) && (file.size <= nativeLimit || !ff.ffmpeg);
            if (canNative) {
                try {
                    const blob = await FS.readBinaryAsBlob(file.path, { ...ropts, type: Util.mimeType(file) });
                    set({ kind: 'video', mode: 'native', url: URL.createObjectURL(blob) });
                } catch (e) { set({ kind: 'binary', reason: e.message || 'Could not read file.', permissionDenied: !admin && this._looksPermissionDenied(e) }); }
                return;
            }
            if (!ff.ffmpeg) {
                let os = ''; try { os = await FS.readText('/etc/os-release'); } catch (e) {}
                set({ kind: 'video', mode: 'ffmpeg-missing', installCmd: this._pkgInstallCommand(os) });
                return;
            }
            // `pending`: the ffmpeg session is started by _vpMaybeStart once
            // this window is the visible, active one — never for a window
            // restored minimized (which has no <video> element to attach to).
            set({ kind: 'video', mode: 'hls', transcodeState: 'pending', pending: true });
            if (isCurrent()) this._vpMaybeStart(id);
            return;
        }
        if (Util.isTextLike(file)) {
            if (file.size > limit) { set({ kind: 'binary', reason: `File too large (${Util.humanSize(file.size)}; limit ${this.settings.previewLimitMB} MB).` }); return; }
            try {
                const txt = await FS.readText(file.path, ropts);
                if (Util.looksBinary(txt)) set({ kind: 'binary', reason: 'This looks like a binary file and can’t be shown as text.' });
                else {
                    const lang = Util.langFromExt(file.name);
                    if (lang !== 'plain' && window.loadPrismLanguage) await window.loadPrismLanguage(lang);
                    set({ kind: 'text', content: txt || '', lang });
                }
            } catch (e) { set({ kind: 'binary', reason: e.message || 'Could not read file.', permissionDenied: !admin && this._looksPermissionDenied(e) }); }
        } else if (Util.isImage(file) || Util.isPdf(file) || Util.isAudio(file)) {
            try {
                const blob = await FS.readBinaryAsBlob(file.path, { ...ropts, type: Util.mimeType(file) });
                const url = URL.createObjectURL(blob);
                let kind = 'binary';
                if (Util.isImage(file)) kind = 'image';
                else if (Util.isPdf(file)) kind = 'pdf';
                else if (Util.isAudio(file)) kind = 'audio';
                set({ kind, url });
            } catch (e) { set({ kind: 'binary', reason: e.message || 'Could not read file.', permissionDenied: !admin && this._looksPermissionDenied(e) }); }
        } else {
            set({ kind: 'binary', reason: 'No preview available for this file type.' });
        }
    },

    _docIframeShell(bodyHtml) {
        // Sandboxed, no scripts. Minimal base styling; inherits nothing from the app.
        const css = 'body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:16px;color:#111;background:#fff}'
            + 'table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:2px 6px}'
            + 'img{max-width:100%}pre{white-space:pre-wrap}';
        return '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' + bodyHtml + '</body></html>';
    },
    _renderMarkdown(text) {
        try { return (window.marked ? (marked.parse ? marked.parse(text) : marked(text)) : null); }
        catch (e) { return null; }
    },
    toggleMarkdownMode(id) {
        const w = this._win(id);
        if (!w || !w.pv) return;
        // No rendered doc to switch to (marked failed/unavailable — the
        // html==null fallback in _loadPreviewInto) — stay put rather than flip
        // to 'markdown' with an undefined srcdoc, which would blank the iframe.
        if (!w.pv.srcdoc) return;
        w.pv.mdMode = w.pv.mdMode === 'source' ? 'rendered' : 'source';
        w.pv.kind = w.pv.mdMode === 'source' ? 'text' : 'markdown';
    },
    _selectSheet(id, i) {
        const w = this._win(id);
        const wb = ExRT.preview.workbooks.get(id);
        if (!w || !w.pv || !wb) return;
        const name = w.pv.sheets[i];
        w.pv.sheetIdx = i;
        try {
            const html = XLSX.utils.sheet_to_html(wb.Sheets[name]);
            w.pv.srcdoc = this._docIframeShell(html);
        } catch (e) { w.pv.srcdoc = this._docIframeShell('<p>Could not render sheet.</p>'); }
    },

    // Text preview not backed by a file (e.g. custom-action output).
    openTextPreview(title, content) {
        const id = this._newWinId();
        this.windows.push({
            id, kind: 'preview', path: null, title: title || 'Output',
            pv: { kind: 'text', content: content || '', lang: 'plain', url: null, reason: '' },
            loading: false,
        });
        this.activateWindow(id, true);
    },


    // ───── Editor (Monaco + Quill WYSIWYG) ──────────────────────────────────
    //
    // Layout:
    //   - editor.mode = 'code'    → Monaco editor (the default)
    //   - editor.mode = 'wysiwyg' → Quill rich-text (only for .md / .html)
    //
    // For .md files, the content round-trips through marked (MD→HTML) and
    // turndown (HTML→MD) when switching modes / saving.

    async _ensureMonaco() {
        if (window.monaco) return;
        if (this._monacoLoading) { await this._monacoLoading; return; }
        this._monacoLoading = new Promise((resolve, reject) => {
            if (!window.require) { reject(new Error('Monaco loader not available')); return; }
            window.require(['vs/editor/editor.main'], () => resolve(), reject);
        });
        await this._monacoLoading;
    },

    async _ensureScript(src, globalName) {
        if (window[globalName]) return;
        await new Promise((resolve, reject) => {
            // Monaco's AMD loader defines a global `define` (with .amd). UMD
            // bundles (diff2html, quill, marked, turndown) would then register
            // as anonymous AMD modules and throw "Can only have one anonymous
            // define call per script file" — and never attach to window.
            // Hide `define` during the load so they take the browser-global path.
            const hadDefine = Object.prototype.hasOwnProperty.call(window, 'define');
            const prevDefine = window.define;
            const amd = prevDefine && prevDefine.amd;
            if (amd) { try { window.define = undefined; } catch (e) {} }
            const restore = () => {
                if (!amd) return;
                try { if (hadDefine) window.define = prevDefine; else delete window.define; } catch (e) {}
            };
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => { restore(); resolve(); };
            s.onerror = () => { restore(); reject(new Error('Failed to load ' + src)); };
            document.head.appendChild(s);
        });
    },

    async _ensureQuill()    { await this._ensureScript('js/quill.js', 'Quill'); },
    async _ensureMarked()   { await this._ensureScript('js/marked.js', 'marked'); },
    async _ensureTurndown() { await this._ensureScript('js/turndown.js', 'TurndownService'); },
    async _ensureMammoth()  { await this._ensureScript('js/mammoth.browser.min.js', 'mammoth'); },
    async _ensureXlsx()     { await this._ensureScript('js/xlsx.full.min.js', 'XLSX'); },

    // Map file extension/name to a Monaco language id.
    _monacoLang(name) {
        const lower = (name || '').toLowerCase();
        const ext = lower.includes('.') ? lower.split('.').pop() : '';
        const map = {
            'js':'javascript','mjs':'javascript','cjs':'javascript','jsx':'javascript',
            'ts':'typescript','tsx':'typescript',
            'py':'python','rb':'ruby','go':'go','rs':'rust','java':'java','kt':'kotlin','swift':'swift',
            'c':'c','h':'c','cpp':'cpp','cc':'cpp','hpp':'cpp','cxx':'cpp','cs':'csharp',
            'php':'php','pl':'perl','lua':'lua',
            'sh':'shell','bash':'shell','zsh':'shell',
            'html':'html','htm':'html','xml':'xml','svg':'xml',
            'css':'css','scss':'scss','sass':'scss','less':'less',
            'json':'json','yml':'yaml','yaml':'yaml','toml':'ini',
            'md':'markdown','markdown':'markdown',
            'sql':'sql','ini':'ini','conf':'ini','cfg':'ini','env':'shell',
            'ps1':'powershell','proto':'proto',
            'dockerfile':'dockerfile','makefile':'makefile','mk':'makefile',
            'log':'plaintext','diff':'plaintext','patch':'plaintext',
            'service':'ini','timer':'ini','socket':'ini','mount':'ini','target':'ini',
        };
        if (map[ext]) return map[ext];
        if (lower === 'dockerfile') return 'dockerfile';
        if (lower === 'makefile')   return 'makefile';
        return 'plaintext';
    },

    // ── Window management core (preview + editor multi-window) ───────────
    _newWinId() { return 'w' + (this._winSeq++); },
    _win(id) { return this.windows.find(w => w.id === id); },
    activeWin() { return this.activeWinId ? this._win(this.activeWinId) : null; },
    _winTitle(path, kind) {
        return (path || '').split('/').filter(Boolean).pop() || (kind === 'editor' ? 'Editor' : 'Preview');
    },
    winTaskIcon(w) { return (w && w.kind === 'editor') ? '✎' : '👁'; },

    activateWindow(id, show) {
        // Snapshot the WYSIWYG buffer of the window we're leaving.
        const prev = this.activeWin();
        if (prev && prev.id !== id && prev.kind === 'editor' && prev.mode === 'wysiwyg' && ExRT.quill.editor) {
            prev.quillHtml = ExRT.quill.editor.root.innerHTML;
        }
        const w = this._win(id);
        if (!w) return;
        this.activeWinId = id;
        if (show === false) {
            this.$nextTick(() => this._syncActiveEditor());
        } else {
            this._showHost();
        }
        // A preview whose HLS session was deferred (window not on screen yet)
        // starts now, if this made it the visible active window.
        if (this._vpMaybeStart) this._vpMaybeStart(id);
    },

    _showHost() {
        bootstrap.Modal.getOrCreateInstance(this.windowHostEl).show();
        this.hostVisible = true;
        this.$nextTick(() => this._syncActiveEditor());
        // Restore path: _restoreWindows() picks the active window and shows the
        // host directly, without going back through activateWindow().
        if (this._vpMaybeStart) this._vpMaybeStart(this.activeWinId);
    },
    minimizeHost() {
        bootstrap.Modal.getOrCreateInstance(this.windowHostEl).hide();
        this.hostVisible = false;
    },
    // Taskbar item click: minimize if it's the active+visible window, else switch to it.
    taskbarClick(id) {
        if (this.activeWinId === id && this.hostVisible) this.minimizeHost();
        else this.activateWindow(id, true);
    },

    _ensureFileEditor() {
        if (ExRT.editor.file) return;
        const container = document.getElementById('monacoContainer');
        if (!container || !window.monaco) return;
        const dark = (document.documentElement.getAttribute('data-bs-theme') === 'dark');
        ExRT.editor.file = window.monaco.editor.create(container, {
            automaticLayout: true,
            theme: dark ? 'vs-dark' : 'vs',
            fontSize: 13,
            minimap: { enabled: true },
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            renderWhitespace: 'selection',
            tabSize: 4,
        });
    },

    // After the active window changes, point Monaco/Quill at its content.
    _syncActiveEditor() {
        const w = this.activeWin();
        if (!w || w.kind !== 'editor') return;
        this._ensureFileEditor();
        const model = ExRT.editor.models.get(w.id);
        if (ExRT.editor.file && model && ExRT.editor.file.getModel() !== model) {
            ExRT.editor.file.setModel(model);
            ExRT.editor.file.updateOptions({ readOnly: !!w.readOnly });
        }
        if (w.mode === 'wysiwyg') {
            this._mountQuill(w.quillHtml != null ? w.quillHtml : '');
        }
        if (ExRT.editor.file) { try { ExRT.editor.file.layout(); if (w.mode === 'code') ExRT.editor.file.focus(); } catch (e) {} }
    },

    // ───── Editor (Monaco + Quill WYSIWYG) ──────────────────────────────────
    async openEditor(file, opts) {
        opts = opts || {};
        if (!file) return;
        if (!Util.isTextLike(file)) {
            const ok = await this.askConfirm('Open in editor', 'This file is not recognised as text. Open anyway?', 'Open');
            if (!ok) return;
        }
        const limit = (this.settings.previewLimitMB || 10) * 1024 * 1024;
        if (file.size > limit) { this.toast(`File too large to edit (${Util.humanSize(file.size)}).`, 'danger'); return; }

        // Already open in a window? Just focus it.
        const existing = this.windows.find(w => w.kind === 'editor' && w.path === file.path);
        if (existing) { this.activateWindow(existing.id, !opts.minimized); return; }

        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const isMd = ext === 'md' || ext === 'markdown';
        const isHtml = ext === 'html' || ext === 'htm';
        const lang = this._monacoLang(file.name);

        let content = '';
        let openedAsAdmin = false;
        try { content = await FS.readText(file.path); }
        catch (e) {
            if (this._looksPermissionDenied(e)) {
                const ok = await this.askConfirm('Open as administrator',
                    `Couldn’t read ${file.name} as you. Open it as administrator?`, 'Open as admin');
                if (!ok) return;
                try { content = await FS.readText(file.path, { admin: true }); openedAsAdmin = true; }
                catch (e2) { this.toast('Could not open: ' + (e2.message || e2), 'danger'); return; }
            } else {
                this.toast('Could not open: ' + (e.message || e), 'danger'); return;
            }
        }
        if (Util.looksBinary(content)) {
            const ok = await this.askConfirm('Binary file',
                'This looks like a binary file. Editing it as text may corrupt it. Open anyway?', 'Open anyway');
            if (!ok) return;
        }

        try { await this._ensureMonaco(); }
        catch (e) { this.toast('Failed to load editor: ' + (e.message || e), 'danger'); return; }

        const id = this._newWinId();
        const model = window.monaco.editor.createModel(content || '', lang);
        model.onDidChangeContent(() => { const ww = this._win(id); if (ww && !ww.readOnly) ww.dirty = true; });
        ExRT.editor.models.set(id, model);

        this.windows.push({
            id, kind: 'editor', path: file.path, title: this._winTitle(file.path, 'editor'),
            lang, mode: 'code', dirty: false, isMarkdown: isMd, isHtml: isHtml,
            canWysiwyg: isMd || isHtml, original: content || '', error: '', permissionDenied: openedAsAdmin, needsAdmin: openedAsAdmin,
            quillHtml: null, readOnly: false,
        });
        this.activateWindow(id, !opts.minimized);
    },

    // Read-only Monaco window (e.g. "view file at commit").
    async openReadOnly(title, content, lang) {
        try { await this._ensureMonaco(); }
        catch (e) { this.toast('Failed to load editor: ' + (e.message || e), 'danger'); return; }
        const id = this._newWinId();
        const model = window.monaco.editor.createModel(content || '', lang || 'plaintext');
        ExRT.editor.models.set(id, model);
        this.windows.push({
            id, kind: 'editor', path: null, title: title || 'View', lang: lang || '',
            mode: 'code', dirty: false, isMarkdown: false, isHtml: false, canWysiwyg: false,
            original: content || '', error: '', permissionDenied: false, needsAdmin: false, quillHtml: null, readOnly: true,
        });
        this.activateWindow(id, true);
    },

    async _mountQuill(htmlContent) {
        await this._ensureQuill();
        const container = document.getElementById('quillContainer');
        if (!container) return;
        container.innerHTML = '';
        const editorDiv = document.createElement('div');
        container.appendChild(editorDiv);
        ExRT.quill.editor = new window.Quill(editorDiv, {
            theme: 'snow',
            modules: { toolbar: [
                [{ header: [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ list: 'ordered' }, { list: 'bullet' }],
                [{ indent: '-1' }, { indent: '+1' }],
                ['blockquote', 'code-block'],
                ['link', 'image'],
                [{ align: [] }],
                ['clean'],
            ] },
        });
        ExRT.quill.editor.root.innerHTML = htmlContent || '';
        ExRT.quill.editor.on('text-change', () => { const w = this.activeWin(); if (w && w.kind === 'editor') w.dirty = true; });
    },

    async setEditorMode(mode) {
        const w = this.activeWin();
        if (!w || w.kind !== 'editor') return;
        if (mode === w.mode) return;
        if (!w.canWysiwyg && mode === 'wysiwyg') return;
        if (w.mode === 'code' && ExRT.editor.file) {
            const code = ExRT.editor.file.getValue();
            let html;
            if (w.isMarkdown) { await this._ensureMarked(); html = window.marked.parse(code); }
            else html = code;
            w.mode = 'wysiwyg';
            w.quillHtml = html;
            this.$nextTick(() => this._mountQuill(html));
        } else if (w.mode === 'wysiwyg' && ExRT.quill.editor) {
            const html = ExRT.quill.editor.root.innerHTML;
            let code;
            if (w.isMarkdown) { await this._ensureTurndown(); const td = new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }); code = td.turndown(html); }
            else code = html;
            w.mode = 'code';
            w.quillHtml = null;
            const m = ExRT.editor.models.get(w.id); if (m) m.setValue(code);
            this.$nextTick(() => { if (ExRT.editor.file) ExRT.editor.file.focus(); });
        }
    },

    async _getEditorContent() {
        const w = this.activeWin();
        if (w && w.kind === 'editor' && w.mode === 'wysiwyg' && ExRT.quill.editor) {
            const html = ExRT.quill.editor.root.innerHTML;
            if (w.isMarkdown) { await this._ensureTurndown(); const td = new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }); return td.turndown(html); }
            return html;
        }
        const m = w ? ExRT.editor.models.get(w.id) : null;
        if (m) return m.getValue();
        return w ? w.original : '';
    },

    async saveEditor(admin) {
        const w = this.activeWin();
        if (!w || w.kind !== 'editor' || w.readOnly || !w.path) return;
        // Once a file is known to be root-owned (opened as admin, or a prior
        // save hit permission-denied), keep writing through the bridge so the
        // user isn't bounced back to a failing normal save.
        const useAdmin = !!admin || !!w.needsAdmin;
        try {
            const content = await this._getEditorContent();
            await FS.writeText(w.path, content, { admin: useAdmin });
            w.original = content; w.dirty = false; w.error = ''; w.permissionDenied = false;
            if (useAdmin) w.needsAdmin = true;
            this.toast('Saved ' + w.path);
            const tab = this.activeTab();
            if (tab && tab.kind === 'dir' && Util.dirname(w.path) === tab.path) this.reload(tab);
        } catch (e) {
            if (!useAdmin && this._looksPermissionDenied(e)) {
                // Transparently retry through the superuser bridge, and keep
                // the file flagged so subsequent saves go straight to admin.
                w.needsAdmin = true; w.permissionDenied = true;
                return this.saveEditor(true);
            }
            w.error = e.message || String(e);
            if (this._looksPermissionDenied(e)) { w.permissionDenied = true; w.needsAdmin = true; }
        }
    },

    // ── Close / minimize windows ─────────────────────────────────────────
    closeActiveWindow() { if (this.activeWinId) this.closeWindow(this.activeWinId); },
    closeWindow(id) {
        const w = this._win(id);
        if (!w) return;
        if (w.kind === 'editor' && w.dirty) {
            this.askConfirm('Unsaved changes', 'Discard unsaved changes to ' + w.title + '?', 'Discard')
                .then(ok => { if (ok) this._removeWindow(id); });
            return;
        }
        this._removeWindow(id);
    },
    _removeWindow(id) {
        const w = this._win(id);
        if (!w) return;
        if (this._teardownPreviewVideo) this._teardownPreviewVideo(id); // stop any hls/ffmpeg (Task 5)
        const idx = this.windows.findIndex(x => x.id === id);
        const wasActive = (this.activeWinId === id);
        if (idx >= 0) this.windows.splice(idx, 1);
        if (wasActive) {
            this.activeWinId = this.windows.length
                ? this.windows[Math.min(idx, this.windows.length - 1)].id
                : null;
        }
        this.$nextTick(() => {
            // Point Monaco at the new active window first, then free resources.
            if (this.activeWinId) this._syncActiveEditor();
            if (w.kind === 'editor') {
                const m = ExRT.editor.models.get(id);
                if (m) {
                    if (ExRT.editor.file && ExRT.editor.file.getModel() === m) ExRT.editor.file.setModel(null);
                    try { m.dispose(); } catch (e) {}
                    ExRT.editor.models.delete(id);
                }
            } else if (w.pv && w.pv.url) {
                try { URL.revokeObjectURL(w.pv.url); } catch (e) {}
            }
            ExRT.preview.workbooks.delete(id);
            ExRT.preview.gen.delete(id);
            ExRT.video.gen.delete(id);
            // Closing a window can promote another one that still has a
            // deferred HLS session waiting to start.
            if (this.activeWinId && this._vpMaybeStart) this._vpMaybeStart(this.activeWinId);
            if (!this.activeWinId) {
                bootstrap.Modal.getOrCreateInstance(this.windowHostEl).hide();
                this.hostVisible = false;
            }
        });
    },
};
