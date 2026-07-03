// GRUB boot-loader editor — extracted from app.js (2.0 modularization).
// Methods only; reactive state (this.grub) stays in app.js; shared
// non-reactive registries live on window.ExRT.
window.ExplorerGrub = {
    async _detectGrub() {
        try {
            const probe = await cockpit.spawn(['sh', '-c',
                'test -f /etc/default/grub && echo F; ' +
                'command -v update-grub >/dev/null 2>&1 && echo update-grub; ' +
                'command -v grub2-mkconfig >/dev/null 2>&1 && echo grub2-mkconfig; ' +
                'command -v grub-mkconfig >/dev/null 2>&1 && echo grub-mkconfig; ' +
                'command -v grubby >/dev/null 2>&1 && echo grubby; ' +
                'test -d /sys/firmware/efi && echo UEFI'], { err: 'message' });
            const lines = (probe || '').split('\n').map(s => s.trim());
            this.grub.isUefi = lines.includes('UEFI');
            this.grub.hasGrubby = lines.includes('grubby');
            this.grub.regenTool = lines.includes('update-grub') ? 'update-grub'
                : lines.includes('grub2-mkconfig') ? 'grub2-mkconfig'
                    : lines.includes('grub-mkconfig') ? 'grub-mkconfig' : '';
            this.grub.available = lines.includes('F') && !!this.grub.regenTool;
        } catch (e) { this.grub.available = false; }
    },

    // Output path for the *-mkconfig tools (update-grub needs none). Prefers
    // the Fedora/RHEL /etc/grub2*.cfg symlinks, then a UEFI EFI/<distro> path,
    // then the BIOS default.
    async _computeGrubOutPath() {
        if (this.grub.regenTool === 'update-grub') return '';
        const sym = this.grub.isUefi ? '/etc/grub2-efi.cfg' : '/etc/grub2.cfg';
        try {
            const out = await cockpit.spawn(['sh', '-c',
                `if [ -e ${sym} ]; then readlink -f ${sym}; ` +
                'elif [ -e /etc/grub2.cfg ]; then readlink -f /etc/grub2.cfg; ' +
                'elif ls /boot/efi/EFI/*/grub.cfg >/dev/null 2>&1; then ls /boot/efi/EFI/*/grub.cfg 2>/dev/null | head -1; ' +
                'elif [ -e /boot/grub2/grub.cfg ]; then echo /boot/grub2/grub.cfg; ' +
                'elif [ -e /boot/grub/grub.cfg ]; then echo /boot/grub/grub.cfg; ' +
                'else echo /boot/grub2/grub.cfg; fi'], { err: 'message' });
            return (out || '').split('\n')[0].trim();
        } catch (e) {
            return this.grub.isUefi ? '/boot/efi/EFI/grub.cfg' : '/boot/grub2/grub.cfg';
        }
    },

    _parseGrub(text) {
        const lines = (text || '').split('\n');
        const rows = [];
        let lead = [];
        for (const line of lines) {
            const t = line.trim();
            if (t === '' || t.startsWith('#') || !/^[A-Za-z0-9_]+=/.test(t)) { lead.push(line); continue; }
            const i = line.indexOf('=');
            rows.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1), _lead: lead });
            lead = [];
        }
        return { rows, trailer: lead };
    },

    _serializeGrub() {
        const out = [];
        for (const r of this.grub.rows) {
            for (const l of (r._lead || [])) out.push(l);
            out.push(`${(r.key || '').trim()}=${r.value == null ? '' : r.value}`);
        }
        for (const l of (this.grub.trailer || [])) out.push(l);
        return out.join('\n').replace(/\n*$/, '') + '\n';
    },

    _grubRegenCmd() {
        if (this.grub.regenTool === 'update-grub') return 'update-grub';
        return `${this.grub.regenTool || 'grub2-mkconfig'} -o ${this.grub.outPath || '/boot/grub2/grub.cfg'}`;
    },

    async openGrub() {
        this.grub.rawMode = false; this.grub.regenResult = ''; this.grub.error = '';
        if (!this.grub.outPath) this.grub.outPath = await this._computeGrubOutPath();
        await this.loadGrub();
        bootstrap.Modal.getOrCreateInstance(this.grubModalEl).show();
    },

    async loadGrub() {
        this.grub.loading = true; this.grub.error = '';
        try {
            let text = '';
            try { text = await FS.readText('/etc/default/grub', { adminTry: true }); } catch (e) { text = ''; }
            this.grub.raw = text;
            const parsed = this._parseGrub(text);
            this.grub.rows = parsed.rows;
            this.grub.trailer = parsed.trailer;
            this.grub.rawEdited = this._serializeGrub();
        } catch (e) {
            this.grub.error = e.message || String(e);
        } finally {
            this.grub.loading = false;
        }
    },

    addGrubRow() { this.grub.rows.push({ key: '', value: '', _lead: [] }); },
    removeGrubRow(i) { this.grub.rows.splice(i, 1); },

    toggleGrubRaw() {
        if (!this.grub.rawMode) {
            this.grub.rawEdited = this._serializeGrub();
            this.grub.rawMode = true;
        } else {
            const parsed = this._parseGrub(this.grub.rawEdited);
            this.grub.rows = parsed.rows; this.grub.trailer = parsed.trailer;
            this.grub.rawMode = false;
        }
    },

    async saveGrub() {
        const g = this.grub;
        const rows = g.rawMode ? this._parseGrub(g.rawEdited).rows : g.rows;
        const bad = rows.find(r => !/^[A-Za-z0-9_]+$/.test((r.key || '').trim()));
        if (bad) { g.error = `Invalid key "${(bad.key || '').trim()}" — keys look like GRUB_TIMEOUT.`; this.toast(g.error, 'warning'); return; }
        g.error = '';
        const text = g.rawMode ? (g.rawEdited.endsWith('\n') ? g.rawEdited : g.rawEdited + '\n') : this._serializeGrub();

        const regenCmd = this._grubRegenCmd();
        const ok = await this.askConfirm('Save and regenerate GRUB',
            `Write /etc/default/grub (backup to /etc/default/grub.bak) and regenerate the boot config with:  ${regenCmd}`, 'Save & regenerate');
        if (!ok) return;

        g.saving = true; g.regenResult = '';
        const op = this._beginOp('Save GRUB config');
        op.indeterminate = true;
        try {
            op.statusText = 'Backing up /etc/default/grub';
            await cockpit.spawn(['sh', '-c', 'cp -a /etc/default/grub /etc/default/grub.bak 2>/dev/null || true'], FS.spawnOpts({ admin: true }));
            op.statusText = 'Writing /etc/default/grub';
            await FS.writeText('/etc/default/grub', text, { admin: true });

            op.statusText = 'Regenerating boot config';
            let result = '';
            if (g.regenTool === 'update-grub') {
                result = await cockpit.spawn(['update-grub'], FS.spawnOpts({ admin: true }));
            } else {
                const tool = g.regenTool || 'grub2-mkconfig';
                result = await cockpit.spawn([tool, '-o', g.outPath || '/boot/grub2/grub.cfg'], FS.spawnOpts({ admin: true }));
            }

            // Opt-in: also push the kernel cmdline to already-installed kernels.
            if (g.applyGrubby && g.hasGrubby) {
                const cl = rows.filter(r => /^GRUB_CMDLINE_LINUX(_DEFAULT)?$/.test((r.key || '').trim()))
                    .map(r => (r.value || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
                    .join(' ').trim();
                if (cl) {
                    op.statusText = 'Applying cmdline with grubby';
                    try { await cockpit.spawn(['grubby', '--update-kernel=ALL', `--args=${cl}`], FS.spawnOpts({ admin: true })); }
                    catch (e) { result += '\n[grubby] ' + (e.message || e); }
                }
            }

            g.regenResult = (result || '').trim() || 'Done — boot config regenerated.';
            this._endOp(op, 'done');
            this.toast('GRUB config saved and regenerated.', 'success');
            await this.loadGrub();
        } catch (e) {
            this._failOp(op, e);
            g.error = e.message || String(e);
            this.toast('GRUB regenerate failed: ' + g.error.split('\n')[0], 'danger');
        } finally {
            g.saving = false;
        }
    },
};
