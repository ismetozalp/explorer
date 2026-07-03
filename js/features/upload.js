// Upload, drag & drop, and archive (compress/extract). Extracted from
// app.js (2.0 modularization). Methods only; upload/DnD state stays in app.js.
window.ExplorerUpload = {
    uploadPrompt() {
        document.getElementById('uploadInput').click();
    },

    async onUploadFiles(ev) {
        const tab = this.currentPane();
        if (!tab) return;
        const fileList = Array.from(ev.target.files || []);
        ev.target.value = '';
        for (const f of fileList) await this._uploadOne(tab, f);
        this.reload(tab);
    },

    async _uploadOne(tab, file) {
        const dest = Util.joinPath(tab.path, file.name);
        const op = this._beginOp('Upload ' + file.name);
        try {
            await this._doUpload(op, dest, file, {});
            this._endOp(op, 'done');
        } catch (e) {
            console.error('Upload failed:', e, 'dest:', dest);
            this._failOp(op, e, () => this._doUpload(op, dest, file, { admin: true }));
        }
    },

    // Core single-file upload. Reads the File as base64 and streams it to
    // `base64 -d > dest`. Does NOT touch the op lifecycle (the caller owns
    // _endOp/_failOp) so it can be reused for the admin retry and for the
    // folder-tree uploader. opts.admin runs the channel as root; opts.silent
    // leaves op.statusText/indeterminate alone (the tree driver manages them).
    _doUpload(op, dest, file, opts) {
        opts = opts || {};
        if (!opts.silent) {
            op.indeterminate = true;
            op.statusText = `${Util.humanSize(file.size)}…`;
        }
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onerror = () => reject(new Error('Could not read ' + file.name));
            r.onload = () => {
                const s = r.result || '';
                const i = s.indexOf(',');
                const b64 = i >= 0 ? s.slice(i + 1) : s;
                const chanOpts = {
                    payload: 'stream',
                    spawn: ['sh', '-c', `base64 -d > ${Util.shq(dest)}`],
                    err: 'message',
                };
                if (opts.admin) chanOpts.superuser = 'require';
                const channel = cockpit.channel(chanOpts);
                ExRT.ops.set(op.id, 'cancel', () => { op._cancelled = true; try { channel.close('cancelled'); } catch (e) {} });
                op.canCancel = true;
                channel.addEventListener('close', (ev, info) => {
                    const problem = info && info.problem;
                    if (problem === 'cancelled') return reject(new Error('Cancelled'));
                    const status = info && info['exit-status'];
                    const msg = (info && info.message) || problem || '';
                    if (problem || (status != null && status !== 0)) {
                        const e = new Error(msg || ('base64 exit ' + status));
                        e.permissionDenied = /permission denied|eacces|cannot create|read-only/i.test(msg);
                        e.problem = problem;
                        return reject(e);
                    }
                    resolve();
                });
                channel.send(b64);
                channel.control({ command: 'done' });
            };
            r.readAsDataURL(file);
        });
    },

    // Map an image MIME type to a filename extension for pasted clipboard images.
    _clipImageExt(mime) {
        switch ((mime || '').toLowerCase()) {
            case 'image/png':     return 'png';
            case 'image/jpeg':    return 'jpg';
            case 'image/gif':     return 'gif';
            case 'image/webp':    return 'webp';
            case 'image/bmp':     return 'bmp';
            case 'image/svg+xml': return 'svg';
            default:              return 'png';
        }
    },

    // Upload a clipboard image Blob (already extracted in the browser) to the
    // remote clipboardUploadDir, then type its path + Enter into the given
    // terminal (→ tmux active pane → Claude). Cross-protocol: the Blob was
    // obtained by the caller from a paste event or clipboard read, so no secure
    // context is required here. Best-effort prune of old clip-* files first.
    async _uploadClipboardImageBlob(blob, termId) {
        if (!blob) return;
        const inst = ExRT.term.get(termId);
        if (!inst || !inst.channel) { this.toast('Terminal not ready for paste', 'warning'); return; }

        const dir = (this.settings.clipboardUploadDir || '/tmp/explorer-clip').replace(/\/+$/, '') || '/';
        const ext = this._clipImageExt(blob.type);
        const rand = Math.random().toString(36).slice(2, 8);
        const dest = Util.joinPath(dir, `clip-${Date.now()}-${rand}.${ext}`);

        const op = this._beginOp('Paste image');
        try {
            await FS.mkdir(dir);
            const hours = Number(this.settings.clipboardKeepHours);
            if (Number.isFinite(hours) && hours > 0) {
                const mins = Math.round(hours * 60);
                try {
                    await cockpit.spawn(
                        ['find', dir, '-maxdepth', '1', '-name', 'clip-*', '-type', 'f', '-mmin', '+' + mins, '-delete'],
                        { err: 'ignore' });
                } catch (e) { /* prune is best-effort */ }
            }
            await this._doUpload(op, dest, blob, {});
            this._endOp(op, 'done');
        } catch (e) {
            console.error('Clipboard image upload failed:', e, 'dest:', dest);
            this._failOp(op, e);
            this.toast('Could not save pasted image: ' + (e.message || e), 'danger');
            return;
        }

        try { inst.channel.send(dest + '\r'); } catch (e) {}
        try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(dest).catch(() => {}); } catch (e) {}
        this.toast('Pasted image → ' + dest, 'success');
    },

    // Toolbar entry point: read a clipboard image and hand it to the uploader.
    // HTTPS + permission → navigator.clipboard.read() (one click). Otherwise
    // (http, or a blocked read) → a small overlay that captures a Ctrl+V paste,
    // which exposes image data even on http.
    async pasteClipboardImageToTerminal(tab) {
        const termId = tab && tab.activeTermId;
        if (!termId || !ExRT.term.get(termId)) { this.toast('No active terminal', 'warning'); return; }

        if (navigator.clipboard && navigator.clipboard.read) {
            try {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                    const type = (item.types || []).find(t => t.startsWith('image/'));
                    if (type) {
                        const blob = await item.getType(type);
                        await this._uploadClipboardImageBlob(blob, termId);
                        return;
                    }
                }
                this.toast('No image found in clipboard', 'info');
                return;
            } catch (e) {
                // NotAllowedError / SecurityError (http or blocked) → modal fallback
            }
        }
        this._openPasteImageModal(termId);
    },

    // HTTP-safe fallback: a focused overlay that captures one paste event and
    // extracts an image from it. Built in plain DOM so it needs no Alpine state.
    _openPasteImageModal(termId) {
        const overlay = document.createElement('div');
        overlay.className = 'paste-img-overlay';
        overlay.innerHTML =
            '<div class="paste-img-box">' +
            '  <div class="paste-img-msg">Press Ctrl+V (⌘V) to paste your image here</div>' +
            '  <textarea class="paste-img-target" aria-label="Paste image here"></textarea>' +
            '  <div class="paste-img-hint">Esc to cancel</div>' +
            '</div>';
        document.body.appendChild(overlay);
        const target = overlay.querySelector('.paste-img-target');

        const close = () => {
            document.removeEventListener('keydown', onKey, true);
            try { overlay.remove(); } catch (e) {}
        };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
        document.addEventListener('keydown', onKey, true);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

        target.addEventListener('paste', (e) => {
            e.preventDefault();
            const items = (e.clipboardData && e.clipboardData.items) || [];
            for (const it of items) {
                if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
                    const blob = it.getAsFile();
                    close();
                    if (blob) this._uploadClipboardImageBlob(blob, termId);
                    return;
                }
            }
            this.toast('No image in the paste — nothing uploaded', 'info');
            close();
        });

        setTimeout(() => { try { target.focus(); } catch (e) {} }, 0);
    },

    // Recursively flatten a dropped FileSystemEntry tree into
    // { dirs:[path,…] (pre-order), files:[{file, dest},…] }.
    async _gatherEntry(entry, destDir, acc) {
        if (!entry) return;
        if (entry.isFile) {
            const file = await new Promise((res, rej) => entry.file(res, rej));
            acc.files.push({ file, dest: Util.joinPath(destDir, entry.name) });
        } else if (entry.isDirectory) {
            const dirPath = Util.joinPath(destDir, entry.name);
            acc.dirs.push(dirPath);
            const reader = entry.createReader();
            // readEntries yields at most ~100 entries per call — loop until empty.
            for (;;) {
                const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                if (!batch.length) break;
                for (const child of batch) await this._gatherEntry(child, dirPath, acc);
            }
        }
    },

    // Upload one or more dropped folders (and any loose files): recreate the
    // directory tree with `mkdir -p`, then stream each file under one op with
    // batch progress. Retries the whole batch as admin on permission errors.
    async _uploadEntries(pane, destDir, entries) {
        const label = entries.length === 1 ? entries[0].name : entries.length + ' items';
        const op = this._beginOp('Upload ' + label);
        op.indeterminate = true;
        op.statusText = 'Scanning…';
        op.canCancel = true;
        ExRT.ops.set(op.id, 'cancel', () => { op._cancelled = true; });
        const acc = { dirs: [], files: [] };
        try {
            for (const en of entries) {
                if (op._cancelled) throw new Error('Cancelled');
                await this._gatherEntry(en, destDir, acc);
            }
            const run = (admin) => this._doUploadTree(op, acc, { admin });
            try {
                await run(false);
                this._endOp(op, 'done');
            } catch (e) {
                if (e.message === 'Cancelled') this._failOp(op, e);
                else this._failOp(op, e, () => run(true));
            }
        } catch (e) {
            this._failOp(op, e);
        }
        this.reload(pane);
    },

    async _doUploadTree(op, acc, opts) {
        opts = opts || {};
        // Recreate directories first (acc.dirs is pre-order, so parents precede
        // children); mkdir -p is idempotent so re-running as admin is safe.
        op.indeterminate = true;
        op.statusText = acc.dirs.length ? 'Creating folders…' : '';
        const spawnOpts = opts.admin ? { superuser: 'require', err: 'message' } : { err: 'message' };
        for (const d of acc.dirs) {
            if (op._cancelled) throw new Error('Cancelled');
            await cockpit.spawn(['mkdir', '-p', d], spawnOpts);
        }
        // Then stream files, with done/total progress.
        op.indeterminate = false;
        const total = acc.files.length;
        let done = 0;
        for (const { file, dest } of acc.files) {
            if (op._cancelled) throw new Error('Cancelled');
            op.statusText = `${file.name} — ${done + 1}/${total}`;
            await this._doUpload(op, dest, file, { admin: opts.admin, silent: true });
            done++;
            op.progress = total ? Math.round((done / total) * 100) : 100;
        }
        op.indeterminate = false;
    },


    // ───── Drag & drop ───────────────────────────────────────────────────────
    onDragStart(ev, pane, file) {
        // Multiple selected: drag them all; else just this file.
        const paths = pane.selection.includes(file.path)
            ? pane.selection.slice()
            : [file.path];
        // For single-item drags remember name + whether it's a directory so
        // we can offer a rename and pick the right rsync trailing-slash form.
        const single = paths.length === 1
            ? { name: file.name, isDir: file.type === 'd' }
            : null;
        this.dragData = { paths, sourceTabId: this.activeTabId, sourcePane: pane, single };
        ev.dataTransfer.effectAllowed = 'copyMove';
        try { ev.dataTransfer.setData('text/x-explorer', JSON.stringify({ paths })); } catch(e){}
    },

    onDragOver(ev, pane) {
        // accept drops: external files (upload) or internal (move/copy)
        if (ev.dataTransfer.types.includes('Files') || this.dragData) {
            ev.dataTransfer.dropEffect = ev.ctrlKey || ev.altKey ? 'copy' : 'move';
            ev.currentTarget.classList.add('drag-over');
        }
    },

    // Folder rows are drop-into targets; highlight them and claim the event so
    // the pane wrapper doesn't also light up. Non-folder rows let the event
    // bubble to the wrapper (drop lands in the pane's current folder).
    onRowDragOver(ev, file) {
        if (!(ev.dataTransfer.types.includes('Files') || this.dragData)) return;
        const isDir = file.type === 'd' || (file.type === 'l' && file.symlinkTarget);
        if (!isDir) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.dropEffect = ev.ctrlKey || ev.altKey ? 'copy' : 'move';
        ev.currentTarget.classList.add('drag-over-row');
    },
    onRowDragLeave(ev) {
        ev.currentTarget.classList.remove('drag-over-row');
    },

    async onDrop(ev, pane, targetFile) {
        // Clear any drag highlights (the drop may have landed on a row, so the
        // pane wrapper's class won't be cleared by its own handler).
        document.querySelectorAll('.drag-over, .drag-over-row').forEach(el => el.classList.remove('drag-over', 'drag-over-row'));

        // Capture the drop payload SYNCHRONOUSLY — the DataTransfer and its
        // entries become invalid once this handler first awaits. webkitGetAsEntry
        // is the only way to see directories (dataTransfer.files drops them).
        let dropEntries = null;
        const dt = ev.dataTransfer;
        if (dt && dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === 'function') {
            dropEntries = [];
            for (let i = 0; i < dt.items.length; i++) {
                if (dt.items[i].kind === 'file') {
                    const en = dt.items[i].webkitGetAsEntry();
                    if (en) dropEntries.push(en);
                }
            }
        }
        const dropFiles = dt && dt.files ? Array.from(dt.files) : [];

        // Destination: dropping onto a *directory* row drops INTO that folder;
        // anywhere else (empty space, or a file row) lands in the pane's folder.
        const intoDir = targetFile && (targetFile.type === 'd' || (targetFile.type === 'l' && targetFile.symlinkTarget));
        const target = intoDir ? targetFile.path : pane.path;

        // From OS (upload).
        // If a folder was dropped (entry API), walk the tree and recreate it.
        if (dropEntries && dropEntries.some(en => en.isDirectory)) {
            await this._uploadEntries(pane, target, dropEntries);
            return;
        }
        // Plain file(s): one op each (existing behaviour).
        if (dropFiles.length) {
            const dst = { path: target };
            for (const f of dropFiles) await this._uploadOne(dst, f);
            this.reload(pane);
            return;
        }
        // A folder was dropped but the browser lacks the entry API.
        if (dt && dt.types && Array.prototype.includes.call(dt.types, 'Files')) {
            this.toast('Folder upload isn\'t supported in this browser', 'warning');
            return;
        }
        // Internal move/copy
        if (this.dragData && this.dragData.paths.length) {
            // Don't allow dropping the dragged folder onto itself.
            if (intoDir && this.dragData.paths.includes(target)) { this.dragData = null; return; }
            const single = this.dragData.single;
            // If source files are in a repo cache, force copy
            const fromCache = this.dragData.paths.some(p => this.insideAnyRepoCache(p));
            let result;
            if (fromCache) {
                if (!this._repoCacheCopyToastShown) {
                    this.toast('Files in a repo cache are copied rather than moved — keeps the cache intact. Edit and push the originals normally.', 'info');
                    this._repoCacheCopyToastShown = true;
                }
                // Still offer a rename for single items, but force copy.
                result = await this.askDropChoice(this.dragData.paths, target, single, true);
            } else {
                result = await this.askDropChoice(this.dragData.paths, target, single, false);
            }
            if (!result || !result.choice) { this.dragData = null; return; }
            const mode = result.choice === 'move' ? 'move' : 'copy';
            // Rename only applies to single-item drops with a changed name.
            const opts = {};
            if (single && result.name && result.name !== single.name) {
                opts.targetName = result.name;
                opts.singleIsDir = single.isDir;
            }
            const label = (single && opts.targetName)
                ? `${mode === 'move' ? 'Move' : 'Copy'} ${single.name} → ${target}/${opts.targetName}`
                : `${mode === 'move' ? 'Move' : 'Copy'} ${this.dragData.paths.length} item(s) → ${target}`;
            const op = this._beginOp(label);
            const srcs = this.dragData.paths.slice();
            const srcPane = this.dragData.sourcePane;
            try {
                await this._doCopyOrMove(op, srcs, target, mode, opts);
                this._endOp(op, 'done');
                if (srcPane && srcPane !== pane) this.reload(srcPane);
                this.reload(pane);
            } catch (e) {
                this._failOp(op, e, () => this._doCopyOrMove(op, srcs, target, mode, { ...opts, admin: true }));
            } finally {
                this.dragData = null;
            }
        }
    },

    askDropChoice(paths, target, single, forceCopy) {
        return new Promise(resolve => {
            this.dropChoice = {
                paths, target, resolve,
                single: single || null,
                forceCopy: !!forceCopy,
                name: single ? single.name : '',
            };
            bootstrap.Modal.getOrCreateInstance(this.dropChoiceModalEl).show();
        });
    },

    resolveDropChoice(choice) {
        const r = this.dropChoice.resolve;
        const name = (this.dropChoice.name || '').trim();
        this.dropChoice.resolve = null;
        bootstrap.Modal.getOrCreateInstance(this.dropChoiceModalEl).hide();
        if (r) r(choice ? { choice, name } : null);
    },


    // ───── Archive ───────────────────────────────────────────────────────────
    compressSelected() {
        const tab = this.currentPane();
        const sel = this.selectedFiles(tab);
        if (!sel.length) return;
        const baseName = sel.length === 1 ? sel[0].name : 'archive';
        this.compress = {
            paths: sel.map(f => f.path),
            name: baseName + '.zip',
            format: 'zip',
            dir: tab.path,
        };
        bootstrap.Modal.getOrCreateInstance(this.compressModalEl).show();
    },

    _archiveExtFor(fmt) {
        return ({ zip: '.zip', tar: '.tar', 'tar.gz': '.tar.gz', 'tar.bz2': '.tar.bz2', 'tar.xz': '.tar.xz' })[fmt] || '';
    },

    // Keep the archive name's extension in sync with the chosen format
    // (archive.zip → archive.tar.gz and back). Strips a known archive
    // extension (longest match first so .tar.gz isn't left as .tar) and
    // appends the new one.
    onCompressFormatChanged() {
        const known = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar', '.zip'];
        let base = String(this.compress.name || '').trim() || 'archive';
        const lower = base.toLowerCase();
        for (const e of known) {
            if (lower.endsWith(e)) { base = base.slice(0, base.length - e.length); break; }
        }
        this.compress.name = base + this._archiveExtFor(this.compress.format);
    },

    async doCompress() {
        const target = Util.joinPath(this.compress.dir, this.compress.name);
        const fmt = this.compress.format;
        const paths = this.compress.paths.slice();
        bootstrap.Modal.getOrCreateInstance(this.compressModalEl).hide();
        const op = this._beginOp(`Compress → ${this.compress.name}`);
        try {
            await FS.compress(paths, target, fmt);
            this._endOp(op, 'done');
            this.reload(this.currentPane());
        } catch (e) {
            this._failOp(op, e, () => FS.compress(paths, target, fmt, { admin: true }));
        }
    },

    async extractHere(file) {
        const target = Util.dirname(file.path);
        const op = this._beginOp('Extract ' + file.name);
        try {
            await FS.extract(file.path, target);
            this._endOp(op, 'done');
            this.reload(this.currentPane());
        } catch (e) {
            this._failOp(op, e, () => FS.extract(file.path, target, { admin: true }));
        }
    },

    async extractTo(file) {
        const base = Util.basename(file.path).replace(/\.(tar\.[a-z0-9]+|zip|tar|gz|bz2|xz)$/i, '');
        const parent = await this.askDirectory('Choose where to extract (a "' + base + '" subfolder will be created)', Util.dirname(file.path));
        if (!parent) return;
        const target = Util.joinPath(parent, base);
        const op = this._beginOp('Extract ' + file.name + ' → ' + target);
        try {
            await FS.extract(file.path, target);
            this._endOp(op, 'done');
            this.reload(this.currentPane());
        } catch (e) {
            this._failOp(op, e, () => FS.extract(file.path, target, { admin: true }));
        }
    },
};
