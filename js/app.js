// app.js — Alpine.js component for the explorer
'use strict';

document.addEventListener('alpine:init', () => {


Alpine.data('explorer', () => ({
    ...window.ExplorerGrub,   // js/features/grub.js
    ...window.ExplorerMounts,  // js/features/mounts.js
    ...window.ExplorerGithub,  // js/features/github.js
    ...window.ExplorerActions,  // js/features/actions.js
    ...window.ExplorerTerminal,  // js/features/terminal.js
    ...window.ExplorerUpload,  // js/features/upload.js
    ...window.ExplorerEditor,  // js/features/editor.js
    ...window.ExplorerTabs,      // js/core/tabs.js
    ...window.ExplorerFileList,  // js/core/filelist.js
    ...window.ExplorerFileOps,   // js/core/fileops.js
    ...window.ExplorerOutput,    // js/core/output.js
    ...window.ExplorerDialogs,   // js/core/dialogs.js
    ...window.ExplorerSettings,  // js/core/settings.js

    // ───── State ─────────────────────────────────────────────────────────────
    tabs: [],
    activeTabId: null,
    homePath: '/root',

    settings: structuredClone(ExRT.const.DEFAULT_SETTINGS),

    // Self-update / release-check state
    updateState: { checking: false, available: null, deleteSettings: false },

    customActions: { user: [], system: [], builtin: [] },

    operations: [],
    nextOpSeq: 1,

    clipboard: { op: null, paths: [] }, // op = 'copy' | 'cut'

    ctxMenu: { open: false, x: 0, y: 0, kind: null, target: null, tabId: null },

    // ── Multi-window state (preview + editor popups) ──────────────────────
    // `windows` holds every open preview/editor session. One is "active"
    // (shown in the single host modal); the taskbar switches between them.
    windows: [],
    activeWinId: null,
    hostVisible: false,
    hostMaximized: false,
    _winSeq: 1,
    // Windows-style window-control glyphs.
    winIconMinimize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 8 H9" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>',
    winIconMaximize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.75" y="0.75" width="8.5" height="8.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    winIconRestore: '<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><rect x="0.75" y="2.75" width="6.5" height="6.5" fill="none" stroke="currentColor" stroke-width="1"/><path d="M3 2.75 V0.75 H9.25 V7 H7.25" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    winIconClose: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>',
    windowHostEl: null,

    props: {
        file: null,
        owner: '',
        group: '',
        access: { owner: 'r', group: 'r', others: 'r' },
        executable: false,
        selinux: '',
        userList: [],
        groupList: [],
    },
    propsModalEl: null,
    _cachedUsers: null,
    _cachedGroups: null,

    compress: { paths: [], name: 'archive.zip', format: 'zip', dir: '/' },
    compressModalEl: null,

    downloadArc: { paths: [], format: 'tar.gz', count: 0 },
    downloadArcModalEl: null,

    dropChoice: { paths: [], target: '', resolve: null, single: null, forceCopy: false, name: '' },
    termPathPop: { open: false, top: 0, left: 0, path: '' },
    _termPathTimer: null,
    dropChoiceModalEl: null,

    confirmDlg: { title: '', message: '', confirmLabel: 'OK', cancelLabel: 'Cancel', buttons: null, result: undefined, resolve: null },
    confirmModalEl: null,

    promptDlg: { title: '', label: '', value: '', resolve: null },
    promptModalEl: null,
    // Directory picker (mini browser used by clone/checkout/register prompts)
    dirPicker: { open: false, title: '', path: '', entries: [], loading: false, resolve: null, pathInput: '' },
    dirPickerEl: null,

    actionsMgr: { scope: 'user', editingIdx: null, error: '', loaded: { user: false, system: false },
                  mode: 'form', codeFormat: 'json', codeText: '', codeError: '', monacoFailed: false },
    pluginVersion: '',
    actionsModalEl: null,

    globalActionsModalEl: null,

    updateModalEl: null,

    settingsModalEl: null,

    // Mounts / fstab editor (⛁ Mounts toolbar button)
    mounts: {
        loading: false, error: '', raw: '', rawMode: false, rawEdited: '',
        rows: [], trailer: [], findmnt: false, mountAfter: true,
        saving: false, mountResults: [],
        // 'fstab' editor view vs 'live' currently-mounted view
        view: 'fstab', busyTarget: '',
        netType: 'smb',   // network-share tab: 'smb' | 'nfs'
        live: { loading: false, error: '', rows: [] },
        adhoc: { open: false, device: '', mountpoint: '', fstype: '', options: '', busy: false },
        // Field suggestions (datalists). devices/mountpoints/fstypes are
        // populated from the live system on open; the rest are static.
        suggest: {
            devices: [], bySpec: {}, mountpoints: [], fstypes: [],
            mntopts: ['defaults', 'defaults,noatime', 'defaults,nofail',
                'defaults,nofail,x-systemd.automount', 'ro', 'rw', 'noatime',
                'relatime', 'nodev,nosuid,noexec', 'noauto', 'user', 'users',
                '_netdev', 'defaults,_netdev', 'errors=remount-ro', 'discard'],
            freq: ['0', '1'], passno: ['0', '1', '2'],
        },
    },
    mountsModalEl: null,

    // GRUB editor (/etc/default/grub + config regeneration)
    grub: {
        available: false, regenTool: '', isUefi: false, hasGrubby: false, outPath: '',
        loading: false, error: '', saving: false,
        raw: '', rawMode: false, rawEdited: '',
        rows: [], trailer: [],
        applyGrubby: false, regenResult: '',
    },
    grubModalEl: null,

    // NFS network shares (host/IP-based access — no credential store)
    nfs: {
        available: null, hasShowmount: null, install: '',
        browsing: false, exports: [],
        add: {
            host: '', export: '', mountpoint: '',
            netdev: true, nofail: true, automount: true, ro: false,
            vers: '', busy: false, error: '',
        },
    },

    // SMB/CIFS network shares + managed root-only credential store
    cifs: {
        available: null, creds: [], loadingCreds: false,
        add: {
            host: '', share: '', mountpoint: '',
            credMode: 'existing', credName: '',
            username: '', password: '', domain: '',
            netdev: true, nofail: true, automount: true, ro: false,
            vers: '', uid: '', gid: '',
            busy: false, error: '',
        },
        // SMB discovery (mDNS host discovery + smbclient share browse)
        disco: {
            hasAvahi: null, hasNmblookup: null, hasSmbclient: null, smbInstall: '',
            scanning: false, browsing: false, error: '',
            sweeping: false, sweepDone: 0, sweepTotal: 0,
            hosts: [], shares: [],
        },
    },

    toasts: [],

    dragData: null, // { paths: [...], sourceTabId }


    // ───── Init ──────────────────────────────────────────────────────────────
    async init() {
        this.homePath = await FS.homeDir();

        // Stacked modals: Bootstrap doesn't bump z-index for a modal opened on
        // top of another, and rapid open/close can leave an orphaned backdrop
        // sitting ABOVE a later modal — which then looks dimmed/"ghosted" and
        // swallows clicks. Keep the top-most open modal above every backdrop,
        // park its own backdrop just beneath it, and drop orphan backdrops.
        let _modalSeq = 0;
        const _placeTopModal = () => {
            const open = [...document.querySelectorAll('.modal.show')];
            // Remove orphaned backdrops (one backdrop per open modal at most).
            let bds = [...document.querySelectorAll('.modal-backdrop')];
            while (bds.length > open.length && bds.length > 0) { bds.shift().remove(); }
            if (!open.length) return;
            open.sort((a, b) => (a._openSeq || 0) - (b._openSeq || 0));
            const top = open[open.length - 1];
            const backdrops = [...document.querySelectorAll('.modal-backdrop')];
            let maxBd = 1050;
            for (const b of backdrops) {
                const v = parseInt(b.style.zIndex || '', 10);
                if (!isNaN(v)) maxBd = Math.max(maxBd, v);
            }
            const z = Math.max(1056, maxBd + 2);
            top.style.zIndex = String(z);
            const lastBd = backdrops[backdrops.length - 1];
            if (lastBd) lastBd.style.zIndex = String(z - 1);
        };
        document.addEventListener('show.bs.modal', (e) => { e.target._openSeq = ++_modalSeq; });
        document.addEventListener('shown.bs.modal', _placeTopModal);
        // Autofocus the first field when a modal opens, if it's a text input /
        // textarea, so users can type immediately (covers dialogs, prompts, and
        // the interactive Script Prompt Protocol which prompts via #promptModal).
        document.addEventListener('shown.bs.modal', (e) => this._focusFirstField(e.target));
        document.addEventListener('hidden.bs.modal', () => setTimeout(_placeTopModal, 0));

        // Load settings from ~/.config/cockpit/explorer/settings.yml
        // Migrate from localStorage if the YAML file doesn't exist yet.
        await this._loadSettings();

        // restore or create initial tab
        let restored = false;
        let savedWindows = null;
        if (this.settings.persistTabs) {
            let data = null;
            // Prefer YAML on disk
            try {
                const txt = await FS.readText(this.homePath + '/.config/cockpit/explorer/tabs.yml');
                if (txt && window.jsyaml) data = jsyaml.load(txt);
            } catch (e) {}
            // Migrate from localStorage if needed
            if (!data) {
                try {
                    const raw = localStorage.getItem(ExRT.const.LS_KEY_TABS);
                    if (raw) {
                        data = JSON.parse(raw);
                        try { localStorage.removeItem(ExRT.const.LS_KEY_TABS); } catch (e) {}
                    }
                } catch (e) {}
            }
            if (data && data.windows) savedWindows = data.windows;
            if (data && Array.isArray(data.tmuxTabs)) this._savedTmuxTabs = data.tmuxTabs.slice();
            if (data && Array.isArray(data.tabs) && data.tabs.length) {
                const seen = new Set();
                for (const t of data.tabs) {
                    // Only restore dir tabs. Terminal/output tabs are transient
                    // and shouldn't have been persisted in the first place;
                    // ignore them defensively if a stale tabs.yml has them.
                    if (t.kind && t.kind !== 'dir') continue;
                    const key = `dir:${t.path}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    this.tabs.push(this._buildTab(t.path, 'dir'));
                }
                // Tab IDs are regenerated each session, so saved id is stale.
                // Restore active tab by saved position; clamp into range.
                if (this.tabs.length) {
                    const idx = (typeof data.activeIdx === 'number')
                        ? Math.min(Math.max(0, data.activeIdx), this.tabs.length - 1)
                        : 0;
                    this.activeTabId = this.tabs[idx].id;
                    restored = true;
                }
            }
        }
        if (!restored) {
            this.newTab(this.homePath);
        }
        // Defensive: ensure activeTabId points to an actual tab. If the
        // restored value somehow doesn't match any tab id (it shouldn't,
        // since we set activeTabId from the freshly-built tabs), fall
        // back to the first tab.
        if (!this.tabs.find(t => t.id === this.activeTabId)) {
            this.activeTabId = this.tabs[0]?.id || null;
        }

        // Load active tab
        this.$nextTick(() => {
            const tab = this.activeTab();
            if (!tab) return;
            if (tab.kind === 'dir') this._loadDir(tab);
            // If a terminal-kind tab is the restored active one and has no
            // shells (it shouldn't, since we filter terminal kinds on restore,
            // but defensively) — spawn one.
            else if (tab.kind === 'terminal' && (!tab.terminals || tab.terminals.length === 0)) {
                this.addTerminalToTab(tab, tab.path);
            }
            // Reopen any preview/editor windows that were open last session.
            if (savedWindows) this._restoreWindows(savedWindows);
        });

        // Load custom actions in background
        this._loadCustomActions('user');
        this._loadCustomActions('system');
        this._loadBuiltinActions();

        // Persist tabs on change
        this.$watch('tabs', () => this._persistTabs(), { deep: false });
        this.$watch('activeTabId', () => this._persistTabs());
        // Persist open preview/editor windows on change
        // Persist open preview/editor windows on change
        this.$watch('windows', () => this._persistTabs(), { deep: true });
        this.$watch('activeWinId', () => this._persistTabs());
        this.$watch('hostVisible', () => this._persistTabs());

        // Init extensions (shells, repo cache, git polling)
        this._initExtensions();

        // Re-detect gh state when the window regains focus — the user may
        // have installed or authed gh externally (e.g. via a real terminal).
        // BUT never while the GitHub panel is open (so switching apps / taking
        // a screenshot doesn't reload it), and not once we're already authed.
        // Use the manual "Re-check" button to refresh an open panel.
        this._lastGhRecheck = 0;
        const onFocus = () => {
            const ghOpen = this.ghModalEl && this.ghModalEl.classList.contains('show');
            if (ghOpen || this.gh.state === 'authed') return;
            const now = Date.now();
            if (now - this._lastGhRecheck < 3000) return;
            this._lastGhRecheck = now;
            this._refreshGhState().catch(() => {});
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') onFocus();
        });

        // Proactively configure git to authenticate github.com via gh, so
        // repo-strip Fetch/Pull/Push (and any other git op) work even before
        // the GitHub panel is opened. Persists in global git config.
        (async () => {
            try {
                if (this._ghGitConfigured || !(await GIT.ghAvailable())) return;
                let authed = (await GIT.ghAuthStatus()).authed;
                // Re-auth from the saved token if gh logged itself out.
                if (!authed) authed = await this._tryAutoGhLogin();
                if (authed) {
                    this._ghGitConfigured = true;
                    await GIT.ghSetupGit();
                }
            } catch (e) {}
        })();
    },


    // Tabs + panes + navigation → js/core/tabs.js
    // Selection + sorting + context menu → js/core/filelist.js
    // File operations (copy/cut/paste/rename/delete/new) → js/core/fileops.js
    // Preview + editor + window management → js/features/editor.js


    // Permissions → js/core/fileops.js
    // Search → js/core/filelist.js
    // Download → js/core/fileops.js
    // Upload + drag&drop + archive → js/features/upload.js


    // Custom actions (+ form/JSON editor, global actions) → js/features/actions.js

    // Streaming output + operations tray → js/core/output.js
    // Dialogs (confirm/prompt/choice) + directory picker → js/core/dialogs.js
    // Interactive scripts → js/features/actions.js


    // Toasts → js/core/dialogs.js
    // Settings + keyboard (onKey) → js/core/settings.js
    // ─── shells available on the host (read from /etc/shells at init) ────────
    shells: ['/bin/sh', '/bin/bash'],

    // ─── tmux session manager ────────────────────────────────────────────────
    tmux: { available: false, bin: '', open: false, loading: false, error: '', sessions: [], top: 40, right: 8, hasConf: false },

    // ─── run command state ───────────────────────────────────────────────────
    runCmd: { cwd: '/', shell: '/bin/sh', command: '', admin: false },
    runCmdModalEl: null,

    // ─── github state ────────────────────────────────────────────────────────
    gh: {
        state: 'init',          // init | notinstalled | notauthed | authed
        user: '',
        scopes: [],
        scopeWarning: false,
        installFamily: '',
        installing: false,
        tokenInput: '',
        saveToken: true,        // persist the token so gh can be re-authed automatically
        loggingIn: false,
        authError: '',
        repos: [],
        loadingRepos: false,
        search: '',
        selectedRepo: null,
        tab: 'branches',
        branches: [],
        branchSearch: '',
        loadingBranches: false,
        prs: [],
        loadingPrs: false,
        localCopies: [], // [{ path, title, branch }] for the selected repo
    },
    ghModalEl: null,

    repoCache: {}, // ownerRepo -> localPath
    // Branch switcher dropdown (active pane's work-tree)
    branchSwitcher: { path: '', current: '', locals: [], remotes: [], copies: [], ownerRepo: '', loading: false },

    commitBrowser: {
        repo: '', branch: '', cachePath: '',
        commits: [], loadingCommits: false,
        selectedCommit: null,
        files: [], selectedFile: null,
        fileDiff: '',
    },
    commitBrowserModalEl: null,

    typeConfirm: { title: '', message: '', phrase: '', typed: '', resolve: null },
    typeConfirmModalEl: null,

    pushConflict: { tab: null, behind: 0, ahead: 0, dirtyCount: 0, resolve: null },
    pushConflictModalEl: null,

    commitMsg: { message: '', fileCount: 0, push: false, resolve: null },
    commitMsgModalEl: null,

    publish: {
        folder: '', name: '', nameError: '', owner: '', orgs: [],
        visibility: 'private', description: '', commitMessage: 'Initial commit',
        gitignore: '', license: '',
        gitignoreTemplates: ['', 'Node', 'Python', 'Go', 'Rust', 'Java', 'C', 'C++', 'VisualStudio', 'Maven', 'Gradle', 'Ruby', 'Composer', 'Unity'],
        licenses: [
            { key: '', name: '(none)' },
            { key: 'mit', name: 'MIT' },
            { key: 'apache-2.0', name: 'Apache 2.0' },
            { key: 'gpl-3.0', name: 'GPL v3' },
            { key: 'agpl-3.0', name: 'AGPL v3' },
            { key: 'bsd-3-clause', name: 'BSD 3-Clause' },
            { key: 'mpl-2.0', name: 'MPL 2.0' },
            { key: 'unlicense', name: 'The Unlicense' },
        ],
        empty: false, scopeBlocked: false, scopeUnknown: false,
        busy: false, error: '',
    },
    publishModalEl: null,

    // ─── Init for these features (called from main init) ─────────────────────
    async _initExtensions() {
        // Load /etc/shells
        try {
            const txt = await FS.readText('/etc/shells');
            const shells = (txt || '').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
            if (shells.length) this.shells = shells;
        } catch (e) {}
        // tmux is managed by the dedicated tmux session manager (toolbar button),
        // never as a "default shell" — drop it from the settings list even when
        // it's listed in /etc/shells.
        this.shells = this.shells.filter(s => s.replace(/.*\//, '') !== 'tmux');
        if (!this.settings.defaultShell || !this.shells.includes(this.settings.defaultShell)) {
            this.settings.defaultShell = this.shells.find(s => s.endsWith('/bash')) || this.shells[0];
        }
        if (!this.settings.diffView) this.settings.diffView = 'side';

        // Detect tmux (for the toolbar session-manager button) and restore any
        // tmux terminal tabs that were open last session and are still alive.
        this.tmux.available = await this._hasTmux();
        this._restoreTmuxTabs();

        // Detect GRUB (for the toolbar GRUB editor button); hidden unless
        // /etc/default/grub exists and a config-regeneration tool is present.
        this._detectGrub();

        // Detect Cockpit's terminal plugin
        this.terminalAvailable = false;
        try {
            const stat = await FS.statOne('/usr/share/cockpit/system/terminal.html');
            this.terminalAvailable = !!stat;
        } catch (e) {}

        // Detect rsync (used for streaming-progress copy/move of big trees)
        this.rsyncAvailable = await FS.hasRsync();

        // Learn our own version (for the badge and {oldVersion} in actions).
        try {
            const r = await fetch('VERSION', { cache: 'no-store' });
            if (r.ok) this.pluginVersion = (await r.text()).trim();
        } catch (e) {}
        if (!this.pluginVersion) {
            for (const p of ['/usr/share/cockpit/explorer/VERSION', '/etc/cockpit/explorer/installed-version']) {
                try { const t = await FS.readText(p); if (t && t.trim()) { this.pluginVersion = t.trim(); break; } } catch (e) {}
            }
        }

        // Auto-check GitHub releases for a newer version (non-blocking).
        if (this.settings.updateCheckOnStart) {
            setTimeout(() => { this.checkForUpdate(false).catch(() => {}); }, 4000);
        }

        // Write the bash rcfile that makes interactive shells emit OSC 7
        // working-directory reports (so terminal sub-tab labels track `pwd`).
        this._ensureOsc7Rc();

        // Pre-load user/group lists for the Permissions dialog
        try {
            const out = await cockpit.spawn(['sh', '-c', 'getent passwd | cut -d: -f1 | sort -u'], { err: 'ignore' });
            this._cachedUsers = out.trim().split('\n').filter(Boolean);
        } catch (e) { this._cachedUsers = []; }
        try {
            const out = await cockpit.spawn(['sh', '-c', 'getent group | cut -d: -f1 | sort -u'], { err: 'ignore' });
            this._cachedGroups = out.trim().split('\n').filter(Boolean);
        } catch (e) { this._cachedGroups = []; }

        // Load repo cache registry
        this._loadRepoCache();

        // Initial git scan (all tabs)
        this._refreshAllGitInfo();

        // Throttled polling: only the active tab, only when window is visible
        setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            const tab = this.activeTab();
            if (tab) this._refreshTabGit(tab);
        }, 8000);
    },

    async _refreshTabGit(tab) {
        if (!tab || tab.kind !== 'dir') return;
        try {
            if (await GIT.isWorkTree(tab.path)) {
                tab.gitInfo = await GIT.status(tab.path);
            } else {
                tab.gitInfo = null;
            }
        } catch (e) { tab.gitInfo = null; }
        tab.gitChecked = true;
    },

    terminalAvailable: false,

    async openInTerminal(path) {
        if (!path) path = this.activeTab()?.path || this.homePath;
        const cmd = `cd ${Util.shq(path)}`;
        // navigator.clipboard is undefined on a non-secure (http) origin, so go
        // through the execCommand fallback helper instead of a bare write.
        if (this._copyToClipboard(cmd)) {
            this.toast('Terminal opened — cd command copied to clipboard. Paste with Ctrl-Shift-V.');
        } else {
            this.toast(`Terminal opened. Run: ${cmd}`, 'info');
        }
        if (window.cockpit && cockpit.jump) {
            cockpit.jump(['system', 'terminal']);
        }
    },

    // Integrated terminals + tmux + path popover → js/features/terminal.js

    async _loadRepoCache() {
        try {
            const txt = await FS.readText(this.homePath + '/.config/cockpit/explorer/repos.json');
            if (!txt) return;
            const raw = JSON.parse(txt) || {};
            const out = {};
            for (const [k, v] of Object.entries(raw)) {
                const repoName = k.split('/').pop();
                if (Array.isArray(v)) {
                    out[k] = v.filter(e => e && e.path).map(e => ({ path: e.path, title: e.title || repoName }));
                } else if (typeof v === 'string') {
                    out[k] = [{ path: v, title: repoName }];
                } else if (v && v.path) {
                    out[k] = [{ path: v.path, title: v.title || repoName }];
                }
            }
            this.repoCache = out;
        } catch (e) {}
    },

    async _saveRepoCache() {
        const path = this.homePath + '/.config/cockpit/explorer/repos.json';
        try {
            await FS.mkdir(Util.dirname(path));
            await FS.writeText(path, JSON.stringify(this.repoCache, null, 2));
        } catch (e) { this.toast('Could not save repo cache: ' + e.message, 'danger'); }
    },

    // Repo cache + cached-repos toolbar → js/features/github.js
    // Run command → js/core/output.js
    // GitHub panel/update/checkout/commit/publish → js/features/github.js

}));

}); // alpine:init
