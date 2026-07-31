// Cockpit-plugin updater/installer. Lists the user's four plugins (Explorer,
// Cockpit Top, IF TV, Manifest), compares installed vs latest GitHub release,
// and updates/installs them. Reactive state lives in app.js (pluginUpd);
// descriptors + logic live here.
window.ExplorerPlugins = {
    // Static registry. Kept in a method (not reactive state) so the RegExps
    // never land in Alpine's reactive proxy. `settings.rel` is relative to home.
    _pluginDescriptors() {
        return [
            { key: 'explorer', label: 'Explorer', dir: 'explorer',
              settings: { rel: '.config/cockpit/explorer/settings.yml', fmt: 'yaml', repoKey: 'updateRepo' },
              defaultRepo: 'ismetozalp/explorer', assetRe: /^explorer-.*\.zip$/i },
            { key: 'ctop', label: 'Cockpit Top', dir: 'ctop',
              settings: null,
              defaultRepo: 'ismetozalp/ctop', assetRe: /^ctop-.*\.zip$/i },
            { key: 'iftv', label: 'IF TV', dir: 'inflighttv',
              settings: { rel: '.config/cockpit/inflighttv/settings.json', fmt: 'json', repoKey: 'updateRepo' },
              defaultRepo: 'ismetozalp/iftv', assetRe: /^inflighttv-.*\.zip$/i },
            { key: 'manifest', label: 'Manifest', dir: 'manifest',
              settings: { rel: '.config/cockpit/manifest/settings.yml', fmt: 'yaml', repoKey: 'update.repo' },
              defaultRepo: 'ismetozalp/manifest', assetRe: /^manifest-.*\.zip$/i },
        ];
    },

    // Dotted-path getter: _getByPath({update:{repo:'x'}}, 'update.repo') === 'x'
    _getByPath(obj, path) {
        if (!obj || !path) return undefined;
        return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    },

    // Repo from a parsed settings object, else the static default.
    _resolvePluginRepo(desc, obj) {
        const v = (desc.settings && obj) ? this._getByPath(obj, desc.settings.repoKey) : undefined;
        return (typeof v === 'string' && v.trim()) ? v.trim() : desc.defaultRepo;
    },

    _pluginStatus(current, latest) {
        if (!current) return 'unknown';
        if (!latest) return 'error';
        return this._versionNewer(latest, current) ? 'update' : 'uptodate';
    },

    // Eligible for update (not install): installed, has a target tag, and either
    // an update is available or force covers up-to-date/unknown.
    _pluginEligible(row, force) {
        return !!row.installed && !!row.tag &&
            (row.status === 'update' || (!!force && (row.status === 'uptodate' || row.status === 'unknown')));
    },

    _versionsFilePath() { return this.homePath + '/.config/cockpit/explorer/plugin-versions.json'; },

    async _readVersionsFile() {
        try { const t = await FS.readText(this._versionsFilePath()); return t ? (JSON.parse(t) || {}) : {}; }
        catch (e) { return {}; }
    },

    _pluginSettingsPath(desc) { return this.homePath + '/' + desc.settings.rel; },

    // First existing of the per-user then the system cockpit dir.
    async _resolvePluginInstallDir(desc) {
        const bases = [this.homePath + '/.local/share/cockpit', '/usr/share/cockpit'];
        for (const base of bases) {
            const dir = base + '/' + desc.dir;
            try { const st = await FS.statOne(dir); if (st) return { installed: true, base, dir }; }
            catch (e) { /* not here */ }
        }
        return { installed: false, base: '/usr/share/cockpit', dir: '/usr/share/cockpit/' + desc.dir };
    },

    // VERSION file, else the recorded fallback (IF TV has no VERSION file).
    async _readPluginVersion(desc, dir, versions) {
        try { const t = await FS.readText(dir + '/VERSION'); if (t && t.trim()) return t.trim(); }
        catch (e) { /* no VERSION */ }
        if (versions && versions[desc.key]) return versions[desc.key];
        return null;
    },

    // Repo from the plugin's own settings file (yaml/json), else static default.
    async _readPluginRepo(desc) {
        if (!desc.settings) return desc.defaultRepo;
        try {
            const txt = await FS.readText(this._pluginSettingsPath(desc));
            if (txt) {
                const obj = desc.settings.fmt === 'json'
                    ? JSON.parse(txt)
                    : (window.jsyaml ? jsyaml.load(txt) : null);
                return this._resolvePluginRepo(desc, obj);
            }
        } catch (e) { /* fall through to default */ }
        return desc.defaultRepo;
    },

    openPluginUpdater() {
        this.pluginUpd.rows = this._pluginDescriptors().map(d => ({
            key: d.key, label: d.label, dir: d.dir, repo: d.defaultRepo,
            installed: false, base: '/usr/share/cockpit',
            current: null, latest: null, tag: null,
            status: 'checking', busy: false, selected: false, message: '',
        }));
        this.pluginUpd.log = '';
        this.pluginUpd.finished = false;
        this.pluginUpd.open = true;
        bootstrap.Modal.getOrCreateInstance(this.pluginsModalEl).show();
        this.checkAllPlugins();
    },

    closePluginUpdater() {
        try { bootstrap.Modal.getOrCreateInstance(this.pluginsModalEl).hide(); } catch (e) {}
        this.pluginUpd.open = false;
    },

    async checkAllPlugins() {
        if (this.pluginUpd.checking) return;
        this.pluginUpd.checking = true;
        const versions = await this._readVersionsFile();
        const descs = this._pluginDescriptors();
        for (const row of this.pluginUpd.rows) {
            const desc = descs.find(d => d.key === row.key);
            row.status = 'checking'; row.message = '';
            try {
                const loc = await this._resolvePluginInstallDir(desc);
                row.installed = loc.installed; row.base = loc.base;
                row.current = loc.installed ? await this._readPluginVersion(desc, loc.dir, versions) : null;
                row.repo = await this._readPluginRepo(desc);
                const rel = await this._fetchLatestRelease(row.repo);
                if (!rel || !rel.version) { row.latest = null; row.tag = null; row.status = 'error'; row.message = 'no releases at ' + row.repo; continue; }
                row.latest = rel.version; row.tag = rel.tag;
                row.status = loc.installed ? this._pluginStatus(row.current, row.latest) : 'notinstalled';
            } catch (e) {
                row.status = 'error'; row.message = e.message || String(e);
            }
        }
        this.pluginUpd.checking = false;
    },

    _appendPluginLog(text) {
        this.pluginUpd.log += text;
        this.$nextTick(() => { const el = document.getElementById('pluginLog'); if (el) el.scrollTop = el.scrollHeight; });
    },

    async _recordPluginVersion(key, ver) {
        const obj = await this._readVersionsFile();
        obj[key] = ver;
        try { await FS.mkdir(Util.dirname(this._versionsFilePath())); } catch (e) { /* exists */ }
        await FS.writeText(this._versionsFilePath(), JSON.stringify(obj, null, 2));
    },

    // Privileged install, streamed into the log. make install if a Makefile is
    // present (Explorer/ctop/Manifest), else rsync/cp the tree into $DEST (IF TV).
    _installPluginZip(desc, srcDir, base) {
        return new Promise((resolve, reject) => {
            const dest = base + '/' + desc.dir;
            const script =
                'set -e; SRC=' + Util.shq(srcDir) + '; DEST=' + Util.shq(dest) + '; ' +
                'if [ -f "$SRC/Makefile" ]; then echo "installing via make…"; make -C "$SRC" install; ' +
                'else echo "installing via copy…"; mkdir -p "$DEST"; ' +
                'if command -v rsync >/dev/null 2>&1; then rsync -a --delete "$SRC"/ "$DEST"/; ' +
                'else cp -a "$SRC"/. "$DEST"/; fi; fi; echo "install done."';
            const channel = cockpit.channel({ payload: 'stream', spawn: ['sh', '-c', script], superuser: 'require', err: 'out' });
            let buf = '';
            channel.addEventListener('message', (ev, data) => {
                const t = typeof data === 'string' ? data : new TextDecoder().decode(data);
                buf += t; this._appendPluginLog(t);
            });
            channel.addEventListener('close', (ev, info) => {
                if (info && info.problem) return reject(new Error(info.message || info.problem));
                const st = info && info['exit-status'];
                if (st != null && st !== 0) {
                    const last = buf.trim().split('\n').pop() || '';
                    return reject(new Error('install exit ' + st + (last ? ': ' + last : '')));
                }
                resolve();
            });
        });
    },

    // Download + install one plugin. Works for update AND fresh install.
    async updatePlugin(row) {
        if (row.busy) return;
        const desc = this._pluginDescriptors().find(d => d.key === row.key);
        if (!desc) return;
        if (!row.tag) { row.message = 'No release to install'; return; }
        row.busy = true; this.pluginUpd.updating = true; row.message = '';
        this._appendPluginLog('\n=== ' + row.label + ' → ' + row.latest + ' (' + row.repo + ') ===\n');
        let work = null;
        try {
            this._appendPluginLog('downloading ' + desc.dir + '-' + row.latest + '.zip…\n');
            const zip = await this._downloadReleaseZip(row.repo, row.tag, desc.dir);
            work = Util.dirname(zip);
            this._appendPluginLog('unzipping…\n');
            await cockpit.spawn(['sh', '-c', 'unzip -oq ' + Util.shq(zip) + ' -d ' + Util.shq(work)], { err: 'message' });
            await this._installPluginZip(desc, work + '/' + desc.dir, row.base);
            await this._recordPluginVersion(row.key, row.latest);
            row.installed = true; row.current = row.latest; row.status = 'uptodate'; row.selected = false;
            this.pluginUpd.finished = true;
            this._appendPluginLog(row.label + ' installed/updated to ' + row.latest + '.\n');
        } catch (e) {
            row.status = 'error'; row.message = e.message || String(e);
            this._appendPluginLog('ERROR: ' + (e.message || e) + '\n');
        } finally {
            if (work) { try { await cockpit.spawn(['rm', '-rf', work], { err: 'ignore' }); } catch (e) {} }
            row.busy = false;
            if (!this.pluginUpd.rows.some(r => r.busy)) this.pluginUpd.updating = false;
        }
    },

    async updateAllPlugins() {
        const force = this.pluginUpd.force;
        const targets = this.pluginUpd.rows.filter(r => this._pluginEligible(r, force));
        if (!targets.length) { this.toast('Nothing to update.', 'info'); return; }
        for (const row of targets) await this.updatePlugin(row);
    },

    async installSelectedPlugins() {
        const targets = this.pluginUpd.rows.filter(r => r.status === 'notinstalled' && r.selected && r.tag);
        if (!targets.length) { this.toast('Select a not-installed plugin first.', 'info'); return; }
        for (const row of targets) await this.updatePlugin(row);
    },

    async restartCockpit() {
        const ok = await this.askConfirm(
            'Restart Cockpit',
            'This restarts the Cockpit service. Your current session will disconnect — wait a few seconds, then log back in.',
            'Restart');
        if (!ok) return;
        try {
            await cockpit.spawn(['sh', '-c', '(sleep 1; systemctl restart cockpit || systemctl restart cockpit.socket) >/dev/null 2>&1 &'],
                { superuser: 'require', err: 'message' });
            this.toast('Restarting Cockpit… reconnect in a few seconds.', 'info');
        } catch (e) {
            this.toast('Restart failed: ' + (e.message || e), 'danger');
        }
    },
};
