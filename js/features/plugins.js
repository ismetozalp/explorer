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

    // Filled in Task 4. Stub keeps the modal functional meanwhile.
    async checkAllPlugins() {
        this.pluginUpd.checking = false;
    },
};
