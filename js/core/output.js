// Streaming-output panes (line storage, memory cap, auto-scroll/Follow), the
// operations tray (_beginOp/_endOp/_failOp/retryAsAdmin/…), and Run command.
// Core, extracted from app.js (2.0 modularization). Methods only.
window.ExplorerOutput = {
    // Cap a pane's stored lines to settings.outputMaxLines (0 = unlimited),
    // dropping the oldest.
    _capOutput(rtab) {
        const max = this.settings.outputMaxLines || 0;
        if (max > 0 && rtab.outputLines.length > max) {
            rtab.outputLines.splice(0, rtab.outputLines.length - max);
        }
    },
    // Feed a raw chunk (may contain 0+ newlines / a partial line) into a pane,
    // emitting complete lines. Holds the trailing partial line in rtab._outBuf.
    _feedOutput(rtab, chunk) {
        rtab._outBuf = (rtab._outBuf || '') + chunk;
        let idx;
        while ((idx = rtab._outBuf.indexOf('\n')) >= 0) {
            rtab.outputLines.push(rtab._outBuf.slice(0, idx));
            rtab._outBuf = rtab._outBuf.slice(idx + 1);
        }
        this._capOutput(rtab);
    },
    // Flush any trailing partial line (call on channel close).
    _flushOutput(rtab) {
        if (rtab._outBuf) { rtab.outputLines.push(rtab._outBuf); rtab._outBuf = ''; this._capOutput(rtab); }
    },
    // Append one complete line directly (for prompt transcripts / messages).
    _pushOutputLine(rtab, line) {
        rtab.outputLines.push(line);
        this._capOutput(rtab);
    },

    // ── Streaming-pane auto-scroll ("Follow") ────────────────────────────────
    // Wire a streaming output pane's scroll handling. The listener only reacts to
    // REAL user scrolls: while output streams we auto-scroll to the bottom, and
    // neither those programmatic scrolls nor the transient geometry mid-append
    // (content already grew, scrollTop hasn't caught up) must be mistaken for the
    // user scrolling away — that false toggle is what broke Follow on fast tails
    // (e.g. `podman-compose logs`). We ignore 'scroll' events inside a short guard
    // window that each auto-scroll refreshes, so a flood keeps Follow pinned; once
    // output settles the window lapses and manual scroll-up disengages it again.
    _initOutputPane(el, rtab) {
        el.addEventListener('scroll', () => {
            if (rtab._autoScrollUntil && Date.now() < rtab._autoScrollUntil) return;
            rtab.follow = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;
        }, { passive: true });
        if (rtab.follow) this._scheduleOutputScroll(el, rtab);
    },

    // Coalesce scroll-to-bottom to at most once per animation frame (so a burst
    // of lines doesn't thrash layout and fall behind), and open the guard window
    // right before scrolling so the resulting event isn't read back as a gesture.
    _scheduleOutputScroll(el, rtab) {
        if (rtab._scrollRaf) return;
        rtab._scrollRaf = requestAnimationFrame(() => {
            rtab._scrollRaf = 0;
            if (!rtab.follow) return;
            rtab._autoScrollUntil = Date.now() + 250;
            el.scrollTop = el.scrollHeight;
        });
    },

    async _runActionCmd(action, cmd, files) {
        const adminFlag = action.privilege === 'require' ? { admin: true }
                       : action.privilege === 'try' ? { adminTry: true }
                       : {};
        const label = files.length ? `${action.label} (${files.map(f => f.name).join(', ')})` : (action.label || 'action');

        if (action.output === 'pane') {
            // Open a new tab with streaming output
            const tab = this._buildTab('/', 'output');
            tab.outputActionLabel = action.label;
            tab.outputCommand = cmd;
            tab.outputStatus = 'running';
            this.tabs.push(tab);
            this.activeTabId = tab.id;
            // Mutate the reactive proxy, not the raw ref (see installGh).
            const rtab = this.tabs.find(t => t.id === tab.id) || tab;
            const channel = cockpit.channel({
                payload: 'stream',
                spawn: ['sh', '-c', cmd],
                ...FS.spawnOpts(adminFlag),
                err: 'out',
            });
            rtab.outputChannel = channel;
            channel.addEventListener('message', (ev, data) => {
                this._feedOutput(rtab, typeof data === 'string' ? data : new TextDecoder().decode(data));
            });
            channel.addEventListener('close', (ev, opts) => {
                this._flushOutput(rtab);
                rtab.outputStatus = opts.problem ? ('error: ' + (opts.message || opts.problem))
                                                 : ('done (exit ' + (opts['exit-status'] ?? 0) + ')');
                rtab.outputChannel = null;
            });
            return;
        }

        const op = this._beginOp(label);
        if (action.output === 'tray' || action.output === 'modal') {
            op.outputBuffer = '';
        }
        try {
            const proc = cockpit.spawn(['sh', '-c', cmd], { ...FS.spawnOpts(adminFlag), err: 'out' });
            ExRT.ops.set(op.id, 'cancel', () => { try { proc.close('cancelled'); } catch(e){} });
            op.canCancel = true;
            proc.stream(data => { if (op.outputBuffer != null) op.outputBuffer += data; });
            const result = await proc;
            this._endOp(op, 'done');
            if (action.output === 'modal') {
                this.openTextPreview(action.label, op.outputBuffer || '(no output)');
            } else if (action.output === 'toast') {
                this.toast(action.label + ' finished');
            }
        } catch (e) {
            this._failOp(op, e);
            if (action.output === 'modal') {
                this.openTextPreview(action.label + ' (error)', (op.outputBuffer || '') + '\n\n' + (e.message || e));
            } else if (action.output === 'toast') {
                this.toast(action.label + ' failed: ' + (e.message || e), 'danger');
            }
        }
    },


    // ───── Operations tray ───────────────────────────────────────────────────
    // Mounts (fstab/SMB/NFS) methods → js/features/mounts.js

    // GRUB editor methods → js/features/grub.js

    _beginOp(label) {
        const op = {
            id: this.nextOpSeq++,
            label,
            status: 'running',
            statusText: '',
            progress: 0,
            indeterminate: false,
            canCancel: false,
            canRetryAsAdmin: false,
            outputBuffer: null,
            outputPaneId: null,
        };
        this.operations.push(op);
        // Return the reactive proxy (see comment) so plain-property mutations
        // (statusText, progress, status, …) trigger UI updates. Callbacks
        // (cancel, retryAsAdmin) are stored separately in ExRT.ops.cbs and
        // never touch the proxy.
        return this.operations[this.operations.length - 1];
    },

    cancelOp(op) {
        const fn = ExRT.ops.get(op.id, 'cancel');
        if (fn) try { fn(); } catch (e) { console.error('cancel failed:', e); }
    },

    _endOp(op, status) {
        op.status = status || 'done';
        op.progress = 100;
        op.canCancel = false;
        // auto-clear after a few seconds
        setTimeout(() => {
            const idx = this.operations.findIndex(o => o.id === op.id);
            if (idx >= 0 && this.operations[idx].status === 'done') {
                ExRT.ops.clear(op.id);
                this.operations.splice(idx, 1);
            }
        }, 4000);
    },

    _failOp(op, err, retryAsAdminFn) {
        op.status = 'error';
        op.statusText = err.message || String(err);
        op.canCancel = false;
        if (retryAsAdminFn && (err.permissionDenied || /permission|EACCES/i.test(err.message || ''))) {
            op.canRetryAsAdmin = true;
            ExRT.ops.set(op.id, 'retryAsAdmin', retryAsAdminFn);
        }
    },

    async retryAsAdmin(op) {
        const fn = ExRT.ops.get(op.id, 'retryAsAdmin');
        if (!fn) return;
        op.status = 'running';
        op.statusText = '';
        op.canCancel = true;
        try {
            await fn();
            this._endOp(op, 'done');
            this.reload(this.currentPane());
        } catch (e) {
            this._failOp(op, e);
        }
    },

    clearFinishedOperations() {
        // remove finished ops AND their callbacks
        const keep = [];
        for (const o of this.operations) {
            if (o.status === 'running') keep.push(o);
            else ExRT.ops.clear(o.id);
        }
        this.operations = keep;
    },


    // ─── RUN COMMAND ─────────────────────────────────────────────────────────
    openRunCommand(tab) {
        this.runCmd = {
            cwd: tab.path,
            shell: this.settings.defaultShell || this.shells[0],
            command: '',
            admin: false,
        };
        bootstrap.Modal.getOrCreateInstance(this.runCmdModalEl).show();
    },

    doRunCommand() {
        const cmd = this.runCmd.command.trim();
        if (!cmd) return;
        const shell = this.runCmd.shell;
        const cwd = this.runCmd.cwd;
        const admin = this.runCmd.admin;
        bootstrap.Modal.getOrCreateInstance(this.runCmdModalEl).hide();

        const tab = this._buildTab('/', 'output');
        tab.outputActionLabel = `${shell} -c (${Util.basename(cwd) || '/'})`;
        tab.outputCommand = `cd ${Util.shq(cwd)} && ${cmd}`;
        tab.outputStatus = 'running';
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        // Mutate the reactive proxy, not the raw ref (see installGh).
        const rtab = this.tabs.find(t => t.id === tab.id) || tab;

        const opts = { err: 'out' };
        if (admin) opts.superuser = 'require';
        const channel = cockpit.channel({
            payload: 'stream',
            spawn: [shell, '-c', `cd ${Util.shq(cwd)} && ${cmd}`],
            ...opts,
        });
        rtab.outputChannel = channel;
        channel.addEventListener('message', (ev, data) => {
            this._feedOutput(rtab, typeof data === 'string' ? data : new TextDecoder().decode(data));
        });
        channel.addEventListener('close', (ev, props) => {
            this._flushOutput(rtab);
            rtab.outputStatus = props.problem ? ('error: ' + (props.message || props.problem))
                                              : ('done (exit ' + (props['exit-status'] ?? 0) + ')');
            rtab.outputChannel = null;
        });
    },

};
