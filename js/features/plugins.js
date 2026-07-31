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
};
