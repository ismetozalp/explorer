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


    // ───── Tab management ────────────────────────────────────────────────────
    _buildTab(path, kind) {
        // Only three kinds are valid; coerce anything else to 'dir' so a
        // stale on-disk file can't conjure broken-state tabs on restore.
        if (kind !== 'dir' && kind !== 'output' && kind !== 'terminal') kind = 'dir';
        const tab = {
            id: Util.uid(),
            kind: kind, // 'dir' | 'output' | 'terminal'
            path: path || this.homePath,
            files: [],
            selection: [],
            sortColumn: 'name',
            sortDirection: 1, // 1 asc, -1 desc
            loading: false,
            error: null,
            errorRetryAsAdmin: false,
            listAdminPath: null,
            history: [path || this.homePath],
            historyIdx: 0,
            editingPath: false,
            lastClickedPath: null,
            search: { query: '', mode: 'name', recursive: false, caseInsensitive: false, regex: false, active: false },
            // for output panes
            outputLines: [],
            outputStatus: 'idle',
            outputCommand: '',
            outputActionLabel: '',
            outputChannel: null,
            follow: true,        // stay pinned to the bottom of a streaming pane
            _outBuf: '',         // partial-line buffer for chunked streaming
            _scrollRaf: 0,       // pending rAF id for coalesced auto-scroll
            _autoScrollUntil: 0, // ignore 'scroll' events until this timestamp (our own auto-scrolls)
            // ── Terminals (v1.2) ───────────────────────────────────────
            // Reactive collection only; the actual xterm Terminal /
            // cockpit channel instances live in module-scope ExRT.term.map
            // keyed by terminal.id. Used by both kind='dir' (split pane)
            // and kind='terminal' (full-tab terminal stack).
            terminals: [],          // [{ id, dir, label }]
            activeTermId: null,
            termKind: 'plain',      // terminal tabs: 'plain' | 'tmux' (source of truth)
            splitOpen: false,       // dir tabs: is the terminal pane visible?
            splitWidth: 480,        // single-pane: terminal pane width (vertical split)
            splitHeight: 260,       // dual-pane: terminal pane height (horizontal split)
            // ── Dual pane (Midnight Commander style) (v1.4) ────────────
            // Pane A is the tab itself (its path/files/selection/etc.).
            // Pane B, when present, is a sibling pane object with the same
            // shape. activePaneId selects which one the toolbar + file
            // operations act on. For a non-dual tab, activePane() === tab,
            // so single-pane behaviour is unchanged.
            dual: false,
            paneB: null,
            activePaneId: 'a',
            gitInfo: null,
            gitChecked: false,
        };
        return tab;
    },

    // A pane is a directory view. Pane A is the tab; pane B is one of these.
    _buildPane(path) {
        return {
            kind: 'dir',
            paneId: Util.uid(),
            path: path || this.homePath,
            files: [],
            selection: [],
            sortColumn: 'name',
            sortDirection: 1,
            loading: false,
            loaded: false,
            error: null,
            errorRetryAsAdmin: false,
            listAdminPath: null,
            history: [path || this.homePath],
            historyIdx: 0,
            editingPath: false,
            lastClickedPath: null,
            search: { query: '', mode: 'name', recursive: false, caseInsensitive: false, regex: false, active: false },
            gitInfo: null,
            gitChecked: false,
        };
    },

    // ── Pane accessors ─────────────────────────────────────────────────
    paneList(tab) {
        return (tab && tab.dual && tab.paneB) ? [tab, tab.paneB] : [tab];
    },
    activePane(tab) {
        if (tab && tab.dual && tab.activePaneId === 'b' && tab.paneB) return tab.paneB;
        return tab;
    },
    currentPane() {
        const tab = this.activeTab();
        return tab ? this.activePane(tab) : null;
    },
    isActivePane(tab, pane) {
        return this.activePane(tab) === pane;
    },
    _activatePaneRef(tab, pane) {
        if (tab && tab.dual) tab.activePaneId = (pane === tab.paneB) ? 'b' : 'a';
    },

    toggleDualPane(tabRef) {
        // Re-acquire the reactive proxy from this.tabs so the mutations below
        // trigger Alpine re-render (raw refs don't — same lesson as elsewhere).
        const tab = (tabRef && this.tabs.find(t => t.id === tabRef.id)) || this.activeTab();
        if (!tab || tab.kind !== 'dir') return;
        if (tab.dual) {
            // Collapse back to single pane (keep pane A = the tab).
            tab.dual = false;
            tab.activePaneId = 'a';
            tab.paneB = null;
        } else {
            tab.paneB = this._buildPane(tab.path);
            tab.activePaneId = 'a';
            tab.dual = true;
            // Load pane B once its DOM exists.
            this.$nextTick(() => {
                const pane = tab.paneB;
                if (!pane) return;
                this._loadDir(pane);
                this._refreshTabGit(pane);
            });
        }
    },

    newTab(path) {
        const raw = this._buildTab(path || this.homePath);
        this.tabs.push(raw);
        this.activeTabId = raw.id;
        // Re-acquire the reactive proxy (see comment in addTerminalToTab).
        const tab = this.tabs.find(t => t.id === raw.id);
        if (tab.kind === 'dir') this.$nextTick(() => this._loadDir(tab));
        return tab;
    },

    closeTab(id) {
        const idx = this.tabs.findIndex(t => t.id === id);
        if (idx < 0) return;
        const tab = this.tabs[idx];
        // Clean up streaming output channel
        if (tab.outputChannel) try { tab.outputChannel.close(); } catch(e){}
        // Clean up all terminals owned by this tab (v1.2)
        try { (tab.terminals || []).forEach(t => ExRT.term.del(t.id)); } catch(e){}
        this.tabs.splice(idx, 1);
        if (this.activeTabId === id) {
            this.activeTabId = this.tabs[Math.max(0, idx - 1)]?.id || null;
        }
        if (this.tabs.length === 0) this.newTab(this.homePath);
    },

    activateTab(id) {
        this.activeTabId = id;
        const tab = this.tabs.find(t => t.id === id);
        if (!tab) return;
        if (tab.kind === 'dir' && !tab.loaded && !tab.loading) this._loadDir(tab);
        // Safety: a terminal-kind tab with no shells inside (e.g. restored
        // from a buggy state, or addTerminalToTab silently failed earlier)
        // is useless. Spawn one so the user always sees a working shell.
        if (tab.kind === 'terminal' && (!tab.terminals || tab.terminals.length === 0)) {
            this.$nextTick(() => this.addTerminalToTab(tab, tab.path));
        } else if (tab.kind === 'terminal') {
            // Restored tmux tabs declare their terminals up front but can't
            // mount while hidden — mount them now the tab is visible.
            this._ensureTerminalsMounted(tab);
        }
        this._refreshTabGit(tab);
    },
    activeTab() { return this.tabs.find(t => t.id === this.activeTabId); },
    currentTab() { return this.activeTab(); },

    // Terminal tabs are either a stack of plain shells ('plain') or a group of
    // tmux sessions ('tmux'). termKind is the source of truth; fall back to
    // inferring it for tabs persisted before the field existed.
    termKindOf(tab) {
        if (!tab || tab.kind !== 'terminal') return '';
        if (tab.termKind) return tab.termKind;
        return (tab.tmux || (tab.terminals || []).some(t => t.tmux)) ? 'tmux' : 'plain';
    },

    tabLabel(tab) {
        if (tab.kind === 'output') return '▶ ' + (tab.outputActionLabel || 'output');
        if (tab.kind === 'terminal') {
            if (this.termKindOf(tab) === 'tmux') {
                const act = (tab.terminals || []).find(t => t.id === tab.activeTermId);
                return '⧉ ' + ((act && act.tmux) || 'tmux');
            }
            return '❯ Terminal';
        }
        if (tab.path === '/') return '/';
        return Util.basename(tab.path) || tab.path;
    },

    // Sub-tab label: tmux session name for tmux terminals, else the live cwd.
    termLabel(t) {
        if (!t) return '';
        return t.tmux ? ('⧉ ' + t.tmux) : ('❯ ' + this.shortenTermPath(t.dir));
    },

    // Front-truncate a path to fit a sub-tab, keeping whole trailing segments:
    //   /home/ismet/Videos  →  /home/ismet/Videos  (fits)
    //   /a/very/long/path/here → .../path/here
    shortenTermPath(p, max) {
        max = max || 26;
        if (!p) return '/';
        if (p.length <= max) return p;
        const segs = p.split('/').filter(Boolean);
        if (!segs.length) return p;
        let tail = segs[segs.length - 1];
        for (let i = segs.length - 2; i >= 0; i--) {
            const cand = segs[i] + '/' + tail;
            if (('.../' + cand).length > max) break;
            tail = cand;
        }
        return '.../' + tail;
    },
    isTermPathShortened(p) {
        return this.shortenTermPath(p) !== p;
    },

    duplicateTab(id) {
        const src = this.tabs.find(t => t.id === id);
        if (!src) return;
        const raw = this._buildTab(src.path, 'dir');
        this.tabs.splice(this.tabs.findIndex(t => t.id === id) + 1, 0, raw);
        this.activeTabId = raw.id;
        const tab = this.tabs.find(t => t.id === raw.id);
        this._loadDir(tab);
    },

    closeOtherTabs(id) {
        this.tabs.slice().forEach(t => { if (t.id !== id) this.closeTab(t.id); });
    },
    closeTabsLeft(id) {
        const idx = this.tabs.findIndex(t => t.id === id);
        this.tabs.slice(0, idx).reverse().forEach(t => this.closeTab(t.id));
    },
    closeTabsRight(id) {
        const idx = this.tabs.findIndex(t => t.id === id);
        this.tabs.slice(idx + 1).reverse().forEach(t => this.closeTab(t.id));
    },

    openTabMenu(ev, tabId) {
        this.ctxMenu = { open: true, x: ev.clientX, y: ev.clientY, kind: 'tab', target: null, tabId };
    },

    _persistTabs() {
        if (!this.settings.persistTabs) return;
        // Debounce — tabs change frequently (active switches, navigation, etc)
        if (this._persistTabsTimer) clearTimeout(this._persistTabsTimer);
        this._persistTabsTimer = setTimeout(async () => {
            const path = this.homePath + '/.config/cockpit/explorer/tabs.yml';
            try {
                const dirTabs = this.tabs.filter(t => t.kind === 'dir');
                const idx = Math.max(0, dirTabs.findIndex(t => t.id === this.activeTabId));
                // tmux terminal tabs (by session name) so they can be re-attached
                // and restored next launch, in tab order.
                // All tmux session names across the tmux container tab, in
                // sub-tab order, so the whole group is restored next launch.
                const tmuxTabs = Array.from(new Set(this.tabs
                    .filter(t => t.kind === 'terminal' && this.termKindOf(t) === 'tmux')
                    .flatMap(t => (t.terminals || []).filter(x => x.tmux).map(x => x.tmux))));
                const data = {
                    tabs: dirTabs.map(t => ({ path: t.path, kind: t.kind })),
                    activeIdx: idx,
                    tmuxTabs: tmuxTabs,
                    windows: this.windows.filter(w => w.path).map(w => ({ kind: w.kind, path: w.path })),
                    activeWinPath: (this.activeWin() && this.activeWin().path) || null,
                    hostVisible: !!this.hostVisible,
                };
                await FS.mkdir(Util.dirname(path));
                const yaml = window.jsyaml ? jsyaml.dump(data, { indent: 2 }) : JSON.stringify(data, null, 2);
                await FS.writeText(path, yaml);
            } catch (e) {}
        }, 400);
    },


    // Reopen the preview/editor windows that were open in the previous
    // session. Files are re-read fresh from disk (unsaved edits aren't kept,
    // same as closing). Missing files are skipped silently.
    async _restoreWindows(saved) {
        if (!saved) return;
        const list = Array.isArray(saved.windows) ? saved.windows : [];
        for (const it of list) {
            if (!it || !it.path) continue;
            try {
                const f = await FS.statOne(it.path);
                if (!f || f.type !== 'f') continue;
                if (it.kind === 'editor') await this.openEditor(f, { minimized: true });
                else await this.openPreview(f, { minimized: true });
            } catch (e) {}
        }
        if (!this.windows.length) return;
        // Choose the previously-active window (or the first) and show the host
        // only if it was visible last session.
        let target = saved.activeWinPath ? this.windows.find(w => w.path === saved.activeWinPath) : null;
        if (!target) target = this.windows[0];
        this.activeWinId = target.id;
        if (saved.hostVisible) this._showHost();
        else this.$nextTick(() => this._syncActiveEditor());
    },


    // ───── Navigation ────────────────────────────────────────────────────────
    async _loadDir(tab, opts) {
        if (tab.kind !== 'dir') return;
        opts = opts || {};
        // Admin listing sticks to the path it was granted for, so reloads and
        // post-save refreshes of the same directory don't drop back to a
        // normal-user listing (and re-show the "Retry as administrator" banner).
        const admin = (opts.admin !== undefined) ? opts.admin : (tab.listAdminPath === tab.path);
        tab.loading = true;
        tab.error = null;
        tab.errorRetryAsAdmin = false;
        try {
            let files = await FS.listDir(tab.path, { admin });
            if (!this.settings.showHidden) files = files.filter(f => !f.name.startsWith('.'));
            tab.files = files;
            // Prune selection to items still present
            const visible = new Set(files.map(f => f.path));
            tab.selection = tab.selection.filter(p => visible.has(p));
            tab.loaded = true;
            if (admin) tab.listAdminPath = tab.path;
            else if (tab.listAdminPath === tab.path) tab.listAdminPath = null;
        } catch (e) {
            tab.error = e.message || 'Failed to read directory';
            tab.errorRetryAsAdmin = e.permissionDenied || !admin;
            tab.files = [];
        } finally {
            tab.loading = false;
        }
    },

    async navigate(tab, path, opts) {
        opts = opts || {};
        path = Util.normalizePath(path);
        // Symlink resolution if needed
        if (this.settings.followSymlinks) {
            try {
                const resolved = await FS.readlinkResolved(path);
                if (resolved) path = resolved;
            } catch (e) {}
        }
        tab.path = path;
        tab.selection = [];
        tab.search.active = false;
        // history
        tab.history = tab.history.slice(0, tab.historyIdx + 1);
        if (tab.history[tab.history.length - 1] !== path) tab.history.push(path);
        tab.historyIdx = tab.history.length - 1;
        await this._loadDir(tab, opts);
    },

    goBack(tab) {
        if (tab.historyIdx <= 0) return;
        tab.historyIdx--;
        tab.path = tab.history[tab.historyIdx];
        tab.selection = [];
        this._loadDir(tab);
    },
    goForward(tab) {
        if (tab.historyIdx >= tab.history.length - 1) return;
        tab.historyIdx++;
        tab.path = tab.history[tab.historyIdx];
        tab.selection = [];
        this._loadDir(tab);
    },
    goUp(tab) { this.navigate(tab, Util.dirname(tab.path)); },
    goHome(tab) { this.navigate(tab, this.homePath); },
    reload(tab, opts) { return this._loadDir(tab, opts); },

    pathSegments(p) { return Util.pathSegments(p); },


    // ───── Selection ─────────────────────────────────────────────────────────
    onRowClick(ev, tab, file) {
        if (ev.shiftKey && tab.lastClickedPath) {
            const sorted = this.sortedFiles(tab);
            const idxA = sorted.findIndex(f => f.path === tab.lastClickedPath);
            const idxB = sorted.findIndex(f => f.path === file.path);
            if (idxA >= 0 && idxB >= 0) {
                const [lo, hi] = [Math.min(idxA, idxB), Math.max(idxA, idxB)];
                tab.selection = sorted.slice(lo, hi + 1).map(f => f.path);
                return;
            }
        }
        if (ev.ctrlKey || ev.metaKey) {
            this.toggleSelect(tab, file);
        } else {
            tab.selection = [file.path];
        }
        tab.lastClickedPath = file.path;
    },

    toggleSelect(tab, file) {
        const idx = tab.selection.indexOf(file.path);
        if (idx >= 0) tab.selection.splice(idx, 1);
        else tab.selection.push(file.path);
        tab.lastClickedPath = file.path;
    },

    toggleSelectAll(tab, checked) {
        tab.selection = checked ? this.sortedFiles(tab).map(f => f.path) : [];
    },

    clearSelection(tab) {
        if (tab) tab.selection = [];
        else if (this.currentPane()) this.currentPane().selection = [];
    },

    selectedFiles(tab) {
        tab = tab || this.currentPane();
        if (!tab) return [];
        const m = new Map(tab.files.map(f => [f.path, f]));
        return tab.selection.map(p => m.get(p)).filter(Boolean);
    },

    selectionSummary(tab) {
        const sel = this.selectedFiles(tab);
        const total = sel.reduce((s, f) => s + (f.type === 'f' ? f.size : 0), 0);
        return `${sel.length} selected · ${Util.humanSize(total)}`;
    },

    statusText(tab) {
        if (tab.kind !== 'dir') return tab.outputStatus || '';
        if (tab.loading) return 'Loading…';
        const dirs = tab.files.filter(f => f.type === 'd').length;
        const files = tab.files.length - dirs;
        return `${tab.files.length} item(s) · ${dirs} folder(s) · ${files} file(s)`;
    },


    // ───── Sorting & display helpers ────────────────────────────────────────
    visibleColumnCount() {
        const c = this.settings.columns;
        return 2 + (c.size ? 1 : 0) + (c.modified ? 1 : 0) + (c.perms ? 1 : 0) + (c.owner ? 1 : 0) + (c.type ? 1 : 0);
    },

    setSort(tab, col) {
        if (tab.sortColumn === col) tab.sortDirection = -tab.sortDirection;
        else { tab.sortColumn = col; tab.sortDirection = 1; }
    },

    sortIndicator(tab, col) {
        if (tab.sortColumn !== col) return '';
        return tab.sortDirection > 0 ? '▲' : '▼';
    },

    sortedFiles(tab) {
        const col = tab.sortColumn;
        const dir = tab.sortDirection;
        const items = tab.files.slice();
        items.sort((a, b) => {
            // Always sort directories before files (unless explicit type column)
            if (a.type === 'd' && b.type !== 'd') return -1;
            if (a.type !== 'd' && b.type === 'd') return 1;
            let av = a[col], bv = b[col];
            if (col === 'name') { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); }
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
        return items;
    },

    humanSize: Util.humanSize,
    formatDate: Util.formatDate,
    fileIcon: Util.fileIcon,
    typeLabel: Util.typeLabel,
    isTextLike: Util.isTextLike,
    isArchive: Util.isArchive,
    isPreviewable(file) {
        if (!file) return false;
        return Util.isTextLike(file) || Util.isImage(file) || Util.isPdf(file) || Util.isVideo(file) || Util.isAudio(file);
    },


    // ───── Context menu ──────────────────────────────────────────────────────
    closeContextMenu() { this.ctxMenu.open = false; },

    openContextMenu(ev, pane, file) {
        const tab = this.activeTab();
        this._activatePaneRef(tab, pane);
        this.ctxMenu = { open: true, x: ev.clientX, y: ev.clientY, kind: 'empty', target: null, tabId: tab ? tab.id : null, flyLeft: false };
        this._clampCtxMenu();
    },

    onRowContextMenu(ev, pane, file) {
        const tab = this.activeTab();
        this._activatePaneRef(tab, pane);
        // If the row isn't in current selection, select just it.
        if (!pane.selection.includes(file.path)) pane.selection = [file.path];
        this.ctxMenu = { open: true, x: ev.clientX, y: ev.clientY, kind: 'file', target: file, tabId: tab ? tab.id : null, flyLeft: false };
        this._clampCtxMenu();
    },

    _clampCtxMenu() {
        this.$nextTick(() => {
            const m = document.querySelector('.context-menu');
            if (!m) return;
            const r = m.getBoundingClientRect();
            const vw = window.innerWidth, vh = window.innerHeight;
            if (r.right > vw) this.ctxMenu.x = Math.max(0, vw - r.width - 4);
            if (r.bottom > vh) this.ctxMenu.y = Math.max(0, vh - r.height - 4);
            // Open submenu flyouts to the left when there isn't room on the right.
            const FLYOUT_W = 240;
            this.ctxMenu.flyLeft = (Math.min(r.right, vw) + FLYOUT_W) > vw;
        });
    },


    // ───── File operations from context menu ────────────────────────────────
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
        // 2. Disk-space pre-flight (best effort, capped at 5s)
        op.statusText = 'Checking sizes…';
        try {
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
            await this._runRsync(op, srcs, dest, mode, opts);
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
        const args = ['rsync', '-a', '--info=progress2', '--no-i-r'];
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

    _runRsyncRenamed(op, src, fullTarget, mode, isDir, opts) {
        // For a directory, trailing slashes on BOTH sides copy the contents
        // into the (new-named) target dir. For a file, no trailing slash.
        const s = isDir ? (src.endsWith('/') ? src : src + '/') : src;
        const t = isDir ? (fullTarget.endsWith('/') ? fullTarget : fullTarget + '/') : fullTarget;
        const args = ['rsync', '-a', '--info=progress2', '--no-i-r'];
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


    // ───── Preview ───────────────────────────────────────────────────────────
    async openPreview(file, opts) {
        opts = opts || {};
        if (!file) return;
        // Already open in a window? Just focus it.
        const existing = this.windows.find(w => w.kind === 'preview' && w.path === file.path);
        if (existing) { this.activateWindow(existing.id, !opts.minimized); return; }

        const id = this._newWinId();
        this.windows.push({
            id, kind: 'preview', path: file.path, _file: file,
            title: this._winTitle(file.path, 'preview'),
            pv: { kind: null, content: '', lang: '', url: null, reason: '', permissionDenied: false },
            loading: true,
        });
        this.activateWindow(id, !opts.minimized);
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
        const limit = (this.settings.previewLimitMB || 10) * 1024 * 1024;
        const ropts = admin ? { admin: true } : undefined;
        const set = (pv) => { const w = this._win(id); if (w) { w.pv = Object.assign({ permissionDenied: false }, pv); w.loading = false; } };
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
        } else if (Util.isImage(file) || Util.isPdf(file) || Util.isVideo(file) || Util.isAudio(file)) {
            try {
                const blob = await FS.readBinaryAsBlob(file.path, ropts);
                const url = URL.createObjectURL(blob);
                let kind = 'binary';
                if (Util.isImage(file)) kind = 'image';
                else if (Util.isPdf(file)) kind = 'pdf';
                else if (Util.isVideo(file)) kind = 'video';
                else if (Util.isAudio(file)) kind = 'audio';
                set({ kind, url });
            } catch (e) { set({ kind: 'binary', reason: e.message || 'Could not read file.', permissionDenied: !admin && this._looksPermissionDenied(e) }); }
        } else {
            set({ kind: 'binary', reason: 'No preview available for this file type.' });
        }
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
    },

    _showHost() {
        bootstrap.Modal.getOrCreateInstance(this.windowHostEl).show();
        this.hostVisible = true;
        this.$nextTick(() => this._syncActiveEditor());
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
            if (!this.activeWinId) {
                bootstrap.Modal.getOrCreateInstance(this.windowHostEl).hide();
                this.hostVisible = false;
            }
        });
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


    // ───── Search ────────────────────────────────────────────────────────────
    async runSearch(tab) {
        const q = tab.search.query.trim();
        if (!q) { this.clearSearch(tab); return; }

        // Build a JS regex up front if regex mode is on, so we can report a
        // bad pattern before spawning anything. The "case-insensitive" option
        // maps to the regex 'i' flag, so the two work together consistently.
        let rx = null;
        if (tab.search.regex) {
            try {
                rx = new RegExp(q, tab.search.caseInsensitive ? 'i' : '');
            } catch (e) {
                tab.error = 'Invalid regular expression: ' + (e.message || e);
                tab.errorRetryAsAdmin = false;
                return;
            }
        }

        tab.loading = true;
        tab.error = null;
        try {
            let results;
            if (tab.search.mode === 'content') {
                // grep does the regex itself: -E for extended regex, -F for
                // a literal string. -i for case-insensitive either way.
                results = await FS.searchContent(
                    tab.path, q, tab.search.recursive,
                    tab.search.caseInsensitive, tab.search.regex);
            } else {
                // Filename: list candidates, match in JS so regex + case
                // semantics are exactly JS RegExp's.
                const all = await FS.listForSearch(tab.path, tab.search.recursive);
                if (rx) {
                    results = all.filter(f => rx.test(f.name));
                } else if (tab.search.caseInsensitive) {
                    const needle = q.toLowerCase();
                    results = all.filter(f => f.name.toLowerCase().includes(needle));
                } else {
                    results = all.filter(f => f.name.includes(q));
                }
            }
            if (!this.settings.showHidden) results = results.filter(f => !f.name.startsWith('.'));
            tab.files = results;
            tab.selection = [];
            tab.search.active = true;
        } catch (e) {
            tab.error = e.message || 'Search failed';
        } finally {
            tab.loading = false;
        }
    },

    clearSearch(tab) {
        tab.search.active = false;
        tab.search.query = '';
        this._loadDir(tab);
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


    // Upload + drag&drop + archive → js/features/upload.js


    // Custom actions (+ form/JSON editor, global actions) → js/features/actions.js

    // ── Streaming-output helpers (line storage + memory cap) ──────────────
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


    // ───── Dialogs (confirm / prompt) ────────────────────────────────────────
    askConfirm(title, message, confirmLabel) {
        return new Promise(resolve => {
            this.confirmDlg = { title, message, confirmLabel: confirmLabel || 'OK', cancelLabel: 'Cancel', buttons: null, result: undefined, resolve };
            bootstrap.Modal.getOrCreateInstance(this.confirmModalEl).show();
        });
    },

    // Multi-button choice dialog. buttons: [{ id, label, variant }].
    // Resolves with the chosen id, or null if dismissed.
    askChoice(title, message, buttons) {
        return new Promise(resolve => {
            this.confirmDlg = { title, message, confirmLabel: 'OK', cancelLabel: 'Cancel', buttons: buttons || null, result: undefined, resolve };
            bootstrap.Modal.getOrCreateInstance(this.confirmModalEl).show();
        });
    },

    // Record the choice and start hiding. The promise is resolved by the
    // modal's 'hidden.bs.modal' handler so the NEXT dialog (which reuses this
    // same modal element) only opens after this one is fully closed —
    // otherwise Bootstrap's show/hide animations race and the second dialog
    // silently fails to appear.
    resolveConfirm(value) {
        if (!this.confirmDlg.resolve) return;
        this.confirmDlg.result = value;
        bootstrap.Modal.getOrCreateInstance(this.confirmModalEl).hide();
    },

    askPrompt(title, label, defaultValue, opts) {
        opts = opts || {};
        return new Promise(resolve => {
            this.promptDlg = { title, label, value: defaultValue || '', multiline: !!opts.multiline, resolve };
            bootstrap.Modal.getOrCreateInstance(this.promptModalEl).show();
        });
    },

    resolvePrompt(value) {
        const r = this.promptDlg.resolve;
        this.promptDlg.resolve = null;
        bootstrap.Modal.getOrCreateInstance(this.promptModalEl).hide();
        if (r) r(value);
    },

    // ───── Directory picker ────────────────────────────────────────────────
    // Returns a Promise<string|null> resolving to the chosen directory path.
    askDirectory(title, startPath) {
        return new Promise(resolve => {
            this.dirPicker = { open: true, title: title || 'Select a folder', path: '', entries: [], loading: true, resolve, pathInput: '' };
            bootstrap.Modal.getOrCreateInstance(this.dirPickerEl).show();
            this._dpLoad(startPath || this.homePath);
        });
    },
    async _dpLoad(path) {
        this.dirPicker.loading = true;
        this.dirPicker.path = path;
        this.dirPicker.pathInput = path;
        try {
            const list = await FS.listDir(path);
            this.dirPicker.entries = list
                .filter(e => e.type === 'd' || e.type === 'l')
                .filter(e => this.settings.showHidden || !e.name.startsWith('.'))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch (e) {
            this.toast('Cannot open ' + path + ': ' + (e.message || e), 'danger');
            this.dirPicker.entries = [];
        } finally {
            this.dirPicker.loading = false;
        }
    },
    _dpUp() {
        const parent = Util.dirname(this.dirPicker.path);
        if (parent && parent !== this.dirPicker.path) this._dpLoad(parent);
    },
    _dpEnter(entry) { this._dpLoad(entry.path); },
    _dpGoTo() { if (this.dirPicker.pathInput) this._dpLoad(this.dirPicker.pathInput); },
    async _dpNewFolder() {
        const name = await this.askPrompt('New folder', 'Folder name (created inside ' + this.dirPicker.path + ')', 'new-folder');
        if (!name) return;
        const np = Util.joinPath(this.dirPicker.path, name);
        try { await FS.mkdir(np); this._dpLoad(np); }
        catch (e) { this.toast('mkdir failed: ' + (e.message || e), 'danger'); }
    },
    _dpChoose() {
        const r = this.dirPicker.resolve;
        const chosen = this.dirPicker.pathInput || this.dirPicker.path;
        this.dirPicker.resolve = null;
        this.dirPicker.open = false;
        bootstrap.Modal.getOrCreateInstance(this.dirPickerEl).hide();
        if (r) r(chosen);
    },
    _dpCancel() {
        const r = this.dirPicker.resolve;
        this.dirPicker.resolve = null;
        this.dirPicker.open = false;
        bootstrap.Modal.getOrCreateInstance(this.dirPickerEl).hide();
        if (r) r(null);
    },

    // Interactive scripts → js/features/actions.js


    // ───── Toasts ────────────────────────────────────────────────────────────
    toast(message, kind) {
        const id = Util.uid();
        this.toasts.push({ id, message, kind: kind || 'secondary' });
        setTimeout(() => this.dismissToast(id), 4000);
    },

    dismissToast(id) {
        const idx = this.toasts.findIndex(t => t.id === id);
        if (idx >= 0) this.toasts.splice(idx, 1);
    },


    // ───── Settings ──────────────────────────────────────────────────────────
    _settingsPath() { return this.homePath + '/.config/cockpit/explorer/settings.yml'; },

    async _loadSettings() {
        const path = this._settingsPath();
        let loaded = null;
        try {
            const txt = await FS.readText(path);
            if (txt && window.jsyaml) {
                loaded = jsyaml.load(txt);
            }
        } catch (e) {}

        // Fallback migration from old localStorage settings (if any)
        if (!loaded) {
            try {
                const raw = localStorage.getItem(ExRT.const.LS_KEY_SETTINGS);
                if (raw) {
                    loaded = JSON.parse(raw);
                    // Best-effort migrate to YAML on disk
                    await this._writeSettingsYaml(loaded);
                    try { localStorage.removeItem(ExRT.const.LS_KEY_SETTINGS); } catch (e) {}
                }
            } catch (e) {}
        }

        if (loaded && typeof loaded === 'object') {
            // Deep-merge over defaults so new fields don't disappear
            Object.assign(this.settings, loaded);
            // columns is a nested object — merge defaults under it
            this.settings.columns = Object.assign({}, ExRT.const.DEFAULT_SETTINGS.columns, loaded.columns || {});
        }
        if (!this.settings.columns) this.settings.columns = structuredClone(ExRT.const.DEFAULT_SETTINGS.columns);

        // Apply theme & track system-preference changes if 'system' mode
        this.applyTheme();
        try {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            mq.addEventListener('change', () => {
                if ((this.settings.theme || 'system') === 'system') this.applyTheme();
            });
        } catch (e) {}
    },

    applyTheme() {
        const t = this.settings.theme || 'system';
        const dark = t === 'dark'
            || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
        if (window.monaco && window.monaco.editor) {
            try { window.monaco.editor.setTheme(dark ? 'vs-dark' : 'vs'); } catch (e) {}
        }
    },

    async _writeSettingsYaml(settings) {
        const path = this._settingsPath();
        try {
            await FS.mkdir(Util.dirname(path));
            const yaml = window.jsyaml ? jsyaml.dump(settings, { indent: 2, lineWidth: 100 })
                                       : JSON.stringify(settings, null, 2);
            await FS.writeText(path, yaml);
        } catch (e) {
            this.toast('Could not save settings: ' + (e.message || e), 'danger');
        }
    },

    openSettings() { bootstrap.Modal.getOrCreateInstance(this.settingsModalEl).show(); },

    saveSettings() {
        if (this._suppressSettingsSave) return;   // self-update is wiping the settings file
        // Debounce: collapse multiple rapid changes into one write
        if (this._saveSettingsTimer) clearTimeout(this._saveSettingsTimer);
        this._saveSettingsTimer = setTimeout(() => {
            this._writeSettingsYaml(this.settings);
        }, 400);
    },


    // ───── Keyboard ──────────────────────────────────────────────────────────
    onKey(ev) {
        // Don't intercept when typing in inputs
        const tag = (ev.target.tagName || '').toLowerCase();
        const inField = (tag === 'input' || tag === 'textarea' || ev.target.isContentEditable);
        const tab = this.activeTab();
        const pane = this.currentPane();
        const ctrl = ev.ctrlKey || ev.metaKey;

        if (ctrl && ev.key.toLowerCase() === 't') { ev.preventDefault(); this.newTab(pane ? pane.path : this.homePath); return; }
        if (ctrl && ev.key.toLowerCase() === 'w') { ev.preventDefault(); if (tab) this.closeTab(tab.id); return; }

        // Escape closes the top-most open popup. The editor/preview window and
        // the folder picker set Bootstrap's keyboard:false (so a native Esc
        // can't bypass the unsaved-changes prompt / forced choice), so we close
        // them here through the same paths that guard unsaved edits. This runs
        // BEFORE the inField guard below so it still fires while the Monaco
        // editor (a focused textarea) has focus. Every other modal keeps
        // Bootstrap's own Esc-to-close, so we only special-case these two.
        if (ev.key === 'Escape') {
            const shown = [...document.querySelectorAll('.modal.show')];
            const top = shown.length ? shown.reduce((a, b) =>
                (parseInt(getComputedStyle(b).zIndex) || 0) >= (parseInt(getComputedStyle(a).zIndex) || 0) ? b : a) : null;
            if (top === this.windowHostEl && this.activeWinId) { ev.preventDefault(); this.closeActiveWindow(); return; }
            if (top === this.dirPickerEl && this.dirPicker.open) { ev.preventDefault(); this._dpCancel(); return; }
        }

        if (inField) return;

        if (ev.key === 'F5') { ev.preventDefault(); if (pane) this.reload(pane); return; }
        if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); if (pane) this.goBack(pane); return; }
        if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); if (pane) this.goForward(pane); return; }
        if (ev.altKey && ev.key === 'ArrowUp') { ev.preventDefault(); if (pane) this.goUp(pane); return; }
        // Tab / Ctrl-Tab moves focus between panes in dual mode
        if (ev.key === 'Tab' && tab && tab.dual) {
            ev.preventDefault();
            tab.activePaneId = tab.activePaneId === 'b' ? 'a' : 'b';
            return;
        }

        if (ev.key === ' ' && pane && pane.kind === 'dir') {
            const sel = this.selectedFiles(pane);
            if (sel.length === 1 && this.isPreviewable(sel[0])) { ev.preventDefault(); this.openPreview(sel[0]); }
            return;
        }
        if (ev.key === 'F2' && tab) { ev.preventDefault(); this.renameSelected(); return; }
        if (ev.key === 'Delete' && tab) { ev.preventDefault(); this.deleteSelected(); return; }
        if (ev.key === 'Enter' && pane) {
            const sel = this.selectedFiles(pane);
            if (sel.length === 1) { ev.preventDefault(); this.openFile(pane, sel[0]); }
            return;
        }
        // Only stage files for Copy/Cut when the user isn't selecting text. A
        // live text selection (e.g. in a file Preview's <pre>, which is not a
        // form field so `inField` above is false) must fall through to the
        // browser's native copy — otherwise Ctrl/⌘+C is hijacked into file-copy
        // and selected text can never be copied. Normal file browsing keeps
        // file names unselectable (user-select:none), so this stays empty then.
        const hasTextSelection = !!(window.getSelection && String(window.getSelection()).trim());
        if (ctrl && ev.key.toLowerCase() === 'c' && tab && !hasTextSelection) { ev.preventDefault(); this.copyToClipboard('copy'); return; }
        if (ctrl && ev.key.toLowerCase() === 'x' && tab && !hasTextSelection) { ev.preventDefault(); this.copyToClipboard('cut'); return; }
        if (ctrl && ev.key.toLowerCase() === 'v' && tab) { ev.preventDefault(); this.paste(); return; }
        if (ctrl && ev.key.toLowerCase() === 'a' && pane) {
            ev.preventDefault();
            pane.selection = this.sortedFiles(pane).map(f => f.path);
            return;
        }
        if (ctrl && ev.key.toLowerCase() === 'f' && tab) {
            ev.preventDefault();
            const inp = document.querySelector('.tab-pane:not([style*="display: none"]) .search-box input');
            if (inp) inp.focus();
            return;
        }
        if (ev.key === 'Escape' && this.ctxMenu.open) { this.closeContextMenu(); return; }
    },

    // ═════════════════════════════════════════════════════════════════════════
    // ═══════════════ RUN COMMAND & GITHUB INTEGRATION ════════════════════════
    // ═════════════════════════════════════════════════════════════════════════

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

    // GitHub panel/update/checkout/commit/publish → js/features/github.js

}));

}); // alpine:init
