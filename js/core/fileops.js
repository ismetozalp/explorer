// File operations (copy/cut/paste, rename, delete, new file/folder), download,
// and permissions. Core, extracted from app.js (2.0 modularization). Methods only.
window.ExplorerFileOps = {
    async openFile(tab, file) {
        if (file.type === 'd') {
            await this.navigate(tab, file.path);
        } else if (file.symlinkTarget && this.settings.followSymlinks) {
            // try to resolve & open
            const target = await FS.readlinkResolved(file.path);
            if (target) {
                const stat = await FS.statOne(target);
                if (stat && stat.type === 'd') { await this.navigate(tab, target); return; }
            }
            this.openPreview(file);
        } else {
            this.openPreview(file);
        }
    },

    openInNewTab(file) {
        if (!file || file.type !== 'd') return;
        const tab = this.newTab(file.path);
    },

    openSelected() {
        const tab = this.currentPane();
        const sel = this.selectedFiles(tab);
        if (sel.length === 1) this.openFile(tab, sel[0]);
        else sel.forEach(f => { if (f.type === 'd') this.newTab(f.path); else this.openPreview(f); });
    },

    async renameSelected() {
        const tab = this.currentPane();
        const sel = this.selectedFiles(tab);
        if (sel.length !== 1) return;
        const file = sel[0];
        const newName = await this.askPrompt('Rename', 'New name', file.name);
        if (!newName || newName === file.name) return;
        const newPath = Util.joinPath(Util.dirname(file.path), newName);
        const op = this._beginOp('Rename ' + file.name + ' → ' + newName);
        try {
            await FS.rename(file.path, newPath);
            this._endOp(op, 'done');
            this.reload(tab);
        } catch (e) {
            this._failOp(op, e);
        }
    },

    async deleteSelected() {
        const tab = this.currentPane();
        const sel = this.selectedFiles(tab);
        if (!sel.length) return;
        const ok = await this.askConfirm('Delete',
            `Permanently delete ${sel.length} item(s)?\n\n${sel.slice(0, 5).map(f => f.name).join('\n')}${sel.length > 5 ? '\n…' : ''}`,
            'Delete');
        if (!ok) return;
        const paths = sel.map(f => f.path);
        const op = this._beginOp(`Delete ${sel.length} item(s)`);
        op.indeterminate = true;
        op.statusText = 'Deleting…';
        // Use cockpit.channel directly with payload:'stream' + spawn — same
        // setup as rsync which is known to work in this cockpit. Earlier
        // attempts via cockpit.spawn() came back with problem:'cancelled'
        // immediately, even though we never called close.
        const run = (admin) => new Promise((resolve, reject) => {
            const chanOpts = {
                payload: 'stream',
                // -v emits one line per item ("removed 'x'" or
                // "removed directory 'x'") — used for the progress counter.
                spawn: ['rm', '-rfv', '--', ...paths],
                err: 'out',
            };
            if (admin) chanOpts.superuser = 'require';
            const channel = cockpit.channel(chanOpts);
            ExRT.ops.set(op.id, 'cancel', () => { try { channel.close('cancelled'); } catch (e) {} });
            op.canCancel = true;

            let fileCount = 0;
            let dirCount = 0;
            let lastItem = '';
            let buf = '';
            channel.addEventListener('message', (ev, data) => {
                const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
                buf += text;
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    if (!line) continue;
                    if (line.startsWith('removed directory ')) {
                        dirCount++;
                        let p = line.slice('removed directory '.length);
                        if (p.startsWith("'") && p.endsWith("'")) p = p.slice(1, -1);
                        lastItem = p;
                    } else if (line.startsWith('removed ')) {
                        fileCount++;
                        let p = line.slice('removed '.length);
                        if (p.startsWith("'") && p.endsWith("'")) p = p.slice(1, -1);
                        lastItem = p;
                    }
                    // Other lines (errors merged from stderr) are ignored
                    // for counting but stay visible in the channel buffer.
                }
                let s = `${fileCount} file${fileCount === 1 ? '' : 's'}, ${dirCount} folder${dirCount === 1 ? '' : 's'}`;
                if (lastItem) s += ` · ${Util.basename(lastItem)}`;
                op.statusText = s;
            });

            channel.addEventListener('close', (ev, info) => {
                if (info && info.problem === 'cancelled') return reject(new Error('Cancelled'));
                if (info && info.problem) {
                    const e = new Error(info.message || info.problem);
                    e.problem = info.problem;
                    e.permissionDenied = /permission denied|EACCES|access-denied/i.test(e.message + ' ' + (info.problem || ''));
                    return reject(e);
                }
                const status = info && info['exit-status'];
                if (status != null && status !== 0) return reject(new Error('rm exit ' + status));
                resolve();
            });
        });
        try {
            await run(false);
            this._endOp(op, 'done');
            this.reload(tab);
        } catch (e) {
            console.error('Delete failed:', e, 'paths:', paths);
            this._failOp(op, e, async () => {
                await run(true);
                this.reload(tab);
            });
        }
    },

    copyToClipboard(op) {
        const tab = this.currentPane();
        const sel = this.selectedFiles(tab);
        if (!sel.length) return;
        this.clipboard = { op: op, paths: sel.map(f => f.path) };
        this.toast(`${op === 'cut' ? 'Cut' : 'Copied'} ${sel.length} item(s)`);
    },

    /**
     * Copy or move {srcs[]} into {dest} with a running operation.
     *
     * Pre-flight:
     *   - Recursion trap: refuse if dest is a source or under a source
     *   - Disk space: best-effort du-sum vs df-avail, with confirm on shortage
     *     (time-boxed to 5s so huge trees don't block the start)
     * Execution:
     *   - rsync -a --info=progress2 --no-i-r (real progress, ETA, bytes/s)
     *   - Move: same-fs uses mv (instant rename); cross-fs uses
     *     rsync --remove-source-files + empty-dir sweep
     *   - Cancellation closes the channel (rsync exits, partial state remains)
     *   - Falls back to cp/mv (no progress) if rsync isn't installed
     *
     * Updates op.progress / op.statusText / op.cancel on the supplied op.
     */
    async _doCopyOrMove(op, srcs, dest, mode, opts) {
        opts = opts || {};
        srcs = srcs.slice();
        // 0. Rename-on-transfer: a single source going to dest/<targetName>.
        if (opts.targetName && srcs.length === 1) {
            return await this._doRenamedTransfer(op, srcs[0], Util.joinPath(dest, opts.targetName), mode, opts);
        }
        // 1. Recursion trap
        for (const s of srcs) {
            if (s === dest) throw new Error(`Cannot ${mode} "${s}" into itself`);
            if (dest === s + '/' || dest.startsWith(s + '/')) {
                throw new Error(`Cannot ${mode} into a subdirectory of itself:\n  ${s}\n  → ${dest}`);
            }
        }
        // 2. Disk-space pre-flight (best effort, capped at 5s). Skipped on ZFS:
        //    `du` there is a slow tree-walk and (with dest compression) can only
        //    over-warn — `df` governs the real write, returning ENOSPC if it
        //    truly runs out. `srcZfs` is reused by the rsync step below.
        const srcZfs = await FS.isZfs(Util.dirname(srcs[0]), opts).catch(() => false);
        op.statusText = 'Checking sizes…';
        if (!srcZfs) try {
            const sumPromise = (async () => {
                let total = 0;
                for (const s of srcs) total += await FS.duSum(s, opts);
                return total;
            })();
            const sized = await Promise.race([
                sumPromise,
                new Promise(r => setTimeout(() => r(null), 5000)),
            ]);
            if (sized != null) {
                const free = await FS.dfAvail(dest, opts);
                if (sized > free) {
                    const ok = await this.askConfirm('Not enough free space',
                        `Source size: ${Util.humanSize(sized)}\nDestination free: ${Util.humanSize(free)}\n\nContinue anyway?`,
                        'Continue');
                    if (!ok) throw new Error('Cancelled by user');
                }
            }
        } catch (e) {
            if (/Cancelled by user/.test(e.message)) throw e;
            // Pre-flight failures are not fatal — proceed without the check.
        }
        op.statusText = '';
        op.progress = 0;

        // 3. Fast-path: same-filesystem move
        if (mode === 'move' && this.rsyncAvailable === false) {
            // No rsync — plain mv (no progress)
            await FS.move(srcs, dest, opts);
            return;
        }
        if (mode === 'move') {
            const sameFs = await FS.sameFilesystem(srcs[0], dest, opts);
            if (sameFs) {
                op.statusText = 'Renaming (same filesystem)…';
                await FS.move(srcs, dest, opts);
                op.progress = 100;
                return;
            }
        }

        // 4. rsync path
        if (this.rsyncAvailable) {
            await this._runRsync(op, srcs, dest, mode, { ...opts, srcZfs });
            // Move: remove now-empty source dirs (rsync --remove-source-files
            // doesn't delete dirs).
            if (mode === 'move') {
                try {
                    const cleanupCmd = srcs.map(s => `find ${Util.shq(s)} -depth -type d -empty -delete`).join('; ');
                    await cockpit.spawn(['sh', '-c', cleanupCmd], FS.spawnOpts(opts));
                } catch (e) {}
            }
            return;
        }
        // 5. Fallback to cp (no progress)
        await FS.copy(srcs, dest, opts);
    },

    _runRsync(op, srcs, dest, mode, opts) {
        const destWithSlash = dest.endsWith('/') ? dest : dest + '/';
        const args = ['rsync', '-a', '--sparse', '--info=progress2', '--no-i-r'];
        if (opts.srcZfs) args.push('--exclude=.zfs/');
        if (mode === 'move') args.push('--remove-source-files');
        args.push('--', ...srcs, destWithSlash);
        return this._rsyncRun(op, args, opts);
    },

    // Transfer a single item to an explicit (possibly renamed) full target path.
    async _doRenamedTransfer(op, src, fullTarget, mode, opts) {
        if (src === fullTarget) throw new Error('Source and destination are the same');
        if (fullTarget === src + '/' || fullTarget.startsWith(src + '/')) {
            throw new Error(`Cannot ${mode} into a subdirectory of itself`);
        }
        // Overwrite check
        let exists = false;
        try { exists = !!(await FS.statOne(fullTarget, opts)); } catch (e) {}
        if (exists) {
            const ok = await this.askConfirm('Replace existing?',
                `"${Util.basename(fullTarget)}" already exists in the destination.\n\nReplace it?`, 'Replace');
            if (!ok) throw new Error('Cancelled by user');
            try { await FS.remove([fullTarget], opts); } catch (e) {}
        }
        op.progress = 0;

        // same-filesystem (or no rsync) move → mv -T rename, instant
        if (mode === 'move') {
            let sameFs = this.rsyncAvailable === false;
            if (!sameFs) { try { sameFs = await FS.sameFilesystem(src, Util.dirname(fullTarget), opts); } catch (e) {} }
            if (sameFs) {
                op.statusText = 'Renaming…';
                await FS.rename(src, fullTarget, opts);
                op.progress = 100;
                return;
            }
        }
        // rsync to the renamed target (cross-fs move, or copy with progress)
        if (this.rsyncAvailable) {
            await this._runRsyncRenamed(op, src, fullTarget, mode, opts.singleIsDir, opts);
            if (mode === 'move') {
                try { await cockpit.spawn(['sh', '-c', `find ${Util.shq(src)} -depth -type d -empty -delete`], FS.spawnOpts(opts)); } catch (e) {}
            }
            return;
        }
        // cp fallback (no progress)
        await FS.copyTo(src, fullTarget, opts);
        if (mode === 'move') { try { await FS.remove([src], opts); } catch (e) {} }
    },

    async _runRsyncRenamed(op, src, fullTarget, mode, isDir, opts) {
        // For a directory, trailing slashes on BOTH sides copy the contents
        // into the (new-named) target dir. For a file, no trailing slash.
        const s = isDir ? (src.endsWith('/') ? src : src + '/') : src;
        const t = isDir ? (fullTarget.endsWith('/') ? fullTarget : fullTarget + '/') : fullTarget;
        const srcZfs = await FS.isZfs(Util.dirname(src), opts).catch(() => false);
        const args = ['rsync', '-a', '--sparse', '--info=progress2', '--no-i-r'];
        if (srcZfs) args.push('--exclude=.zfs/');
        if (mode === 'move') args.push('--remove-source-files');
        args.push('--', s, t);
        return this._rsyncRun(op, args, opts);
    },

    _rsyncRun(op, args, opts) {
        return new Promise((resolve, reject) => {
            const chanOpts = { payload: 'stream', spawn: args, err: 'out' };
            if (opts.admin) chanOpts.superuser = 'require';
            const channel = cockpit.channel(chanOpts);
            ExRT.ops.set(op.id, 'cancel', () => { try { channel.close('cancelled'); } catch(e){} });
            op.canCancel = true;
            let buf = '';
            channel.addEventListener('message', (ev, data) => {
                const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
                buf += text;
                const lines = buf.split(/[\r\n]+/);
                buf = lines.pop() || '';
                for (const line of lines) {
                    const m = line.match(/(\d[\d,]*)\s+(\d+)%\s+(\S+)\s+(\d+:\d+:\d+)/);
                    if (m) {
                        op.progress = parseInt(m[2], 10);
                        op.statusText = `${m[2]}% · ${m[3]} · ETA ${m[4]}`;
                    }
                }
            });
            channel.addEventListener('close', (ev, props) => {
                if (props.problem === 'cancelled') return reject(new Error('Cancelled'));
                if (props.problem) return reject(new Error(props.message || props.problem));
                const status = props['exit-status'];
                if (status === 0 || status === 24) { op.progress = 100; resolve(); }
                else reject(new Error('rsync exit ' + status));
            });
        });
    },

    async paste() {
        if (!this.clipboard.paths.length) return;
        const tab = this.currentPane();
        const dest = tab.path;
        const mode = this.clipboard.op === 'cut' ? 'move' : 'copy';
        const paths = this.clipboard.paths.slice();

        // ── Single item → ask for the name it should have in the destination.
        // Default is the original name, except a copy landing in the SAME
        // folder defaults to a non-colliding "<name>-new".
        if (paths.length === 1) {
            const opts = {};
            const src = paths[0];
            const origName = Util.basename(src);
            let isDir = false;
            try { const st = await FS.statOne(src); isDir = !!(st && st.type === 'd'); } catch (e) {}
            const sameDir = Util.dirname(src) === dest;
            let def = origName;
            if (mode === 'copy' && sameDir) def = await this._newSuffixName(dest, origName, isDir);

            const name = await this.askPrompt(
                mode === 'move' ? 'Move as…' : 'Paste as…',
                'Name in ' + dest, def);
            if (!name) return; // cancelled

            let finalName = name;
            if (mode === 'copy' && sameDir && name === origName) {
                finalName = await this._newSuffixName(dest, origName, isDir);
            }
            if (finalName !== origName) { opts.targetName = finalName; opts.singleIsDir = isDir; }

            const label = opts.targetName
                ? `${mode === 'move' ? 'Move' : 'Copy'} ${origName} → ${dest}/${opts.targetName}`
                : `${mode === 'move' ? 'Move' : 'Copy'} ${origName} → ${dest}`;
            const op = this._beginOp(label);
            try {
                await this._doCopyOrMove(op, paths, dest, mode, opts);
                this._endOp(op, 'done');
                if (mode === 'move') this.clipboard = { op: null, paths: [] };
                this.reload(tab);
            } catch (e) {
                this._failOp(op, e, () => this._doCopyOrMove(op, paths, dest, mode, { ...opts, admin: true }));
            }
            return;
        }

        // ── Multiple items → keep their names, but any that would collide in
        // the destination get a "-new" suffix (something.zip → something-new.zip,
        // folder something → something-new) so nothing is clobbered.
        const plain = [];                 // srcs that keep their name
        const renames = [];               // { src, targetName, isDir }
        for (const src of paths) {
            const origName = Util.basename(src);
            let collides = false;
            try { collides = !!(await FS.statOne(Util.joinPath(dest, origName))); } catch (e) {}
            if (!collides) { plain.push(src); continue; }
            let isDir = false;
            try { const st = await FS.statOne(src); isDir = !!(st && st.type === 'd'); } catch (e) {}
            renames.push({ src, targetName: await this._newSuffixName(dest, origName, isDir), isDir });
        }

        const op = this._beginOp(`${mode === 'move' ? 'Move' : 'Copy'} ${paths.length} item(s) → ${dest}`);
        const run = async (admin) => {
            if (plain.length) await this._doCopyOrMove(op, plain, dest, mode, admin ? { admin: true } : {});
            for (const r of renames) {
                await this._doRenamedTransfer(op, r.src, Util.joinPath(dest, r.targetName), mode,
                    { singleIsDir: r.isDir, admin: !!admin });
            }
        };
        try {
            await run(false);
            this._endOp(op, 'done');
            if (mode === 'move') this.clipboard = { op: null, paths: [] };
            this.reload(tab);
        } catch (e) {
            this._failOp(op, e, () => run(true));
        }
    },

    // Non-colliding "<name>-new1" (then -new2, -new3, …). For files the
    // suffix is inserted before the extension; folders just get it appended.
    async _newSuffixName(dir, name, isDir) {
        let base = name, ext = '';
        if (!isDir) {
            const dot = name.lastIndexOf('.');
            if (dot > 0) { base = name.slice(0, dot); ext = name.slice(dot); }
        }
        const exists = async (n) => {
            try { return !!(await FS.statOne(Util.joinPath(dir, n))); } catch (e) { return false; }
        };
        let i = 1;
        while (await exists(base + '-new' + i + ext)) i++;
        return base + '-new' + i + ext;
    },

    async newFolderPrompt() {
        const tab = this.currentPane();
        const name = await this.askPrompt('New folder', 'Folder name', 'New folder');
        if (!name) return;
        const target = Util.joinPath(tab.path, name);
        try {
            await FS.mkdir(target);
            this.reload(tab);
        } catch (e) {
            const op = this._beginOp('Create folder ' + name);
            this._failOp(op, e, () => FS.mkdir(target, { admin: true }));
        }
    },

    async newFilePrompt() {
        const tab = this.currentPane();
        const name = await this.askPrompt('New file', 'File name', 'untitled.txt');
        if (!name) return;
        const target = Util.joinPath(tab.path, name);
        try {
            await FS.touch(target);
            this.reload(tab);
        } catch (e) {
            const op = this._beginOp('Create file ' + name);
            this._failOp(op, e, () => FS.touch(target, { admin: true }));
        }
    },


    // ───── Permissions ──────────────────────────────────────────────────────
    async propertiesSelected() {
        const sel = this.selectedFiles();
        if (sel.length !== 1) return;
        const file = sel[0];

        // Parse the file's ls-style perms string (10 chars, e.g. "-rwxr-xr--")
        const perms = file.perms || '----------';
        const toAccess = (triplet) => {
            const r = triplet[0] === 'r';
            const w = triplet[1] === 'w';
            if (r && w) return 'rw';
            if (r) return 'r';
            return 'none';
        };
        const o = perms.slice(1, 4), g = perms.slice(4, 7), x = perms.slice(7, 10);
        // "Set executable" is on if any of the three has x (or s/t variants)
        const anyExec = /[xsSt]/.test(o[2]) || /[xsSt]/.test(g[2]) || /[xsSt]/.test(x[2]);

        // Build user/group lists, ensuring the file's owner/group are present
        const users = (this._cachedUsers && this._cachedUsers.length) ? this._cachedUsers.slice() : [];
        const groups = (this._cachedGroups && this._cachedGroups.length) ? this._cachedGroups.slice() : [];
        if (file.owner && !users.includes(file.owner)) users.unshift(file.owner);
        if (file.group && !groups.includes(file.group)) groups.unshift(file.group);

        this.props = {
            file,
            owner: file.owner,
            group: file.group,
            access: { owner: toAccess(o), group: toAccess(g), others: toAccess(x) },
            executable: anyExec,
            selinux: '',
            userList: users,
            groupList: groups,
        };

        bootstrap.Modal.getOrCreateInstance(this.propsModalEl).show();

        // SELinux context (best-effort; shown as read-only)
        try {
            const out = await cockpit.spawn(['stat', '-c', '%C', file.path], { err: 'ignore' });
            const ctx = (out || '').trim();
            if (ctx && ctx !== '?') this.props.selinux = ctx;
        } catch (e) {}
    },

    _accessToBits(a) { return a === 'rw' ? 6 : a === 'r' ? 4 : 0; },

    _permsToOctal(perms) {
        if (!perms || perms.length < 10) return '';
        const t = (s) => (s[0] === 'r' ? 4 : 0) + (s[1] === 'w' ? 2 : 0) + (/[xsSt]/.test(s[2]) ? 1 : 0);
        return '' + t(perms.slice(1, 4)) + t(perms.slice(4, 7)) + t(perms.slice(7, 10));
    },

    // Compute the target octal mode from the dialog's current state.
    // For directories, x is added wherever r is set (otherwise the directory
    // is unenterable). For files, x is added wherever r is set if the
    // "executable" checkbox is on.
    propsOctal() {
        if (!this.props.file) return '';
        let o = this._accessToBits(this.props.access.owner);
        let g = this._accessToBits(this.props.access.group);
        let x = this._accessToBits(this.props.access.others);
        const wantsX = (this.props.file.type === 'd') || this.props.executable;
        if (wantsX) {
            if (o & 4) o |= 1;
            if (g & 4) g |= 1;
            if (x & 4) x |= 1;
        }
        return '' + o + g + x;
    },

    async applyProperties() {
        const f = this.props.file;
        if (!f) return;
        const newOctal = this.propsOctal();
        const newOwnerGroup = `${this.props.owner}:${this.props.group}`;
        const oldOwnerGroup = `${f.owner}:${f.group}`;
        const ops = [];
        if (newOctal && newOctal !== this._permsToOctal(f.perms)) {
            ops.push(['chmod', (opts) => FS.chmod(f.path, newOctal, opts)]);
        }
        if (newOwnerGroup !== oldOwnerGroup) {
            ops.push(['chown', (opts) => FS.chown(f.path, newOwnerGroup, opts)]);
        }
        for (const [name, fn] of ops) {
            try { await fn(); }
            catch (e) {
                try { await fn({ admin: true }); }
                catch (e2) { this.toast(name + ' failed: ' + (e2.message || e2), 'danger'); return; }
            }
        }
        bootstrap.Modal.getOrCreateInstance(this.propsModalEl).hide();
        const tab = this.currentPane();
        if (tab) this.reload(tab);
    },


    // ───── Download ──────────────────────────────────────────────────────────
    async downloadSelected() {
        const tab = this.currentPane();
        const sel = this.selectedFiles(tab);
        if (!sel.length) return;
        if (sel.length === 1 && sel[0].type === 'f') {
            const sz = sel[0].size || 0;
            if (sz > 500 * 1024 * 1024) {
                const ok = await this.askConfirm('Large download',
                    `File is ${Util.humanSize(sz)}. The browser will hold the whole file in memory before saving — very large files may exhaust browser memory. For >2 GB transfers, scp/sftp is generally safer. Continue?`,
                    'Continue');
                if (!ok) return;
            }
            const op = this._beginOp('Download ' + sel[0].name);
            try {
                const blob = await FS.readBinaryAsBlob(sel[0].path);
                this._triggerDownload(blob, sel[0].name);
                this._endOp(op, 'done');
            } catch (e) {
                this._failOp(op, e, () => FS.readBinaryAsBlob(sel[0].path, { admin: true }).then(b => { this._triggerDownload(b, sel[0].name); }));
            }
            return;
        }
        // Multi-file: pick a format from a dropdown, compress to /tmp, download.
        // Rough size estimate from listed file sizes (dirs unknown).
        const roughTotal = sel.reduce((s, f) => s + (f.type === 'f' ? f.size : 0), 0);
        if (roughTotal > 1024 * 1024 * 1024) {
            const ok = await this.askConfirm('Large download',
                `Selection contains ~${Util.humanSize(roughTotal)} of files (directories not measured). Compressing and streaming this through the browser will use a lot of memory and may take a while. For very large transfers, scp/sftp is generally safer. Continue?`,
                'Continue');
            if (!ok) return;
        }
        this.downloadArc = {
            paths: sel.map(f => f.path),
            format: this.downloadArc.format || 'tar.gz',
            count: sel.length,
        };
        bootstrap.Modal.getOrCreateInstance(this.downloadArcModalEl).show();
    },

    // Compress the chosen selection to a temp archive and stream it to the
    // browser. Driven by the download-format dropdown (#downloadArcModal).
    async doDownloadArchive() {
        const fmt = this.downloadArc.format;
        const paths = this.downloadArc.paths.slice();
        const allowed = ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz'];
        if (!allowed.includes(fmt) || !paths.length) return;
        bootstrap.Modal.getOrCreateInstance(this.downloadArcModalEl).hide();
        const tmp = `/tmp/explorer-${Util.uid()}.${fmt}`;
        const op = this._beginOp(`Compress ${paths.length} item(s) for download`);
        try {
            await FS.compress(paths, tmp, fmt);
            const blob = await FS.readBinaryAsBlob(tmp);
            this._triggerDownload(blob, `download.${fmt}`);
            try { await FS.remove([tmp]); } catch (e) {}
            this._endOp(op, 'done');
        } catch (e) {
            const msg = e.message || String(e);
            // `zip` is a separate package and frequently missing on servers;
            // tar.gz only needs tar+gzip which are virtually always present.
            const hint = (fmt === 'zip' && /not found|ENOENT|No such file|not-found/i.test(msg))
                ? ' — "zip" may not be installed; try tar.gz instead.' : '';
            this.toast('Download failed: ' + msg + hint, 'danger');
            this._failOp(op, new Error(msg + hint));
            try { await FS.remove([tmp]); } catch (_) {}
        }
    },

    _triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    },


};
