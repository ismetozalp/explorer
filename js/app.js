// app.js — Alpine.js component for the explorer
'use strict';

document.addEventListener('alpine:init', () => {

const DEFAULT_SETTINGS = {
    showHidden: true,
    followSymlinks: true,
    persistTabs: true,
    columns: { size: true, modified: true, perms: true, owner: true, type: false },
    previewLimitMB: 10,
    uploadChunkMB: 4,
    outputMaxLines: 5000,      // streaming-pane line cap (0 = unlimited; oldest lines drop)
    theme: 'system',           // 'system' | 'light' | 'dark'
    updateRepo: 'ismetozalp/explorer',  // GitHub owner/repo (or releases URL) to check for updates
    updateCheckOnStart: true,           // auto-check for a newer release at startup
};

const USER_ACTIONS_PATH_SUFFIX = '/.config/cockpit/explorer/actions.json';
const SYSTEM_ACTIONS_PATH = '/etc/cockpit/explorer/actions.json';
const USER_SCRIPTS_DIR_SUFFIX = '/.config/cockpit/explorer/scripts';
const SYSTEM_SCRIPTS_DIR = '/etc/cockpit/explorer/scripts';
// Explorer Script Prompt Protocol: a script asks for input by printing a YAML
// block between these two sentinel lines, then reading one line from stdin.
// A block whose `type` is a display type (message/info/progress/…) is shown
// without asking for input; ===EXPLORER-MESSAGE=== is an alias start marker.
const PROMPT_START = '===EXPLORER-PROMPT===';
const MSG_START = '===EXPLORER-MESSAGE===';
const PROMPT_END = '===EXPLORER-END===';
const DISPLAY_TYPES = ['message', 'info', 'note', 'notify', 'progress', 'status', 'log'];
const LS_KEY_TABS = 'explorer:tabs';
const LS_KEY_SETTINGS = 'explorer:settings';

// Op callbacks (cancel fn, retry-as-admin fn) live OUTSIDE the reactive
// state. Putting a function on a reactive op object causes Alpine to
// evaluate it as part of dependency tracking — assigning `op.cancel = fn`
// was triggering `op.cancel()` to fire immediately, which closed the
// cockpit channel with problem:'cancelled' before the operation could
// even run. Storing here, keyed by op.id, sidesteps the reactivity path.
const _opCallbacks = new Map();
function _setOpCallback(opId, key, fn) {
    let entry = _opCallbacks.get(opId);
    if (!entry) { entry = {}; _opCallbacks.set(opId, entry); }
    entry[key] = fn;
}
function _getOpCallback(opId, key) {
    const entry = _opCallbacks.get(opId);
    return entry ? entry[key] : null;
}
function _clearOpCallbacks(opId) { _opCallbacks.delete(opId); }

// Integrated terminal instances (v1.1). Same reasoning as _opCallbacks:
// xterm Terminal / cockpit channel instances must NOT live on Alpine
// reactive state — Alpine would try to deep-walk them, observe getter
// side effects, and otherwise break xterm's internals. Keep them
// purely module-scoped, keyed by tab.id; the reactive `tab.term` carries
// only plain primitives (open, width, dir).
const _termInstances = new Map();
function _setTermInstance(tabId, val) { _termInstances.set(tabId, val); }
function _getTermInstance(tabId)      { return _termInstances.get(tabId); }
function _deleteTermInstance(tabId) {
    const inst = _termInstances.get(tabId);
    if (!inst) return;
    try { inst.channel && inst.channel.close('terminated'); } catch (e) {}
    try { inst.term && inst.term.dispose(); } catch (e) {}
    _termInstances.delete(tabId);
}

// Monaco editor + model instances are kept in module scope, NOT in Alpine's
// reactive state. Monaco objects are enormous and self-referential; letting
// Vue's reactivity proxy them deep-walks that graph and freezes the page
// (same reasoning as _termInstances above).
let _fileEditor = null;                                 // single Monaco instance (reused across editor windows)
const _winModels = new Map();                           // windowId -> Monaco ITextModel
let _actionsEditor = null, _actionsEditorModel = null;  // custom-actions JSON/YAML editor
let _quillEditor = null;                                // WYSIWYG editor (md/html)

Alpine.data('explorer', () => ({

    // ───── State ─────────────────────────────────────────────────────────────
    tabs: [],
    activeTabId: null,
    homePath: '/root',

    settings: structuredClone(DEFAULT_SETTINGS),

    // Self-update / release-check state
    updateState: { checking: false, available: null },

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

    settingsModalEl: null,

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
                    const raw = localStorage.getItem(LS_KEY_TABS);
                    if (raw) {
                        data = JSON.parse(raw);
                        try { localStorage.removeItem(LS_KEY_TABS); } catch (e) {}
                    }
                } catch (e) {}
            }
            if (data && data.windows) savedWindows = data.windows;
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
                if (!this._ghGitConfigured && await GIT.ghAvailable() && (await GIT.ghAuthStatus()).authed) {
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
            // ── Terminals (v1.2) ───────────────────────────────────────
            // Reactive collection only; the actual xterm Terminal /
            // cockpit channel instances live in module-scope _termInstances
            // keyed by terminal.id. Used by both kind='dir' (split pane)
            // and kind='terminal' (full-tab terminal stack).
            terminals: [],          // [{ id, dir, label }]
            activeTermId: null,
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
        try { (tab.terminals || []).forEach(t => _deleteTermInstance(t.id)); } catch(e){}
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
        }
        this._refreshTabGit(tab);
    },
    activeTab() { return this.tabs.find(t => t.id === this.activeTabId); },
    currentTab() { return this.activeTab(); },

    tabLabel(tab) {
        if (tab.kind === 'output') return '▶ ' + (tab.outputActionLabel || 'output');
        if (tab.kind === 'terminal') return '▤ Terminal';
        if (tab.path === '/') return '/';
        return Util.basename(tab.path) || tab.path;
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
                const data = {
                    tabs: dirTabs.map(t => ({ path: t.path, kind: t.kind })),
                    activeIdx: idx,
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
        tab.loading = true;
        tab.error = null;
        tab.errorRetryAsAdmin = false;
        try {
            let files = await FS.listDir(tab.path, { admin: opts.admin });
            if (!this.settings.showHidden) files = files.filter(f => !f.name.startsWith('.'));
            tab.files = files;
            // Prune selection to items still present
            const visible = new Set(files.map(f => f.path));
            tab.selection = tab.selection.filter(p => visible.has(p));
            tab.loaded = true;
        } catch (e) {
            tab.error = e.message || 'Failed to read directory';
            tab.errorRetryAsAdmin = e.permissionDenied || !opts.admin;
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
        this.ctxMenu = { open: true, x: ev.clientX, y: ev.clientY, kind: 'empty', target: null, tabId: tab ? tab.id : null };
        this._clampCtxMenu();
    },

    onRowContextMenu(ev, pane, file) {
        const tab = this.activeTab();
        this._activatePaneRef(tab, pane);
        // If the row isn't in current selection, select just it.
        if (!pane.selection.includes(file.path)) pane.selection = [file.path];
        this.ctxMenu = { open: true, x: ev.clientX, y: ev.clientY, kind: 'file', target: file, tabId: tab ? tab.id : null };
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
            _setOpCallback(op.id, 'cancel', () => { try { channel.close('cancelled'); } catch (e) {} });
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
            _setOpCallback(op.id, 'cancel', () => { try { channel.close('cancelled'); } catch(e){} });
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
            id, kind: 'preview', path: file.path,
            title: this._winTitle(file.path, 'preview'),
            pv: { kind: null, content: '', lang: '', url: null, reason: '' },
            loading: true,
        });
        this.activateWindow(id, !opts.minimized);
        await this._loadPreviewInto(id, file);
    },

    async _loadPreviewInto(id, file) {
        const limit = (this.settings.previewLimitMB || 10) * 1024 * 1024;
        const set = (pv) => { const w = this._win(id); if (w) { w.pv = pv; w.loading = false; } };
        if (Util.isTextLike(file)) {
            if (file.size > limit) { set({ kind: 'binary', reason: `File too large (${Util.humanSize(file.size)}; limit ${this.settings.previewLimitMB} MB).` }); return; }
            try {
                const txt = await FS.readText(file.path);
                if (Util.looksBinary(txt)) set({ kind: 'binary', reason: 'This looks like a binary file and can’t be shown as text.' });
                else {
                    const lang = Util.langFromExt(file.name);
                    if (lang !== 'plain' && window.loadPrismLanguage) await window.loadPrismLanguage(lang);
                    set({ kind: 'text', content: txt || '', lang });
                }
            } catch (e) { set({ kind: 'binary', reason: e.message || 'Could not read file.' }); }
        } else if (Util.isImage(file) || Util.isPdf(file) || Util.isVideo(file) || Util.isAudio(file)) {
            try {
                const blob = await FS.readBinaryAsBlob(file.path);
                const url = URL.createObjectURL(blob);
                let kind = 'binary';
                if (Util.isImage(file)) kind = 'image';
                else if (Util.isPdf(file)) kind = 'pdf';
                else if (Util.isVideo(file)) kind = 'video';
                else if (Util.isAudio(file)) kind = 'audio';
                set({ kind, url });
            } catch (e) { set({ kind: 'binary', reason: e.message || 'Could not read file.' }); }
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
        if (prev && prev.id !== id && prev.kind === 'editor' && prev.mode === 'wysiwyg' && _quillEditor) {
            prev.quillHtml = _quillEditor.root.innerHTML;
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
        if (_fileEditor) return;
        const container = document.getElementById('monacoContainer');
        if (!container || !window.monaco) return;
        const dark = (document.documentElement.getAttribute('data-bs-theme') === 'dark');
        _fileEditor = window.monaco.editor.create(container, {
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
        const model = _winModels.get(w.id);
        if (_fileEditor && model && _fileEditor.getModel() !== model) {
            _fileEditor.setModel(model);
            _fileEditor.updateOptions({ readOnly: !!w.readOnly });
        }
        if (w.mode === 'wysiwyg') {
            this._mountQuill(w.quillHtml != null ? w.quillHtml : '');
        }
        if (_fileEditor) { try { _fileEditor.layout(); if (w.mode === 'code') _fileEditor.focus(); } catch (e) {} }
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
        try { content = await FS.readText(file.path); }
        catch (e) { this.toast('Could not open: ' + (e.message || e), 'danger'); return; }
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
        _winModels.set(id, model);

        this.windows.push({
            id, kind: 'editor', path: file.path, title: this._winTitle(file.path, 'editor'),
            lang, mode: 'code', dirty: false, isMarkdown: isMd, isHtml: isHtml,
            canWysiwyg: isMd || isHtml, original: content || '', error: '', permissionDenied: false,
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
        _winModels.set(id, model);
        this.windows.push({
            id, kind: 'editor', path: null, title: title || 'View', lang: lang || '',
            mode: 'code', dirty: false, isMarkdown: false, isHtml: false, canWysiwyg: false,
            original: content || '', error: '', permissionDenied: false, quillHtml: null, readOnly: true,
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
        _quillEditor = new window.Quill(editorDiv, {
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
        _quillEditor.root.innerHTML = htmlContent || '';
        _quillEditor.on('text-change', () => { const w = this.activeWin(); if (w && w.kind === 'editor') w.dirty = true; });
    },

    async setEditorMode(mode) {
        const w = this.activeWin();
        if (!w || w.kind !== 'editor') return;
        if (mode === w.mode) return;
        if (!w.canWysiwyg && mode === 'wysiwyg') return;
        if (w.mode === 'code' && _fileEditor) {
            const code = _fileEditor.getValue();
            let html;
            if (w.isMarkdown) { await this._ensureMarked(); html = window.marked.parse(code); }
            else html = code;
            w.mode = 'wysiwyg';
            w.quillHtml = html;
            this.$nextTick(() => this._mountQuill(html));
        } else if (w.mode === 'wysiwyg' && _quillEditor) {
            const html = _quillEditor.root.innerHTML;
            let code;
            if (w.isMarkdown) { await this._ensureTurndown(); const td = new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }); code = td.turndown(html); }
            else code = html;
            w.mode = 'code';
            w.quillHtml = null;
            const m = _winModels.get(w.id); if (m) m.setValue(code);
            this.$nextTick(() => { if (_fileEditor) _fileEditor.focus(); });
        }
    },

    async _getEditorContent() {
        const w = this.activeWin();
        if (w && w.kind === 'editor' && w.mode === 'wysiwyg' && _quillEditor) {
            const html = _quillEditor.root.innerHTML;
            if (w.isMarkdown) { await this._ensureTurndown(); const td = new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }); return td.turndown(html); }
            return html;
        }
        const m = w ? _winModels.get(w.id) : null;
        if (m) return m.getValue();
        return w ? w.original : '';
    },

    async saveEditor(admin) {
        const w = this.activeWin();
        if (!w || w.kind !== 'editor' || w.readOnly || !w.path) return;
        try {
            const content = await this._getEditorContent();
            await FS.writeText(w.path, content, { admin: !!admin });
            w.original = content; w.dirty = false; w.error = ''; w.permissionDenied = false;
            this.toast('Saved ' + w.path);
            const tab = this.activeTab();
            if (tab && tab.kind === 'dir' && Util.dirname(w.path) === tab.path) this.reload(tab);
        } catch (e) {
            w.error = e.message || String(e);
            if (/permission|EACCES/i.test(w.error)) w.permissionDenied = true;
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
                const m = _winModels.get(id);
                if (m) {
                    if (_fileEditor && _fileEditor.getModel() === m) _fileEditor.setModel(null);
                    try { m.dispose(); } catch (e) {}
                    _winModels.delete(id);
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
        // Multi-file: ask format, compress to /tmp, download
        // Rough size estimate from listed file sizes (dirs unknown).
        const roughTotal = sel.reduce((s, f) => s + (f.type === 'f' ? f.size : 0), 0);
        if (roughTotal > 1024 * 1024 * 1024) {
            const ok = await this.askConfirm('Large download',
                `Selection contains ~${Util.humanSize(roughTotal)} of files (directories not measured). Compressing and streaming this through the browser will use a lot of memory and may take a while. For very large transfers, scp/sftp is generally safer. Continue?`,
                'Continue');
            if (!ok) return;
        }
        const fmt = await this.askPrompt('Multi-file download', 'Archive format (zip, tar.gz, tar.bz2, tar.xz)', 'zip');
        if (!fmt) return;
        const allowed = ['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz'];
        if (!allowed.includes(fmt)) { this.toast('Unsupported format: ' + fmt, 'danger'); return; }
        const tmp = `/tmp/explorer-${Util.uid()}.${fmt}`;
        const op = this._beginOp(`Compress ${sel.length} item(s) for download`);
        try {
            await FS.compress(sel.map(f => f.path), tmp, fmt);
            const blob = await FS.readBinaryAsBlob(tmp);
            this._triggerDownload(blob, `download.${fmt}`);
            await FS.remove([tmp]);
            this._endOp(op, 'done');
        } catch (e) {
            this._failOp(op, e);
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


    // ───── Upload ────────────────────────────────────────────────────────────
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
        op.indeterminate = true;
        op.statusText = `${Util.humanSize(file.size)}…`;
        try {
            // Read whole file as base64 (single-shot upload — works for
            // hundreds of MB before browser memory becomes the bottleneck).
            const b64 = await new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => {
                    const s = r.result || '';
                    const i = s.indexOf(',');
                    resolve(i >= 0 ? s.slice(i + 1) : s);
                };
                r.onerror = () => reject(new Error('FileReader failed'));
                r.readAsDataURL(file);
            });
            // Drive a stream channel: spawn `base64 -d > dest`, write the
            // base64 to its stdin, send the `done` control to half-close,
            // then wait for the channel's close event. Same channel pattern
            // that works for rsync; sidesteps the cancellation we saw from
            // cockpit.spawn(..., {input: …}).
            await new Promise((resolve, reject) => {
                const channel = cockpit.channel({
                    payload: 'stream',
                    spawn: ['sh', '-c', `base64 -d > ${Util.shq(dest)}`],
                    err: 'out',
                });
                _setOpCallback(op.id, 'cancel', () => { try { channel.close('cancelled'); } catch (e) {} });
                op.canCancel = true;
                channel.addEventListener('close', (ev, info) => {
                    if (info && info.problem === 'cancelled') return reject(new Error('Cancelled'));
                    if (info && info.problem) {
                        const e = new Error(info.message || info.problem);
                        e.problem = info.problem;
                        return reject(e);
                    }
                    const status = info && info['exit-status'];
                    if (status != null && status !== 0) return reject(new Error('base64 exit ' + status));
                    resolve();
                });
                channel.send(b64);
                channel.control({ command: 'done' });
            });
            this._endOp(op, 'done');
        } catch (e) {
            console.error('Upload failed:', e, 'dest:', dest);
            this._failOp(op, e);
        }
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

        // Destination: dropping onto a *directory* row drops INTO that folder;
        // anywhere else (empty space, or a file row) lands in the pane's folder.
        const intoDir = targetFile && (targetFile.type === 'd' || (targetFile.type === 'l' && targetFile.symlinkTarget));
        const target = intoDir ? targetFile.path : pane.path;

        // From OS (upload)
        if (ev.dataTransfer.files && ev.dataTransfer.files.length) {
            const files = Array.from(ev.dataTransfer.files);
            // Upload into `target` (a subfolder, or the pane's folder).
            const dst = { path: target };
            for (const f of files) await this._uploadOne(dst, f);
            this.reload(pane);
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


    // ───── Custom actions ────────────────────────────────────────────────────
    _normalizeAction(a) {
        return {
            id: a.id || Util.uid(),
            label: a.label || '',
            command: a.command || '',
            appliesTo: a.appliesTo || '',
            pattern: a.pattern || '',
            output: a.output || 'toast',
            privilege: a.privilege || 'user',
            confirm: !!a.confirm,
            confirmMessage: a.confirmMessage || '',
            preCommand: a.preCommand || '',
            preConfirm: a.preConfirm || '',
            preConfirmLabel: a.preConfirmLabel || '',
            postCommand: a.postCommand || '',
            postConfirm: a.postConfirm || '',
            postConfirmLabel: a.postConfirmLabel || '',
            interactive: !!a.interactive,
            script: a.script || '',
            multi: a.multi !== false,
        };
    },

    async _loadCustomActions(scope) {
        const path = scope === 'user'
            ? this.homePath + USER_ACTIONS_PATH_SUFFIX
            : SYSTEM_ACTIONS_PATH;
        try {
            const txt = await FS.readText(path);
            if (txt) {
                const data = JSON.parse(txt);
                if (Array.isArray(data.actions)) {
                    this.customActions[scope] = data.actions.map(a => this._normalizeAction(a));
                }
            }
        } catch (e) {
            // File doesn't exist yet — that's fine
        }
        this.actionsMgr.loaded[scope] = true;
    },

    // Built-in actions ship with the plugin (e.g. the self-update action) and
    // are always current with the installed version. They're loaded from the
    // package dir, NOT the editable /etc file, so updating the plugin updates
    // them and they can't be clobbered or fall out of date.
    async _loadBuiltinActions() {
        let txt = '';
        try {
            const r = await fetch('actions/system-actions.json', { cache: 'no-store' });
            if (r.ok) txt = await r.text();
        } catch (e) {}
        if (!txt) {
            try { txt = await FS.readText('/usr/share/cockpit/explorer/actions/system-actions.json'); } catch (e) {}
        }
        if (!txt) return;
        try {
            const data = JSON.parse(txt);
            const list = Array.isArray(data) ? data : (data && Array.isArray(data.actions) ? data.actions : []);
            this.customActions.builtin = list.map(a => this._normalizeAction(a));
        } catch (e) {
            console.warn('[explorer] could not parse built-in actions:', e);
        }
    },

    // Upload a local shell script into the current scope's scripts/ folder and
    // wire the action to run it interactively (bash {script}).
    async uploadActionScript(ev) {
        const file = ev && ev.target && ev.target.files && ev.target.files[0];
        if (!file) return;
        const scope = this.actionsMgr.scope;
        const a = this.customActions[scope][this.actionsMgr.editingIdx];
        if (!a) { ev.target.value = ''; return; }
        let text;
        try { text = await file.text(); }
        catch (e) { this.toast('Could not read ' + file.name + ': ' + (e.message || e), 'danger'); ev.target.value = ''; return; }
        const dir = this._scriptsDir(scope);
        const dest = Util.joinPath(dir, file.name);
        try {
            await FS.mkdir(dir, { adminTry: scope === 'system' });
            await FS.writeText(dest, text, { adminTry: scope === 'system' });
        } catch (e) { this.toast('Upload failed: ' + (e.message || e), 'danger'); ev.target.value = ''; return; }
        a.script = file.name;
        a.interactive = true;
        if (!a.command || !a.command.trim()) a.command = 'bash {script}';
        if (a.output === 'toast') a.output = 'pane';
        this.toast('Uploaded ' + file.name + ' → ' + dir);
        ev.target.value = '';
    },

    // Upload a local shell script into the current scope's scripts/ folder and
    // wire the action to run it interactively (bash {script}).
    async uploadActionScript(ev) {
        const file = ev && ev.target && ev.target.files && ev.target.files[0];
        if (!file) return;
        const scope = this.actionsMgr.scope;
        const a = this.customActions[scope][this.actionsMgr.editingIdx];
        if (!a) { ev.target.value = ''; return; }
        let text;
        try { text = await file.text(); }
        catch (e) { this.toast('Could not read ' + file.name + ': ' + (e.message || e), 'danger'); ev.target.value = ''; return; }
        const dir = this._scriptsDir(scope);
        const dest = Util.joinPath(dir, file.name);
        try {
            await FS.mkdir(dir, { adminTry: scope === 'system' });
            await FS.writeText(dest, text, { adminTry: scope === 'system' });
        } catch (e) { this.toast('Upload failed: ' + (e.message || e), 'danger'); ev.target.value = ''; return; }
        a.script = file.name;
        a.interactive = true;
        if (!a.command || !a.command.trim()) a.command = 'bash {script}';
        if (a.output === 'toast') a.output = 'pane';
        this.toast('Uploaded ' + file.name + ' → ' + dir);
        ev.target.value = '';
    },

    async saveCustomActions() {
        // In code view, parse the textarea into the model first; abort on error.
        if (this.actionsMgr.mode === 'code') {
            const parsed = this._parseActionsCode();
            if (parsed === null) return; // codeError already set & shown
            this.customActions[this.actionsMgr.scope] = parsed;
        }
        const scope = this.actionsMgr.scope;
        const path = scope === 'user'
            ? this.homePath + USER_ACTIONS_PATH_SUFFIX
            : SYSTEM_ACTIONS_PATH;
        const dir = Util.dirname(path);
        const data = JSON.stringify({ actions: this.customActions[scope] }, null, 2);
        this.actionsMgr.error = '';
        try {
            await FS.mkdir(dir, { adminTry: scope === 'system' });
            await FS.writeText(path, data, { adminTry: scope === 'system' });
            this.toast('Saved ' + path);
        } catch (e) {
            this.actionsMgr.error = e.message || String(e);
        }
    },

    openActionsManager() {
        this.actionsMgr.scope = 'user';
        this.actionsMgr.editingIdx = this.customActions.user.length ? 0 : null;
        this.actionsMgr.mode = 'form';
        this.actionsMgr.codeError = '';
        this.actionsMgr.monacoFailed = false;
        this._disposeActionsMonaco();
        bootstrap.Modal.getOrCreateInstance(this.actionsModalEl).show();
    },

    // ── Form ↔ JSON/YAML editing ───────────────────────────────────────
    _serializeActions(scope, format) {
        const arr = (this.customActions[scope] || []).map(a => {
            const o = {
                label: a.label || '',
                command: a.command || '',
                appliesTo: a.appliesTo || '',
                pattern: a.pattern || '',
                output: a.output || 'toast',
                privilege: a.privilege || 'user',
                confirm: !!a.confirm,
                multi: a.multi !== false,
            };
            // Only include the optional pre/post + message fields when set, to
            // keep the document tidy.
            if (a.confirmMessage) o.confirmMessage = a.confirmMessage;
            if (a.interactive) o.interactive = true;
            if (a.script) o.script = a.script;
            if (a.preCommand) o.preCommand = a.preCommand;
            if (a.preConfirm) o.preConfirm = a.preConfirm;
            if (a.preConfirmLabel) o.preConfirmLabel = a.preConfirmLabel;
            if (a.postCommand) o.postCommand = a.postCommand;
            if (a.postConfirm) o.postConfirm = a.postConfirm;
            if (a.postConfirmLabel) o.postConfirmLabel = a.postConfirmLabel;
            return o;
        });
        const obj = { actions: arr };
        if (format === 'yaml') {
            return (window.jsyaml ? jsyaml.dump(obj, { indent: 2, lineWidth: 100 }) : JSON.stringify(obj, null, 2));
        }
        return JSON.stringify(obj, null, 2);
    },

    // Parse the code textarea into the normalized action list. Returns the
    // array on success, or null (and sets codeError) on failure.
    _parseActionsCode() {
        const text = (this.actionsMgr.codeText || '').trim();
        if (!text) return [];
        let data;
        try {
            if (this.actionsMgr.codeFormat === 'yaml') {
                if (!window.jsyaml) throw new Error('YAML support unavailable');
                data = jsyaml.load(text);
            } else {
                data = JSON.parse(text);
            }
        } catch (e) {
            this.actionsMgr.codeError = (this.actionsMgr.codeFormat.toUpperCase()) + ' parse error: ' + (e.message || e);
            return null;
        }
        // Accept either {actions:[...]} or a bare [...] array.
        const list = Array.isArray(data) ? data : (data && Array.isArray(data.actions) ? data.actions : null);
        if (!list) {
            this.actionsMgr.codeError = 'Expected an "actions" array (or a top-level list).';
            return null;
        }
        const valid = ['toast', 'modal', 'tray', 'pane'];
        const privs = ['user', 'try', 'require'];
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const a = list[i] || {};
            if (typeof a.command !== 'string' || !a.command.trim()) {
                this.actionsMgr.codeError = `Action #${i + 1}: "command" is required.`;
                return null;
            }
            out.push({
                id: a.id || Util.uid(),
                label: (a.label || '').toString() || 'Action',
                command: a.command,
                appliesTo: a.appliesTo || '',
                pattern: a.pattern || '',
                output: valid.includes(a.output) ? a.output : 'toast',
                privilege: privs.includes(a.privilege) ? a.privilege : 'user',
                confirm: !!a.confirm,
                confirmMessage: a.confirmMessage || '',
                preCommand: a.preCommand || '',
                preConfirm: a.preConfirm || '',
                preConfirmLabel: a.preConfirmLabel || '',
                postCommand: a.postCommand || '',
                postConfirm: a.postConfirm || '',
                postConfirmLabel: a.postConfirmLabel || '',
                interactive: !!a.interactive,
                script: a.script || '',
                multi: a.multi !== false,
            });
        }
        this.actionsMgr.codeError = '';
        return out;
    },

    setActionsMode(mode) {
        if (mode === this.actionsMgr.mode) return;
        if (mode === 'code') {
            // entering code view → serialize current actions and mount Monaco
            this.actionsMgr.codeText = this._serializeActions(this.actionsMgr.scope, this.actionsMgr.codeFormat);
            this.actionsMgr.codeError = '';
            this.actionsMgr.mode = 'code';
            this.$nextTick(() => this._mountActionsMonaco());
        } else {
            // leaving code view → parse back into the form model
            const parsed = this._parseActionsCode();
            if (parsed === null) return; // stay in code view, error shown
            this.customActions[this.actionsMgr.scope] = parsed;
            this.actionsMgr.editingIdx = parsed.length ? 0 : null;
            this.actionsMgr.mode = 'form';
            this._disposeActionsMonaco();
        }
    },

    setActionsCodeFormat(format) {
        if (format === this.actionsMgr.codeFormat) return;
        const parsed = this._parseActionsCode();
        this.actionsMgr.codeFormat = format;
        if (parsed !== null) {
            this.customActions[this.actionsMgr.scope] = parsed; // keep model in sync
            this._setActionsCode(this._serializeActions(this.actionsMgr.scope, format));
            this.actionsMgr.codeError = '';
        }
        if (_actionsEditorModel && window.monaco) {
            try { window.monaco.editor.setModelLanguage(_actionsEditorModel, format === 'yaml' ? 'yaml' : 'json'); } catch (e) {}
        }
    },

    // Re-serialize when the scope tab changes while in code view.
    switchActionsScope(scope) {
        if (this.actionsMgr.mode === 'code') {
            const parsed = this._parseActionsCode();
            if (parsed !== null) this.customActions[this.actionsMgr.scope] = parsed;
        }
        this.actionsMgr.scope = scope;
        this.actionsMgr.editingIdx = this.customActions[scope].length ? 0 : null;
        this.actionsMgr.codeError = '';
        if (this.actionsMgr.mode === 'code') {
            this._setActionsCode(this._serializeActions(scope, this.actionsMgr.codeFormat));
        }
    },

    // ── Monaco-backed code editor for the actions JSON/YAML ──────────────
    _setActionsCode(text) {
        this.actionsMgr.codeText = text;
        if (_actionsEditorModel) {
            this._actionsCodeSyncing = true;
            try { _actionsEditorModel.setValue(text); } catch (e) {}
            this._actionsCodeSyncing = false;
        }
    },

    async _mountActionsMonaco() {
        const el = document.getElementById('actionsMonaco');
        if (!el) return;
        try { await this._ensureMonaco(); }
        catch (e) { this.actionsMgr.monacoFailed = true; return; }   // fall back to <textarea>
        if (this.actionsMgr.mode !== 'code') return; // user left while loading
        this._disposeActionsMonaco();
        const lang = this.actionsMgr.codeFormat === 'yaml' ? 'yaml' : 'json';
        const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
        _actionsEditorModel = window.monaco.editor.createModel(this.actionsMgr.codeText || '', lang);
        _actionsEditor = window.monaco.editor.create(el, {
            model: _actionsEditorModel,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            tabSize: 2,
            scrollBeyondLastLine: false,
            theme: dark ? 'vs-dark' : 'vs',
        });
        _actionsEditorModel.onDidChangeContent(() => {
            if (this._actionsCodeSyncing) return;
            this.actionsMgr.codeText = _actionsEditor.getValue();
        });
        this.actionsMgr.monacoFailed = false;
    },

    _disposeActionsMonaco() {
        if (_actionsEditor) { try { _actionsEditor.dispose(); } catch (e) {} _actionsEditor = null; }
        if (_actionsEditorModel) { try { _actionsEditorModel.dispose(); } catch (e) {} _actionsEditorModel = null; }
    },

    _blankAction() {
        return {
            id: Util.uid(), label: 'New action', command: 'echo {path}', appliesTo: '', pattern: '',
            output: 'tray', privilege: 'user', confirm: false, confirmMessage: '',
            preCommand: '', preConfirm: '', preConfirmLabel: '',
            postCommand: '', postConfirm: '', postConfirmLabel: '', multi: true,
        };
    },

    addCustomAction() {
        const scope = this.actionsMgr.scope;
        if (this.actionsMgr.mode === 'code') {
            const parsed = this._parseActionsCode();
            if (parsed === null) { this.toast('Fix the JSON/YAML errors first', 'danger'); return; }
            parsed.push(this._blankAction());
            this.customActions[scope] = parsed;
            this._setActionsCode(this._serializeActions(scope, this.actionsMgr.codeFormat));
            return;
        }
        this.customActions[scope].push(this._blankAction());
        this.actionsMgr.editingIdx = this.customActions[scope].length - 1;
    },

    removeCustomAction() {
        // Form-mode "Delete this action" → delete the one being edited.
        this.removeActionAt(this.actionsMgr.editingIdx);
    },

    // Delete the action at index i; works in both Form and JSON/YAML modes.
    removeActionAt(i) {
        if (i == null || i < 0) return;
        const scope = this.actionsMgr.scope;
        if (this.actionsMgr.mode === 'code') {
            const parsed = this._parseActionsCode();
            if (parsed === null) { this.toast('Fix the JSON/YAML errors first', 'danger'); return; }
            if (i >= parsed.length) return;
            parsed.splice(i, 1);
            this.customActions[scope] = parsed;
            this._setActionsCode(this._serializeActions(scope, this.actionsMgr.codeFormat));
            return;
        }
        this.customActions[scope].splice(i, 1);
        this.actionsMgr.editingIdx = this.customActions[scope].length ? Math.min(i, this.customActions[scope].length - 1) : null;
    },

    appliesToLabel(v) {
        return ({
            '': 'all items', both: 'files & directories', file: 'files',
            dir: 'directories', symlink: 'symlinks', archive: 'archives',
        })[v || ''] || (v || 'all items');
    },

    applicableActions(file) {
        const tab = this.currentPane();
        if (!tab) return [];
        const sel = this.selectedFiles(tab);
        // Built-in actions (e.g. self-update) ship with the plugin and are
        // authoritative for their ids: drop any stale editable action that was
        // seeded with the same id in a previous version. Each action is tagged
        // with its source so the menu can show a user/system badge.
        const builtin = this.customActions.builtin || [];
        const builtinIds = new Set(builtin.map(a => a.id));
        const tagged = [
            ...builtin.map(a => ({ a, source: 'system' })),
            ...this.customActions.system.filter(a => !builtinIds.has(a.id)).map(a => ({ a, source: 'system' })),
            ...this.customActions.user.filter(a => !builtinIds.has(a.id)).map(a => ({ a, source: 'user' })),
        ];
        const targets = sel.length > 0 ? sel : (file ? [file] : []);
        const anyInCache = targets.some(t => this.insideAnyRepoCache(t.path));
        return tagged.filter(({ a }) => {
            if (!file && sel.length === 0) return false;
            if (targets.length > 1 && !a.multi) return false;
            if (a.appliesTo) {
                const ok = targets.every(t => {
                    if (a.appliesTo === 'file') return t.type === 'f';
                    if (a.appliesTo === 'dir') return t.type === 'd';
                    if (a.appliesTo === 'both') return t.type === 'f' || t.type === 'd';
                    if (a.appliesTo === 'symlink') return !!t.symlinkTarget || t.type === 'l';
                    if (a.appliesTo === 'archive') return Util.isArchive(t);
                    return true;
                });
                if (!ok) return false;
            }
            if (a.pattern) {
                let re;
                try { re = new RegExp(a.pattern); }
                catch(e) { return false; }
                if (!targets.every(t => re.test(t.name))) return false;
            }
            // Cache-safety: in repo caches, only allow actions whose output mode
            // is read-only by nature (toast/modal/pane), unless explicitly opted in.
            if (anyInCache && !a.allowOnRepoCache) {
                const readOnlyOutput = (a.output === 'toast' || a.output === 'modal' || a.output === 'pane');
                if (!readOnlyOutput) return false;
            }
            return true;
        }).map(({ a, source }) => ({ ...a, _source: source }));
    },

    // Build the template context (paths + version tokens) for an action.
    _actionContext(files) {
        const first = files[0];
        const m = first.name.match(/^explorer-(\d+\.\d+(?:\.\d+)?)\.zip$/);
        return {
            path: first.path,
            paths: files.map(f => f.path),
            dir: Util.dirname(first.path),
            name: first.name,
            base: first.name.replace(/\.[^.]*$/, ''),
            ext: first.name.includes('.') ? first.name.split('.').pop() : '',
            home: this.homePath || '',
            oldVersion: this.pluginVersion || '(unknown)',
            newVersion: (m && m[1]) || '',
        };
    },

    async runCustomAction(action) {
        const tab = this.currentPane();
        const sel = this.selectedFiles(tab);
        if (!sel.length) return;
        const baseCtx = this._actionContext(sel);

        // 1) Main confirmation (custom message if provided).
        if (action.confirm) {
            const msg = action.confirmMessage
                ? Util.fillText(action.confirmMessage, baseCtx)
                : `Run "${action.label}" on ${sel.length} item(s)?`;
            const ok = await this.askConfirm(action.label || 'Run action', msg, 'Run');
            if (!ok) return;
        }

        // 2) Pre-run command, with its own optional confirmation. The confirm
        // offers Run / Skip / Cancel — Skip runs the action without the step,
        // Cancel aborts everything.
        if (action.preCommand && action.preCommand.trim()) {
            let doPre = true;
            if (action.preConfirm && action.preConfirm.trim()) {
                const choice = await this.askChoice(action.label || 'Before running',
                    Util.fillText(action.preConfirm, baseCtx), [
                        { id: 'cancel', label: 'Cancel', variant: 'outline-secondary' },
                        { id: 'skip', label: 'Skip', variant: 'secondary' },
                        { id: 'run', label: action.preConfirmLabel || 'Run', variant: 'primary' },
                    ]);
                if (choice === 'cancel' || choice == null) return;
                doPre = (choice === 'run');
            }
            if (doPre) await this._runActionStep(action, Util.fillTemplate(action.preCommand, baseCtx), action.label + ' — pre');
        }

        // 3) Main command (per-file when there is no {paths} token).
        const scope = this._actionScope(action);
        const scriptsDir = this._scriptsDir(scope);
        const scriptPath = action.script ? Util.joinPath(scriptsDir, action.script) : '';
        const hasPathsToken = /\{paths\}/.test(action.command);
        const groups = (sel.length > 1 && !hasPathsToken) ? sel.map(f => [f]) : [sel];
        for (const group of groups) {
            const ctx = this._actionContext(group);
            ctx.scripts = scriptsDir;
            ctx.script = scriptPath;
            const cmd = Util.fillTemplate(action.command, ctx);
            if (action.interactive) await this._runInteractivePane(action, cmd, group);
            else await this._runActionCmd(action, cmd, group);
        }

        // 4) Post-run command, with optional confirmation (Run / Skip).
        if (action.postCommand && action.postCommand.trim()) {
            let doPost = true;
            if (action.postConfirm && action.postConfirm.trim()) {
                const choice = await this.askChoice(action.label || 'After running',
                    Util.fillText(action.postConfirm, baseCtx), [
                        { id: 'skip', label: 'Skip', variant: 'secondary' },
                        { id: 'run', label: action.postConfirmLabel || 'Run', variant: 'primary' },
                    ]);
                doPost = (choice === 'run');
            }
            if (doPost) await this._runActionStep(action, Util.fillTemplate(action.postCommand, baseCtx), action.label + ' — post');
        }
    },

    // Run a pre/post step as a tray operation (streaming output). Failures are
    // reported but don't abort the chain (e.g. "rm -rf" of a missing dir).
    async _runActionStep(action, cmd, label) {
        const adminFlag = action.privilege === 'require' ? { admin: true }
                       : action.privilege === 'try' ? { adminTry: true } : {};
        const op = this._beginOp(label);
        op.outputBuffer = '';
        try {
            const proc = cockpit.spawn(['sh', '-c', cmd], { ...FS.spawnOpts(adminFlag), err: 'out' });
            _setOpCallback(op.id, 'cancel', () => { try { proc.close('cancelled'); } catch (e) {} });
            op.canCancel = true;
            proc.stream(d => { if (op.outputBuffer != null) op.outputBuffer += d; });
            await proc;
            this._endOp(op, 'done');
        } catch (e) {
            this._failOp(op, e);
        }
    },

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

    async _runActionCmd(action, cmd, files) {
        const adminFlag = action.privilege === 'require' ? { admin: true }
                       : action.privilege === 'try' ? { adminTry: true }
                       : {};
        const label = `${action.label} (${files.map(f => f.name).join(', ')})`;

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
            _setOpCallback(op.id, 'cancel', () => { try { proc.close('cancelled'); } catch(e){} });
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
        // (cancel, retryAsAdmin) are stored separately in _opCallbacks and
        // never touch the proxy.
        return this.operations[this.operations.length - 1];
    },

    cancelOp(op) {
        const fn = _getOpCallback(op.id, 'cancel');
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
                _clearOpCallbacks(op.id);
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
            _setOpCallback(op.id, 'retryAsAdmin', retryAsAdminFn);
        }
    },

    async retryAsAdmin(op) {
        const fn = _getOpCallback(op.id, 'retryAsAdmin');
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
            else _clearOpCallbacks(o.id);
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

    askPrompt(title, label, defaultValue) {
        return new Promise(resolve => {
            this.promptDlg = { title, label, value: defaultValue || '', resolve };
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

    // ───── Interactive scripts (Explorer Script Prompt Protocol) ───────────
    // Where a scope's uploaded scripts live (sibling of its actions.json).
    _scriptsDir(scope) {
        return (scope === 'system' || scope === 'builtin')
            ? SYSTEM_SCRIPTS_DIR
            : (this.homePath || '') + USER_SCRIPTS_DIR_SUFFIX;
    },
    _actionScope(action) {
        if (action && action._source) return action._source;   // menu passes a copy tagged with its source
        if ((this.customActions.system || []).includes(action)) return 'system';
        if ((this.customActions.builtin || []).includes(action)) return 'builtin';
        return 'user';
    },

    // Run a command in a streaming output tab that understands the prompt
    // protocol: stdout is scanned for PROMPT_START..PROMPT_END blocks; each is
    // parsed as YAML and turned into a dialog whose answer is written back to
    // the script's stdin (kept open), so the script's `read` continues.
    async _runInteractivePane(action, cmd, files) {
        const adminFlag = action.privilege === 'require' ? { admin: true }
                       : action.privilege === 'try' ? { adminTry: true } : {};
        const tab = this._buildTab('/', 'output');
        tab.outputActionLabel = (action.label || 'script') + ' (interactive)';
        tab.outputCommand = cmd;
        tab.outputStatus = 'running';
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        const rtab = this.tabs.find(t => t.id === tab.id) || tab;

        const channel = cockpit.channel({
            payload: 'stream',
            spawn: ['sh', '-c', cmd],
            ...FS.spawnOpts(adminFlag),
            err: 'out',
        });
        rtab.outputChannel = channel;

        let buf = '';
        let inPrompt = false;
        let promptLines = [];
        let queue = Promise.resolve();              // serialize line handling (dialogs are async)
        const enqueue = (fn) => { queue = queue.then(fn).catch(e => this._pushOutputLine(rtab, '[explorer] ' + (e.message || e))); };
        const decode = (d) => (typeof d === 'string' ? d : new TextDecoder().decode(d));

        const handleLine = async (line) => {
            const t = line.trim();
            if (!inPrompt && (t === PROMPT_START || t === MSG_START)) { inPrompt = true; promptLines = []; return; }
            if (inPrompt && t === PROMPT_END) {
                inPrompt = false;
                await this._handleScriptPrompt(rtab, channel, promptLines.join('\n'));
                return;
            }
            if (inPrompt) { promptLines.push(line); return; }
            this._pushOutputLine(rtab, line);   // one entry per line; pane renders join('\n')
        };

        channel.addEventListener('message', (ev, data) => {
            buf += decode(data);
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                enqueue(() => handleLine(line));
            }
        });
        channel.addEventListener('close', (ev, opts) => {
            if (buf.length) { const last = buf; buf = ''; enqueue(() => handleLine(last)); }
            enqueue(async () => {
                rtab.outputStatus = opts.problem ? ('error: ' + (opts.message || opts.problem))
                                                 : ('done (exit ' + (opts['exit-status'] ?? 0) + ')');
                rtab.outputChannel = null;
            });
        });
    },

    // Parse one prompt block (YAML) and show the matching dialog, then send the
    // answer to the script's stdin. Cancel ⇒ abort the script.
    // Make the prompt YAML forgiving: auto-quote plain scalar values so that a
    // colon inside a value (e.g. `text: Running: make foo`) doesn't get parsed
    // as a nested mapping. Leaves list items, `key:` with a block value, flow
    // sequences/maps, already-quoted values, and bools/numbers untouched.
    _preprocessPromptYaml(text) {
        return String(text).split('\n').map(line => {
            const m = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:\s+(\S.*)$/);
            if (!m) return line;
            const indent = m[1], key = m[2], v = m[3].trim();
            if (/^[\[\{"'|>&*#]/.test(v)) return line;                       // flow/quoted/block/anchor/comment
            if (/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(v)) return line;  // bool / null / number
            return indent + key + ': "' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        }).join('\n');
    },

    async _handleScriptPrompt(rtab, channel, yamlText) {
        let spec;
        try { spec = window.jsyaml ? jsyaml.load(this._preprocessPromptYaml(yamlText)) : JSON.parse(yamlText); }
        catch (e) { this._pushOutputLine(rtab, '[explorer] bad prompt block: ' + (e.message || e)); return; }
        if (!spec || typeof spec !== 'object') { this._pushOutputLine(rtab, '[explorer] empty prompt block'); return; }

        const type = String(spec.type || 'text').toLowerCase();
        const title = spec.title || 'Input requested';
        const message = spec.message || spec.prompt || '';

        // Display-only block: show it and let the script continue (no stdin write).
        if (DISPLAY_TYPES.includes(type)) {
            const text = spec.text != null ? String(spec.text)
                       : spec.message != null ? String(spec.message)
                       : (spec.title || '');
            const level = String(spec.level || 'info').toLowerCase();
            this._pushOutputLine(rtab, '» ' + text);
            const notable = ['success', 'warning', 'danger', 'error'].includes(level);
            if (spec.toast === true || notable) {
                const tl = level === 'error' ? 'danger' : level;
                this.toast(text, ['success', 'warning', 'danger', 'info'].includes(tl) ? tl : 'info');
            }
            return;
        }

        let answer = null;

        if (type === 'radio' || type === 'select' || type === 'choice') {
            const opts = Array.isArray(spec.options) ? spec.options.map(String) : [];
            if (!opts.length) { this._pushOutputLine(rtab, '[explorer] radio prompt has no options; aborting'); try { channel.close('cancelled'); } catch (e) {} return; }
            const buttons = opts.map(o => ({
                id: o, label: o,
                variant: (spec.default != null && String(spec.default) === o) ? 'primary' : 'outline-primary',
            }));
            const choice = await this.askChoice(title, message, buttons);
            if (choice == null || choice === false || choice === 'cancel') { try { channel.close('cancelled'); } catch (e) {} return; }
            answer = String(choice);
        } else {
            const def = spec.default != null ? String(spec.default) : '';
            const val = await this.askPrompt(title, message || 'Enter a value', def);
            if (val == null) { try { channel.close('cancelled'); } catch (e) {} return; }
            answer = String(val);
        }

        rtab.outputLines.push('‹ ' + answer + '\n');             // transcript of what we sent
        try { channel.send(answer + '\n'); }
        catch (e) { rtab.outputLines.push('[explorer] could not send input: ' + (e.message || e) + '\n'); }
    },

    // ───── Interactive scripts (Explorer Script Prompt Protocol) ───────────
    // Where a scope's uploaded scripts live (sibling of its actions.json).
    _scriptsDir(scope) {
        return (scope === 'system' || scope === 'builtin')
            ? SYSTEM_SCRIPTS_DIR
            : (this.homePath || '') + USER_SCRIPTS_DIR_SUFFIX;
    },
    _actionScope(action) {
        if (action && action._source) return action._source;   // menu passes a copy tagged with its source
        if ((this.customActions.system || []).includes(action)) return 'system';
        if ((this.customActions.builtin || []).includes(action)) return 'builtin';
        return 'user';
    },

    // Run a command in a streaming output tab that understands the prompt
    // protocol: stdout is scanned for PROMPT_START..PROMPT_END blocks; each is
    // parsed as YAML and turned into a dialog whose answer is written back to
    // the script's stdin (kept open), so the script's `read` continues.
    async _runInteractivePane(action, cmd, files) {
        const adminFlag = action.privilege === 'require' ? { admin: true }
                       : action.privilege === 'try' ? { adminTry: true } : {};
        const tab = this._buildTab('/', 'output');
        tab.outputActionLabel = (action.label || 'script') + ' (interactive)';
        tab.outputCommand = cmd;
        tab.outputStatus = 'running';
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        const rtab = this.tabs.find(t => t.id === tab.id) || tab;

        const channel = cockpit.channel({
            payload: 'stream',
            spawn: ['sh', '-c', cmd],
            ...FS.spawnOpts(adminFlag),
            err: 'out',
        });
        rtab.outputChannel = channel;

        let buf = '';
        let inPrompt = false;
        let promptLines = [];
        let queue = Promise.resolve();              // serialize line handling (dialogs are async)
        const enqueue = (fn) => { queue = queue.then(fn).catch(e => rtab.outputLines.push('[explorer] ' + (e.message || e))); };
        const decode = (d) => (typeof d === 'string' ? d : new TextDecoder().decode(d));

        const handleLine = async (line) => {
            const t = line.trim();
            if (!inPrompt && (t === PROMPT_START || t === MSG_START)) { inPrompt = true; promptLines = []; return; }
            if (inPrompt && t === PROMPT_END) {
                inPrompt = false;
                await this._handleScriptPrompt(rtab, channel, promptLines.join('\n'));
                return;
            }
            if (inPrompt) { promptLines.push(line); return; }
            rtab.outputLines.push(line + '\n');   // pane renders join(''), so keep the newline
        };

        channel.addEventListener('message', (ev, data) => {
            buf += decode(data);
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                enqueue(() => handleLine(line));
            }
        });
        channel.addEventListener('close', (ev, opts) => {
            if (buf.length) { const last = buf; buf = ''; enqueue(() => handleLine(last)); }
            enqueue(async () => {
                rtab.outputStatus = opts.problem ? ('error: ' + (opts.message || opts.problem))
                                                 : ('done (exit ' + (opts['exit-status'] ?? 0) + ')');
                rtab.outputChannel = null;
            });
        });
    },

    // Parse one prompt block (YAML) and show the matching dialog, then send the
    // answer to the script's stdin. Cancel ⇒ abort the script.
    // Make the prompt YAML forgiving: auto-quote plain scalar values so that a
    // colon inside a value (e.g. `text: Running: make foo`) doesn't get parsed
    // as a nested mapping. Leaves list items, `key:` with a block value, flow
    // sequences/maps, already-quoted values, and bools/numbers untouched.
    _preprocessPromptYaml(text) {
        return String(text).split('\n').map(line => {
            const m = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:\s+(\S.*)$/);
            if (!m) return line;
            const indent = m[1], key = m[2], v = m[3].trim();
            if (/^[\[\{"'|>&*#]/.test(v)) return line;                       // flow/quoted/block/anchor/comment
            if (/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(v)) return line;  // bool / null / number
            return indent + key + ': "' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        }).join('\n');
    },

    async _handleScriptPrompt(rtab, channel, yamlText) {
        let spec;
        try { spec = window.jsyaml ? jsyaml.load(this._preprocessPromptYaml(yamlText)) : JSON.parse(yamlText); }
        catch (e) { rtab.outputLines.push('[explorer] bad prompt block: ' + (e.message || e) + '\n'); return; }
        if (!spec || typeof spec !== 'object') { rtab.outputLines.push('[explorer] empty prompt block\n'); return; }

        const type = String(spec.type || 'text').toLowerCase();
        const title = spec.title || 'Input requested';
        const message = spec.message || spec.prompt || '';

        // Display-only block: show it and let the script continue (no stdin write).
        if (DISPLAY_TYPES.includes(type)) {
            const text = spec.text != null ? String(spec.text)
                       : spec.message != null ? String(spec.message)
                       : (spec.title || '');
            const level = String(spec.level || 'info').toLowerCase();
            rtab.outputLines.push('» ' + text + '\n');
            const notable = ['success', 'warning', 'danger', 'error'].includes(level);
            if (spec.toast === true || notable) {
                const tl = level === 'error' ? 'danger' : level;
                this.toast(text, ['success', 'warning', 'danger', 'info'].includes(tl) ? tl : 'info');
            }
            return;
        }

        let answer = null;

        if (type === 'radio' || type === 'select' || type === 'choice') {
            const opts = Array.isArray(spec.options) ? spec.options.map(String) : [];
            if (!opts.length) { rtab.outputLines.push('[explorer] radio prompt has no options; aborting\n'); try { channel.close('cancelled'); } catch (e) {} return; }
            const buttons = opts.map(o => ({
                id: o, label: o,
                variant: (spec.default != null && String(spec.default) === o) ? 'primary' : 'outline-primary',
            }));
            const choice = await this.askChoice(title, message, buttons);
            if (choice == null || choice === false || choice === 'cancel') { try { channel.close('cancelled'); } catch (e) {} return; }
            answer = String(choice);
        } else {
            const def = spec.default != null ? String(spec.default) : '';
            const val = await this.askPrompt(title, message || 'Enter a value', def);
            if (val == null) { try { channel.close('cancelled'); } catch (e) {} return; }
            answer = String(val);
        }

        this._pushOutputLine(rtab, '‹ ' + answer);             // transcript of what we sent
        try { channel.send(answer + '\n'); }
        catch (e) { this._pushOutputLine(rtab, '[explorer] could not send input: ' + (e.message || e)); }
    },


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
                const raw = localStorage.getItem(LS_KEY_SETTINGS);
                if (raw) {
                    loaded = JSON.parse(raw);
                    // Best-effort migrate to YAML on disk
                    await this._writeSettingsYaml(loaded);
                    try { localStorage.removeItem(LS_KEY_SETTINGS); } catch (e) {}
                }
            } catch (e) {}
        }

        if (loaded && typeof loaded === 'object') {
            // Deep-merge over defaults so new fields don't disappear
            Object.assign(this.settings, loaded);
            // columns is a nested object — merge defaults under it
            this.settings.columns = Object.assign({}, DEFAULT_SETTINGS.columns, loaded.columns || {});
        }
        if (!this.settings.columns) this.settings.columns = structuredClone(DEFAULT_SETTINGS.columns);

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
        if (ctrl && ev.key.toLowerCase() === 'c' && tab) { ev.preventDefault(); this.copyToClipboard('copy'); return; }
        if (ctrl && ev.key.toLowerCase() === 'x' && tab) { ev.preventDefault(); this.copyToClipboard('cut'); return; }
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
        if (!this.settings.defaultShell || !this.shells.includes(this.settings.defaultShell)) {
            this.settings.defaultShell = this.shells.find(s => s.endsWith('/bash')) || this.shells[0];
        }
        if (!this.settings.diffView) this.settings.diffView = 'side';

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
        try {
            await navigator.clipboard.writeText(cmd);
            this.toast('Terminal opened — cd command copied to clipboard. Paste with Ctrl-Shift-V.');
        } catch (e) {
            this.toast(`Terminal opened. Run: ${cmd}`, 'info');
        }
        if (window.cockpit && cockpit.jump) {
            cockpit.jump(['system', 'terminal']);
        }
    },

    // ──────── Integrated terminals (xterm.js + cockpit PTY stream) (v1.2) ────────
    // Architecture:
    //   tab.terminals     — reactive [{ id, dir, label }]
    //   tab.activeTermId  — id of the currently visible terminal (sub-tab)
    //   tab.splitOpen     — dir-kind tabs only: is the right-side pane open
    //   tab.splitWidth    — dir-kind tabs only: pane width in px
    //   tab.kind='terminal' — full-tab terminal stack, no file list
    //
    // The xterm Terminal + cockpit channel for each terminal live in the
    // module-scope _termInstances Map keyed by *terminal* id (not tab id).
    // Keeping them out of Alpine's reactive walk is essential — same lesson
    // as _opCallbacks (operations cancel-fn bug, v1.0.4).

    _defaultTermLabel(dir, existing) {
        let base = Util.basename(dir) || '/';
        const taken = new Set((existing || []).map(t => t.label));
        if (!taken.has(base)) return base;
        let i = 2;
        while (taken.has(base + ' ' + i)) i++;
        return base + ' ' + i;
    },

    // Add a new terminal sub-tab inside this tab. Opens split pane for dir tabs.
    addTerminalToTab(tab, dir) {
        if (!tab) tab = this.activeTab();
        if (!tab) return;
        // Re-acquire the reactive proxy from this.tabs. Callers may hand
        // us a stale raw reference (e.g. newTerminalTab passes the local
        // `tab` variable from before this.tabs.push). Alpine/Vue3 reactivity
        // is tracked through the Proxy in the array — mutations via the raw
        // reference don't trigger template updates. This is why the sub-tab
        // bar was rendering empty on first open after newTerminalTab.
        const reactive = this.tabs.find(t => t && t.id === tab.id);
        if (reactive) tab = reactive;

        if (!dir) dir = tab.path || this.homePath || '/';
        if (!tab.terminals) tab.terminals = [];

        const termId = Util.uid();
        const term = { id: termId, dir: dir, label: this._defaultTermLabel(dir, tab.terminals) };
        tab.terminals.push(term);
        tab.activeTermId = termId;

        if (tab.kind === 'dir') {
            tab.splitOpen = true;
            if (!tab.splitWidth) tab.splitWidth = 480;
        }

        this.$nextTick(() => this._mountTerminal(termId, dir));
        return term;
    },

    // Convenience for the toolbar/context-menu — opens split if closed,
    // creates the first terminal at `path`, or focuses the existing active.
    openIntegratedTerminal(tab, path) {
        if (!tab) tab = this.activeTab();
        if (!tab) return;
        if (!tab.terminals) tab.terminals = [];
        if (tab.terminals.length === 0) {
            this.addTerminalToTab(tab, path || tab.path);
        } else {
            if (tab.kind === 'dir') tab.splitOpen = true;
            const active = tab.activeTermId || tab.terminals[0].id;
            this.selectTerminal(tab, active);
        }
    },

    // Create a new MAIN tab whose only content is a terminal stack.
    newTerminalTab(dir) {
        dir = dir || this.activeTab()?.path || this.homePath || '/';
        const raw = this._buildTab(dir, 'terminal');
        this.tabs.push(raw);
        this.activeTabId = raw.id;
        // After push, this.tabs contains a reactive proxy wrapping `raw`.
        // Pass the *proxy* to $nextTick so mutations inside addTerminalToTab
        // trigger template updates (sub-tab bar re-render).
        const reactive = this.tabs.find(t => t.id === raw.id);
        this.$nextTick(() => this.addTerminalToTab(reactive, dir));
        return reactive;
    },

    // Write a bash rcfile that sources the user's normal startup files and
    // then appends an OSC 7 emitter to PROMPT_COMMAND. Spawning bash with
    // --rcfile <this> makes every prompt report the live cwd, which our
    // terminal OSC 7 handler turns into the sub-tab path label. Idempotent.
    async _ensureOsc7Rc() {
        if (this._osc7RcPath) return this._osc7RcPath;
        const dir = Util.joinPath(this.homePath || '/root', '.config/cockpit/explorer');
        const path = Util.joinPath(dir, 'osc7.bash');
        const content =
            '# Auto-generated by the Cockpit explorer plugin.\n' +
            '# Sources your normal bash startup, then reports cwd via OSC 7 so\n' +
            '# the file-explorer terminal sub-tabs can show the live path.\n' +
            '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc\n' +
            '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n' +
            '__explorer_osc7() { printf \'\\033]7;file://%s%s\\033\\\\\' "${HOSTNAME:-localhost}" "$PWD"; }\n' +
            'case ";${PROMPT_COMMAND};" in\n' +
            '  *__explorer_osc7*) ;;\n' +
            '  *) PROMPT_COMMAND="__explorer_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;\n' +
            'esac\n' +
            '__explorer_osc7\n';
        try {
            await cockpit.spawn(['mkdir', '-p', dir]);
            await cockpit.file(path).replace(content);
            this._osc7RcPath = path;
        } catch (e) {
            console.warn('[explorer] could not write OSC7 rcfile:', e);
            this._osc7RcPath = null;
        }
        return this._osc7RcPath;
    },

    // Update a terminal's tracked working directory (from OSC 7) and refresh
    // its sub-tab label. Searches all tabs since termId is globally unique.
    _updateTerminalDir(termId, dir) {
        if (!dir) return;
        for (const tab of this.tabs) {
            if (!tab.terminals) continue;
            const t = tab.terminals.find(x => x.id === termId);
            if (t) { if (t.dir !== dir) t.dir = dir; return; }
        }
    },

    // ── Sub-tab path hover popover (full path + copy) ──────────────────
    showTermPath(ev, t) {
        clearTimeout(this._termPathTimer);
        const r = ev.currentTarget.getBoundingClientRect();
        this.termPathPop = { open: true, top: Math.round(r.bottom + 3), left: Math.round(r.left), path: t.dir || '/' };
    },
    hideTermPath() {
        clearTimeout(this._termPathTimer);
        this._termPathTimer = setTimeout(() => { this.termPathPop.open = false; }, 250);
    },
    keepTermPath() { clearTimeout(this._termPathTimer); },
    _copyToClipboard(text) {
        const p = text || '';
        let ok = false;
        try {
            const ta = document.createElement('textarea');
            ta.value = p; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.focus(); ta.select();
            ok = document.execCommand('copy');
            ta.remove();
        } catch (e) {}
        if (!ok && navigator.clipboard) { try { navigator.clipboard.writeText(p); ok = true; } catch (e) {} }
        return ok;
    },

    copyTermPath() {
        const ok = this._copyToClipboard(this.termPathPop.path || '');
        this.toast(ok ? 'Path copied' : 'Could not copy path', ok ? 'info' : 'error');
        this.termPathPop.open = false;
    },

    // Double-clicking a terminal sub-tab copies its working directory.
    copyTermDir(t) {
        const p = (t && t.dir) || '';
        const ok = this._copyToClipboard(p);
        this.toast(ok ? ('Copied path: ' + p) : 'Could not copy path', ok ? 'info' : 'error');
    },

    selectTerminal(tab, termId) {
        if (!tab || !tab.terminals) return;
        if (!tab.terminals.find(t => t.id === termId)) return;
        tab.activeTermId = termId;
        // Newly-visible xterm has stale dimensions if it was display:none;
        // refit and refocus on next tick.
        this.$nextTick(() => {
            const inst = _getTermInstance(termId);
            if (inst) {
                try { inst.fitAddon.fit(); } catch (e) {}
                try { inst.term.focus(); } catch (e) {}
            }
        });
    },

    closeTerminal(tab, termId) {
        if (!tab || !tab.terminals) return;
        const idx = tab.terminals.findIndex(t => t.id === termId);
        if (idx < 0) return;

        const inst = _getTermInstance(termId);
        if (inst && inst.onWinResize) {
            try { window.removeEventListener('resize', inst.onWinResize); } catch (e) {}
        }
        _deleteTermInstance(termId);

        tab.terminals.splice(idx, 1);

        if (tab.activeTermId === termId) {
            if (tab.terminals.length === 0) {
                tab.activeTermId = null;
                if (tab.kind === 'dir') {
                    tab.splitOpen = false;
                } else if (tab.kind === 'terminal') {
                    // Closing last terminal in a terminal-kind tab closes the tab.
                    this.closeTab(tab.id);
                    return;
                }
            } else {
                const next = tab.terminals[Math.min(idx, tab.terminals.length - 1)];
                this.selectTerminal(tab, next.id);
            }
        }
    },

    closeSplit(tab) {
        // Close the entire split pane (and all its terminals) on a dir tab.
        if (!tab || !tab.terminals) return;
        const ids = tab.terminals.map(t => t.id);
        for (const id of ids) {
            const inst = _getTermInstance(id);
            if (inst && inst.onWinResize) {
                try { window.removeEventListener('resize', inst.onWinResize); } catch (e) {}
            }
            _deleteTermInstance(id);
        }
        tab.terminals = [];
        tab.activeTermId = null;
        if (tab.kind === 'dir') tab.splitOpen = false;
    },

    _mountTerminal(termId, dir, attempt) {
        if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) {
            this.toast('xterm.js not loaded — terminal unavailable', 'error');
            return;
        }
        attempt = attempt || 0;
        const container = document.getElementById('term-container-' + termId);
        if (!container || container.offsetHeight === 0) {
            // Container not yet in DOM, or DOM in but parent has no height
            // yet (terminal-tab-body still flex-calculating). Retry up to ~1s.
            if (attempt < 20) {
                setTimeout(() => this._mountTerminal(termId, dir, attempt + 1), 50);
            } else {
                console.warn('[explorer] terminal container never sized; giving up', termId);
                this.toast('Terminal failed to size — try toggling the tab', 'error');
            }
            return;
        }

        const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
        const xterm = new window.Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
            scrollback: 5000,
            allowProposedApi: false,
            theme: isDark
                ? { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: '#264f78' }
                : { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: '#a8c8ee' },
        });

        const fitAddon = new window.FitAddon.FitAddon();
        xterm.loadAddon(fitAddon);
        xterm.open(container);
        try { fitAddon.fit(); } catch (e) {}

        // OSC 7 (file://host/path) lets the shell report its working directory
        // on each prompt; many distros configure bash/zsh to emit it. When
        // present, keep the sub-tab path label in sync with the live pwd.
        try {
            xterm.parser.registerOscHandler(7, (data) => {
                let p = data || '';
                if (p.startsWith('file://')) {
                    p = p.slice(7);
                    const slash = p.indexOf('/');
                    p = slash >= 0 ? p.slice(slash) : '/';
                }
                try { p = decodeURIComponent(p); } catch (e) {}
                if (p && p.startsWith('/')) this._updateTerminalDir(termId, p);
                return true; // fully handled
            });
        } catch (e) {}

        const shell = (this.settings && this.settings.defaultShell) || '/bin/bash';
        // For bash, launch with our rcfile so each prompt reports cwd via OSC 7.
        // The rcfile sources the user's own ~/.bashrc first, so their prompt /
        // aliases are untouched. Non-bash shells just run interactively.
        const isBash = /(^|\/)bash$/.test(shell);
        const spawnArgs = (isBash && this._osc7RcPath)
            ? [shell, '--rcfile', this._osc7RcPath, '-i']
            : [shell, '-i'];

        // Match Cockpit's own terminal plugin: interactive shell, UTF-8 stream.
        let channel;
        try {
            channel = cockpit.channel({
                payload: 'stream',
                spawn: spawnArgs,
                pty: true,
                environ: ['TERM=xterm-256color', 'COLORTERM=truecolor', 'PAGER=cat'],
                directory: dir,
            });
        } catch (e) {
            console.error('[explorer] failed to spawn shell:', e);
            this.toast('Failed to spawn shell: ' + (e.message || e), 'error');
            try { xterm.dispose(); } catch (e2) {}
            return;
        }

        xterm.onData(data => { try { channel.send(data); } catch (e) {} });
        channel.addEventListener('message', (ev, data) => {
            try { xterm.write(data); } catch (e) { console.warn('[explorer] xterm.write failed:', e); }
        });
        channel.addEventListener('close', (ev, options) => {
            const problem = options && options.problem;
            const exit = options && options['exit-status'];
            let reason;
            if (problem) reason = 'channel error: ' + problem + (options.message ? ' - ' + options.message : '');
            else if (typeof exit === 'number') reason = 'shell exited (' + exit + ')';
            else reason = 'closed';
            console.warn('[explorer] terminal channel closed:', reason, options);
            try { xterm.write(`\r\n\x1b[33m[${reason}]\x1b[0m\r\n`); } catch (e) {}
        });
        xterm.onResize(({ cols, rows }) => {
            try { channel.control({ command: 'options', window: { rows, cols } }); } catch (e) {}
        });

        const onWinResize = () => {
            const inst = _getTermInstance(termId);
            if (!inst) return;
            try { inst.fitAddon.fit(); } catch (e) {}
        };
        window.addEventListener('resize', onWinResize);

        _setTermInstance(termId, { term: xterm, channel, fitAddon, container, onWinResize });

        // Final fit + force initial PTY resize. Without an initial control
        // message, some shells start with 80x24 default and don't redraw.
        this.$nextTick(() => {
            try { fitAddon.fit(); } catch (e) {}
            try { xterm.focus(); } catch (e) {}
            try {
                channel.control({ command: 'options', window: { rows: xterm.rows, cols: xterm.cols } });
            } catch (e) {}
        });
    },

    _startTermResize(ev, tab) {
        ev.preventDefault();
        const horizontal = !!tab.dual; // dual-pane → terminal docks at the bottom
        const startX = ev.clientX, startY = ev.clientY;
        const startW = tab.splitWidth || 480;
        const startH = tab.splitHeight || 260;

        const onMove = (e) => {
            if (horizontal) {
                // Resizer sits on the TOP edge of the bottom terminal pane;
                // dragging up grows the terminal.
                const dy = startY - e.clientY;
                const maxH = Math.max(120, window.innerHeight - 220);
                tab.splitHeight = Math.max(120, Math.min(maxH, startH + dy));
            } else {
                // Resizer on the LEFT edge of the right terminal pane.
                const dx = startX - e.clientX;
                const maxW = Math.max(300, window.innerWidth - 280);
                tab.splitWidth = Math.max(220, Math.min(maxW, startW + dx));
            }
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (tab.activeTermId) {
                const inst = _getTermInstance(tab.activeTermId);
                if (inst) { try { inst.fitAddon.fit(); } catch (e) {} }
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    },

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

    // ── Repo cache model ─────────────────────────────────────────────────
    // repoCache[ownerRepo] is a list of { path, title } — one per local copy.
    repoCheckouts(ownerRepo) {
        const v = this.repoCache[ownerRepo];
        if (!v) return [];
        if (Array.isArray(v)) return v;
        if (typeof v === 'string') return [{ path: v, title: ownerRepo.split('/').pop() }];
        if (v.path) return [v];
        return [];
    },
    // Primary checkout path (first copy) — back-compat for branch ops / "is cached".
    repoCheckout(ownerRepo) {
        const list = this.repoCheckouts(ownerRepo);
        return list.length ? list[0].path : null;
    },
    isCheckoutCached(ownerRepo, path) {
        return this.repoCheckouts(ownerRepo).some(e => e.path === path);
    },
    repoTitleOf(ownerRepo, path) {
        const e = this.repoCheckouts(ownerRepo).find(x => x.path === path);
        return (e && e.title) || this._defaultRepoTitle(ownerRepo, path);
    },
    _defaultRepoTitle(ownerRepo, path) {
        const repo = ownerRepo.split('/').pop();
        // First copy → just the repo name; extra copies → disambiguate by folder.
        if (this.repoCheckouts(ownerRepo).length === 0) return repo;
        const base = (path || '').split('/').filter(Boolean).pop();
        return base ? `${repo} (${base})` : repo;
    },
    async _addRepoCheckout(ownerRepo, path, title) {
        if (!ownerRepo || !path) return;
        const list = this.repoCheckouts(ownerRepo).slice();
        const existing = list.find(e => e.path === path);
        if (existing) {
            if (title) existing.title = title;
        } else {
            list.push({ path, title: title || this._defaultRepoTitle(ownerRepo, path) });
        }
        this.repoCache[ownerRepo] = list;
        await this._saveRepoCache();
    },
    async _removeRepoCheckout(ownerRepo, path) {
        const list = this.repoCheckouts(ownerRepo).filter(e => e.path !== path);
        if (list.length) this.repoCache[ownerRepo] = list;
        else delete this.repoCache[ownerRepo];
        await this._saveRepoCache();
    },
    async setRepoTitle(ownerRepo, path) {
        const cur = this.repoCheckouts(ownerRepo).find(e => e.path === path);
        const title = await this.askPrompt('Repository title',
            'Title for ' + path, (cur && cur.title) || this._defaultRepoTitle(ownerRepo, path));
        if (title === null || title === '') return;
        const list = this.repoCheckouts(ownerRepo).map(e => e.path === path ? { path: e.path, title } : e);
        this.repoCache[ownerRepo] = list;
        await this._saveRepoCache();
    },

    // Add the active tab's git work-tree to the repo cache. Requires
    // tab.gitInfo.remote.ownerRepo (detected from `git config remote.origin.url`).
    async registerCurrentTab(tab) {
        const owner = tab.gitInfo?.remote?.ownerRepo;
        if (!owner) {
            this.toast('No GitHub remote detected (need an origin URL like github.com/<owner>/<repo>).', 'danger');
            return;
        }
        // Register the repository's top-level directory (where .git lives),
        // not whatever subfolder the tab happens to be sitting in.
        let repoPath = tab.path;
        try {
            const root = await GIT.topLevel(tab.path);
            if (root) repoPath = root;
        } catch (e) {}
        if (this.isCheckoutCached(owner, repoPath)) {
            this.toast(`${owner} already registered at ${repoPath}`);
            return;
        }
        await this._addRepoCheckout(owner, repoPath);
        this.toast(`Registered ${owner} → ${repoPath}`);
    },

    // Is a path inside any registered checkout?
    insideAnyRepoCache(p) {
        for (const list of Object.values(this.repoCache || {})) {
            for (const e of (Array.isArray(list) ? list : [])) {
                const cachePath = e && e.path;
                if (!cachePath) continue;
                if (p === cachePath || p.startsWith(cachePath + '/')) return cachePath;
            }
        }
        return null;
    },

    // ── Cached repos toolbar ───────────────────────────────────────────────
    // One row per local copy: { key, path, title }.
    cachedRepoList() {
        const out = [];
        for (const [key, list] of Object.entries(this.repoCache || {})) {
            for (const e of this.repoCheckouts(key)) {
                out.push({ key, path: e.path, title: e.title || this._defaultRepoTitle(key, e.path) });
            }
        }
        out.sort((a, b) => (a.title || a.key).localeCompare(b.title || b.key));
        return out;
    },
    navigateToCachedRepo(tab, path) {
        if (!path) return;
        // If there's no current tab, open in a new one.
        if (!tab) { this.newTab(path); return; }
        this.navigate(tab, path);
    },
    openCachedRepoInNewTab(path) {
        if (!path) return;
        this.newTab(path);
    },

    async _refreshAllGitInfo() {
        // Refresh both the tab (pane A) and pane B if present.
        const panes = [];
        for (const tab of this.tabs) {
            if (tab.kind !== 'dir') continue;
            panes.push(tab);
            if (tab.dual && tab.paneB) panes.push(tab.paneB);
        }
        for (const pane of panes) {
            try {
                if (await GIT.isWorkTree(pane.path)) {
                    pane.gitInfo = await GIT.status(pane.path);
                } else {
                    pane.gitInfo = null;
                }
            } catch (e) { pane.gitInfo = null; }
            pane.gitChecked = true;
        }
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

    // ─── GITHUB PANEL ────────────────────────────────────────────────────────
    async openGithubPanel(tab) {
        bootstrap.Modal.getOrCreateInstance(this.ghModalEl).show();
        await this._refreshGhState();
    },

    async _refreshGhState() {
        this.gh.state = 'init';
        this.gh.authError = '';
        try {
            if (!(await GIT.ghAvailable())) {
                const strat = await GIT.chooseInstallStrategy();
                this.gh.installFamily = strat.family;
                this.gh.state = 'notinstalled';
                return;
            }
            const status = await GIT.ghAuthStatus();
            if (!status.authed) { this.gh.state = 'notauthed'; return; }
            // Fetch user info
            try {
                const me = await GIT.ghMe();
                this.gh.user = me.login;
            } catch (e) { this.gh.user = status.user; }
            try {
                this.gh.scopes = await GIT.ghTokenScopes();
                this.gh.scopeWarning = this.gh.scopes.some(s => /^(admin:|delete_repo|workflow)/.test(s));
            } catch (e) { this.gh.scopes = []; this.gh.scopeWarning = false; }
            this.gh.state = 'authed';
            // Configure git to authenticate github.com via gh, so plain
            // fetch/pull/push work on HTTPS clones (once per session).
            if (!this._ghGitConfigured) {
                this._ghGitConfigured = true;
                GIT.ghSetupGit().catch(() => {});
            }
            this.ghReloadRepos();
        } catch (e) {
            // Never leave the panel stuck on the blank "checking" state.
            this.gh.state = 'notauthed';
            this.gh.authError = e.message || String(e);
        }
    },

    // ───── Update check / self-update from GitHub releases ─────────────────
    // Normalise the configured update source to "owner/repo".
    _updateRepo() {
        let r = String(this.settings.updateRepo || DEFAULT_SETTINGS.updateRepo).trim();
        const m = r.match(/github\.com[\/:]([^\/]+\/[^\/#?]+)/i);
        if (m) r = m[1];
        return r.replace(/\.git$/i, '').replace(/\/+$/, '');
    },
    _versionTuple(v) { return String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0); },
    _versionNewer(a, b) {
        const x = this._versionTuple(a), y = this._versionTuple(b);
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            const d = (x[i] || 0) - (y[i] || 0);
            if (d) return d > 0;
        }
        return false;
    },
    // Read the latest release of the configured repo (gh if available, else curl).
    async _fetchLatestRelease(repo) {
        const ghOk = await GIT.ghAvailable().catch(() => false);
        if (ghOk) {
            try {
                const out = await cockpit.spawn(['gh', 'api', 'repos/' + repo + '/releases/latest'], { err: 'message' });
                const j = JSON.parse(out);
                if (j && j.tag_name) return { tag: j.tag_name, version: String(j.tag_name).replace(/^v/i, '') };
            } catch (e) { /* fall through to anonymous curl */ }
        }
        try {
            const out = await cockpit.spawn(['sh', '-c', 'curl -fsSL ' + Util.shq('https://api.github.com/repos/' + repo + '/releases/latest')], { err: 'message' });
            const j = JSON.parse(out);
            if (j && j.tag_name) return { tag: j.tag_name, version: String(j.tag_name).replace(/^v/i, '') };
        } catch (e) {}
        return null;
    },
    // Check for a newer release. manual=true ⇒ chatty (toasts for every outcome).
    async checkForUpdate(manual) {
        if (this.updateState.checking) return;
        const repo = this._updateRepo();
        if (!this.pluginVersion) { if (manual) this.toast('Current version is unknown; cannot compare.', 'warning'); return; }
        this.updateState.checking = true;
        if (manual) this.toast('Checking ' + repo + ' for updates…');
        let rel = null;
        try { rel = await this._fetchLatestRelease(repo); }
        catch (e) { this.updateState.checking = false; if (manual) this.toast('Update check failed: ' + (e.message || e), 'danger'); return; }
        this.updateState.checking = false;
        if (!rel || !rel.version) { if (manual) this.toast('No releases found at ' + repo + '.', 'warning'); return; }
        if (this._versionNewer(rel.version, this.pluginVersion)) {
            this.updateState.available = rel;
            this.startSelfUpdate(rel);                       // start the self-update (asks for confirmation)
        } else {
            this.updateState.available = null;
            if (manual) this.toast('You are up to date (v' + this.pluginVersion + ').', 'success');
        }
    },
    // Confirm, download the release zip, then run the built-in self-update on it.
    async startSelfUpdate(info) {
        info = info || this.updateState.available;
        if (!info) { this.toast('No update available.', 'warning'); return; }
        const repo = this._updateRepo();
        const ok = await this.askConfirm('Update available',
            'Explorer ' + info.version + ' is available (installed: ' + (this.pluginVersion || '?') + ').\n\n' +
            'Download it from ' + repo + ' and install now?\nThis runs "make install" as administrator and restarts Cockpit (you will be briefly disconnected — reload afterwards).',
            'Download & update');
        if (!ok) return;
        const op = this._beginOp('Downloading explorer ' + info.version);
        let zip;
        try { zip = await this._downloadReleaseZip(repo, info.tag); this._endOp(op, 'done'); }
        catch (e) { this._failOp(op, e); this.toast('Download failed: ' + (e.message || e), 'danger'); return; }
        this._runSelfUpdateInstall(zip, info.version);
    },
    async _downloadReleaseZip(repo, tag) {
        const tmp = (await cockpit.spawn(['mktemp', '-d'], { err: 'message' })).trim();
        const ghOk = await GIT.ghAvailable().catch(() => false);
        if (ghOk) {
            await cockpit.spawn(['env', 'GH_PROMPT_DISABLED=1', 'gh', 'release', 'download', tag, '-R', repo,
                '--pattern', 'explorer-*.zip', '--dir', tmp, '--clobber'], { err: 'message' });
        } else {
            const meta = await cockpit.spawn(['sh', '-c', 'curl -fsSL ' + Util.shq('https://api.github.com/repos/' + repo + '/releases/tags/' + tag)], { err: 'message' });
            const j = JSON.parse(meta);
            const asset = (j.assets || []).find(a => /^explorer-.*\.zip$/.test(a.name));
            if (!asset) throw new Error('release ' + tag + ' has no explorer-*.zip asset');
            await cockpit.spawn(['sh', '-c', 'curl -fsSL -o ' + Util.shq(tmp + '/' + asset.name) + ' ' + Util.shq(asset.browser_download_url)], { err: 'message' });
        }
        const found = (await cockpit.spawn(['sh', '-c', 'ls -1 ' + Util.shq(tmp) + '/explorer-*.zip 2>/dev/null | head -1'], { err: 'message' })).trim();
        if (!found) throw new Error('no explorer-*.zip was downloaded');
        return found;
    },
    // Run the built-in "explorer-self-update" action against a downloaded zip.
    _runSelfUpdateInstall(zipPath, version) {
        const name = zipPath.split('/').pop();
        const ctx = {
            path: zipPath, name, dir: Util.dirname(zipPath),
            base: name.replace(/\.zip$/, ''), ext: 'zip',
            oldVersion: this.pluginVersion || '(unknown)', newVersion: version,
            home: this.homePath,
        };
        const action = (this.customActions.builtin || []).find(a => a.id === 'explorer-self-update');
        if (action) {
            this._runActionCmd(action, Util.fillTemplate(action.command, ctx), [{ path: zipPath, name }]);
        } else {
            const cmd = 'set -e; TMP=$(mktemp -d); unzip -oq ' + Util.shq(zipPath) + ' -d "$TMP"; ' +
                'make -C "$TMP/explorer" install; rm -rf "$TMP"; ' +
                '(sleep 2; systemctl restart cockpit || systemctl restart cockpit.socket) >/dev/null 2>&1 &';
            this._runActionCmd({ label: 'Self-update to ' + version, privilege: 'require', output: 'pane' }, cmd, [{ path: zipPath, name }]);
        }
    },

    async installGh() {
        this.gh.installing = true;
        const strat = await GIT.chooseInstallStrategy();
        const tab = this._buildTab('/', 'output');
        tab.outputActionLabel = 'Install GitHub CLI (' + strat.family + ')';
        tab.outputCommand = strat.cmd;
        tab.outputStatus = 'running';
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        // Re-acquire the REACTIVE proxy from this.tabs — mutating the raw
        // `tab` ref (especially outputLines.push) bypasses Alpine's reactivity
        // and the output pane would never update.
        const rtab = this.tabs.find(t => t.id === tab.id) || tab;
        const channel = cockpit.channel({
            payload: 'stream',
            spawn: ['sh', '-c', strat.cmd],
            superuser: 'require',
            err: 'out',
        });
        rtab.outputChannel = channel;
        channel.addEventListener('message', (ev, d) => {
            this._feedOutput(rtab, typeof d === 'string' ? d : new TextDecoder().decode(d));
        });
        channel.addEventListener('close', async (ev, props) => {
            this._flushOutput(rtab);
            rtab.outputStatus = props.problem ? ('error: ' + (props.message || props.problem))
                                              : ('done (exit ' + (props['exit-status'] ?? 0) + ')');
            rtab.outputChannel = null;
            this.gh.installing = false;
            // Re-check state
            this._refreshGhState();
        });
    },

    async ghLogin() {
        if (!this.gh.tokenInput) return;
        this.gh.loggingIn = true;
        this.gh.authError = '';
        try {
            await GIT.ghAuthLogin(this.gh.tokenInput);
            this.gh.tokenInput = '';
            await this._refreshGhState();
        } catch (e) {
            this.gh.authError = e.message || String(e);
        } finally {
            this.gh.loggingIn = false;
        }
    },

    async ghReloadRepos() {
        this.gh.loadingRepos = true;
        try {
            this.gh.repos = await GIT.ghRepoList(200);
        } catch (e) {
            this.toast('Could not list repos: ' + e.message, 'danger');
        } finally { this.gh.loadingRepos = false; }
    },

    filteredRepos() {
        const q = (this.gh.search || '').toLowerCase().trim();
        if (!q) return this.gh.repos;
        return this.gh.repos.filter(r =>
            r.nameWithOwner.toLowerCase().includes(q) ||
            (r.description || '').toLowerCase().includes(q));
    },

    filteredBranches() {
        const q = (this.gh.branchSearch || '').toLowerCase().trim();
        if (!q) return this.gh.branches;
        return this.gh.branches.filter(b => (b.name || '').toLowerCase().includes(q));
    },

    async selectRepo(repo) {
        this.gh.selectedRepo = repo.nameWithOwner;
        this.gh.tab = 'branches';
        this.gh.branches = [];
        this.gh.branchSearch = '';
        this.gh.prs = [];
        this.gh.localCopies = [];
        this.gh.loadingBranches = true;
        this._loadRepoLocalCopies(repo.nameWithOwner);
        try {
            this.gh.branches = await GIT.ghBranches(repo.nameWithOwner);
        } catch (e) {
            this.toast('Branches failed: ' + e.message, 'danger');
        } finally { this.gh.loadingBranches = false; }
    },

    // Resolve each registered local copy's current branch so the Branches tab
    // can list copies under the branch they're checked out to.
    async _loadRepoLocalCopies(ownerRepo) {
        const copies = this.repoCheckouts(ownerRepo).map(c => ({
            path: c.path,
            title: c.title || this._defaultRepoTitle(ownerRepo, c.path),
            branch: '',
        }));
        this.gh.localCopies = copies;
        for (const c of copies) {
            try { c.branch = (await GIT.currentBranch(c.path)) || ''; }
            catch (e) { c.branch = ''; }
            // Re-assign to trigger reactivity on the array element.
            this.gh.localCopies = this.gh.localCopies.map(x => x.path === c.path ? { ...x, branch: c.branch } : x);
        }
    },

    // Local copies currently checked out to a given branch name.
    copiesForBranch(branchName) {
        return (this.gh.localCopies || []).filter(c => c.branch === branchName);
    },

    async ghLoadPrs() {
        this.gh.tab = 'prs';
        if (this.gh.prs.length) return;
        this.gh.loadingPrs = true;
        try { this.gh.prs = await GIT.ghPullRequests(this.gh.selectedRepo); }
        catch (e) { this.toast('PRs failed: ' + e.message, 'danger'); }
        finally { this.gh.loadingPrs = false; }
    },

    // ─── Checkout & cache management ─────────────────────────────────────────
    async ensureRepoCache(ownerRepo, suggestDir, branch) {
        // Use the first still-valid local copy, dropping any stale entries.
        for (const e of this.repoCheckouts(ownerRepo)) {
            if (await GIT.isWorkTree(e.path)) {
                const remote = await GIT.getRemote(e.path);
                if (remote.ownerRepo === ownerRepo) return e.path;
            }
            await this._removeRepoCheckout(ownerRepo, e.path);
        }
        // None valid — clone a fresh copy.
        const def = (suggestDir || this.activeTab()?.path || this.homePath);
        const where = await this.askDirectory(
            'Choose the parent directory for the clone (a "' + ownerRepo.split('/').pop() + '" subfolder will be created)',
            def);
        if (!where) return null;
        const op = this._beginOp('Clone ' + ownerRepo);
        try {
            const target = await GIT.clone(ownerRepo, where, branch);
            await this._addRepoCheckout(ownerRepo, target);
            this._endOp(op, 'done');
            return target;
        } catch (e) { this._failOp(op, e); return null; }
    },

    // Clone an ADDITIONAL local copy even when one is already cached.
    async checkoutNewCopy(ownerRepo, branch) {
        ownerRepo = ownerRepo || this.gh.selectedRepo;
        if (!ownerRepo) return;
        const def = this.activeTab()?.path || this.homePath;
        const target = await this.askDirectory(
            'Choose (or create with "+ Folder") the folder to clone ' + ownerRepo + ' into — it should be empty',
            def);
        if (!target) return;
        const op = this._beginOp('Clone ' + ownerRepo + ' (new copy)');
        op.indeterminate = true;
        op.statusText = 'Starting…';
        try {
            await GIT.cloneIntoStream(ownerRepo, target, branch, (line) => {
                const m = line.match(/(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/);
                if (m) {
                    op.indeterminate = false;
                    op.progress = parseInt(m[2], 10);
                    op.statusText = m[1] + ' ' + m[2] + '%';
                } else if (/^(Cloning into|remote:|From )/.test(line)) {
                    op.statusText = line.slice(0, 80);
                }
            });
            op.progress = 100;
            await this._addRepoCheckout(ownerRepo, target);
            this._endOp(op, 'done');
            this.toast('Checked out new copy at ' + target);
            this.openCheckoutInTab(ownerRepo, target);
        } catch (e) {
            this._failOp(op, e);
            this.toast('Clone failed (the target folder may not be empty): ' + (e.message || e), 'danger');
        }
    },

    async openCheckoutInTab(ownerRepo, path) {
        const target = path || this.repoCheckout(ownerRepo);
        if (!target) return;
        const existing = this.tabs.find(t => t.kind === 'dir' && t.path === target);
        if (existing) { this.activeTabId = existing.id; }
        else { this.newTab(target); }
        bootstrap.Modal.getOrCreateInstance(this.ghModalEl).hide();
    },

    async cloneRepo(ownerRepo) {
        const path = await this.ensureRepoCache(ownerRepo);
        if (path) this.openCheckoutInTab(ownerRepo, path);
    },

    async registerExistingClone(ownerRepo) {
        const where = await this.askDirectory('Choose the existing local clone folder for ' + ownerRepo, this.activeTab()?.path || this.homePath);
        if (!where) return;
        if (!(await GIT.isWorkTree(where))) {
            this.toast('Not a git work-tree: ' + where, 'danger'); return;
        }
        const remote = await GIT.getRemote(where);
        if (remote.ownerRepo !== ownerRepo) {
            const ok = await this.askConfirm('Mismatch', `That repo's remote is ${remote.ownerRepo}, not ${ownerRepo}. Register anyway?`, 'Register');
            if (!ok) return;
        }
        await this._addRepoCheckout(ownerRepo, where);
        this.toast('Registered ' + where);
    },

    async changeCheckoutPath(ownerRepo, path) {
        if (path) await this._removeRepoCheckout(ownerRepo, path);
        return this.cloneRepo(ownerRepo);
    },

    async forgetCheckout(ownerRepo, path) {
        const target = path || this.repoCheckout(ownerRepo);
        if (!target) return;
        const choice = await this.askChoice('Forget local checkout',
            `What should happen to this copy?\n\n  ${target}\n\n• "Forget only" removes it from the cache but leaves the files on disk.\n• "Delete files & forget" also permanently deletes the folder.`,
            [
                { id: 'cancel', label: 'Cancel', variant: 'outline-secondary' },
                { id: 'forget', label: 'Forget only', variant: 'primary' },
                { id: 'delete', label: 'Delete files & forget', variant: 'danger' },
            ]);
        if (choice === 'cancel' || choice == null) return;
        if (choice === 'delete') {
            const op = this._beginOp('Delete ' + target);
            try {
                await FS.remove([target]);
                this._endOp(op, 'done');
            } catch (e) {
                try { await FS.remove([target], { admin: true }); this._endOp(op, 'done'); }
                catch (e2) { this._failOp(op, e2); this.toast('Delete failed: ' + (e2.message || e2), 'danger'); return; }
            }
        }
        await this._removeRepoCheckout(ownerRepo, target);
        this.toast(choice === 'delete' ? 'Deleted and unregistered ' + target : 'Unregistered ' + target);
        if (choice === 'delete') this._refreshAllGitInfo();
    },

    // Token-authed fetch from the canonical GitHub repo (works even when the
    // clone's own HTTPS remote can't read credentials non-interactively).
    // GIT_TERMINAL_PROMPT=0 ⇒ git errors out instead of hanging if it ever
    // needs to prompt for credentials.
    async _gitFetchAuthed(cache, ownerRepo, refspec) {
        const token = await GIT.ghToken();
        const args = ['env', 'GIT_TERMINAL_PROMPT=0', 'git', '-C', cache];
        let url = 'origin';
        if (token && ownerRepo) {
            url = 'https://github.com/' + ownerRepo + '.git';
            args.push('-c', 'http.extraheader=Authorization: Basic ' + btoa(token + ':'));
        }
        args.push('fetch', '--prune', url);
        if (refspec) args.push(refspec);
        await cockpit.spawn(args, { err: 'message' });
    },

    // Token-authed push to the canonical GitHub repo.
    async _gitPushAuthed(cache, ownerRepo, branch) {
        const token = await GIT.ghToken();
        const args = ['env', 'GIT_TERMINAL_PROMPT=0', 'git', '-C', cache];
        let url = 'origin';
        if (token && ownerRepo) {
            url = 'https://github.com/' + ownerRepo + '.git';
            args.push('-c', 'http.extraheader=Authorization: Basic ' + btoa(token + ':'));
        }
        args.push('push', url, (branch || 'HEAD'));
        await cockpit.spawn(args, { err: 'message' });
        // Pushing to an explicit URL doesn't move the local origin/<branch>
        // tracking ref, so sync it (push succeeded ⇒ origin matches local).
        if (branch) {
            try { await cockpit.spawn(['git', '-C', cache, 'update-ref', 'refs/remotes/origin/' + branch, branch], { err: 'message' }); } catch (e) {}
        }
    },

    _repoOwnerForTab(tab) {
        return (tab && tab.gitInfo && tab.gitInfo.remote && tab.gitInfo.remote.ownerRepo) || null;
    },

    async updateCheckout(ownerRepo, path) {
        const cache = path || this.repoCheckout(ownerRepo);
        if (!cache) return;
        const op = this._beginOp('Update ' + ownerRepo);
        try {
            await this._gitFetchAuthed(cache, ownerRepo, '+refs/heads/*:refs/remotes/origin/*');
            await GIT.pullFfLocal(cache);
            this._endOp(op, 'done');
            this.toast('Updated ' + ownerRepo);
            this._refreshAllGitInfo();
            if (this.gh.selectedRepo === ownerRepo) this._loadRepoLocalCopies(ownerRepo);
        } catch (e) {
            this._failOp(op, e);
            this.toast('Update failed (may have diverged): ' + (e.message || e), 'danger');
        }
    },

    async checkoutBranch(b) {
        const ownerRepo = this.gh.selectedRepo;
        const cache = await this.ensureRepoCache(ownerRepo, undefined, b.name);
        if (!cache) return;
        // Make sure we're on this branch (handles case where cache was created on default)
        const cur = await GIT.currentBranch(cache);
        if (cur !== b.name) {
            try { await GIT.checkoutBranch(cache, b.name); }
            catch (e) { this.toast('checkout failed: ' + e.message, 'danger'); return; }
        }
        this.openCheckoutInTab(ownerRepo);
    },

    async checkoutPr(pr) {
        const ownerRepo = this.gh.selectedRepo;
        const cache = await this.ensureRepoCache(ownerRepo);
        if (!cache) return;
        const op = this._beginOp('Checkout PR #' + pr.number);
        try {
            await cockpit.spawn(['gh', 'pr', 'checkout', String(pr.number), '--repo', ownerRepo], { directory: cache, err: 'message' });
            this._endOp(op, 'done');
            this.openCheckoutInTab(ownerRepo);
        } catch (e) { this._failOp(op, e); }
    },

    async updateBranch(b) {
        const ownerRepo = this.gh.selectedRepo;
        const cache = this.repoCheckout(ownerRepo);
        if (!cache) { this.toast('No local checkout — clone first.', 'danger'); return; }
        const op = this._beginOp('Update branch ' + b.name);
        try {
            const cur = await GIT.currentBranch(cache);
            if (cur === b.name) {
                await this._gitFetchAuthed(cache, ownerRepo, '+refs/heads/*:refs/remotes/origin/*');
                await GIT.pullFfLocal(cache);
            } else {
                // Fast-forward the (non-checked-out) local branch from the remote.
                await this._gitFetchAuthed(cache, ownerRepo, b.name + ':' + b.name);
            }
            this._endOp(op, 'done');
            this.toast('Updated branch ' + b.name);
            this._refreshAllGitInfo();
            this._loadRepoLocalCopies(ownerRepo);
        } catch (e) { this._failOp(op, e); this.toast('Update failed (may have diverged).', 'danger'); }
    },

    async createBranchFrom(fromBranch) {
        const newName = await this.askPrompt('Create branch',
            `New branch name (from "${fromBranch}")`, '');
        if (!newName) return;
        const ownerRepo = this.gh.selectedRepo;
        // Find sha from existing branches list
        const b = this.gh.branches.find(x => x.name === fromBranch);
        if (!b || !b.commit?.sha) { this.toast('No SHA known for ' + fromBranch, 'danger'); return; }
        const op = this._beginOp(`Create remote branch ${newName} from ${fromBranch}`);
        try {
            await GIT.ghCreateBranch(ownerRepo, newName, b.commit.sha);
            this._endOp(op, 'done');
            this.toast('Created ' + newName);
            this.selectRepo({ nameWithOwner: ownerRepo });
        } catch (e) { this._failOp(op, e); }
    },

    async askDeleteRemoteBranch(branchName) {
        const ownerRepo = this.gh.selectedRepo;
        const ok = await this.askTypeConfirm('Delete branch',
            `Delete remote branch "${branchName}" on ${ownerRepo}? This cannot be undone.`,
            branchName);
        if (!ok) return;
        const op = this._beginOp(`Delete remote branch ${branchName}`);
        try {
            await GIT.ghDeleteRemoteBranch(ownerRepo, branchName);
            this._endOp(op, 'done');
            this.toast('Deleted ' + branchName);
            this.selectRepo({ nameWithOwner: ownerRepo });
        } catch (e) { this._failOp(op, e); }
    },

    // ─── Type-to-confirm ─────────────────────────────────────────────────────
    askTypeConfirm(title, message, phrase) {
        return new Promise(resolve => {
            this.typeConfirm = { title, message, phrase, typed: '', resolve };
            bootstrap.Modal.getOrCreateInstance(this.typeConfirmModalEl).show();
        });
    },
    resolveTypeConfirm(ok) {
        const r = this.typeConfirm.resolve;
        this.typeConfirm.resolve = null;
        bootstrap.Modal.getOrCreateInstance(this.typeConfirmModalEl).hide();
        if (r) r(ok);
    },

    // ─── COMMIT BROWSER ──────────────────────────────────────────────────────
    async browseCommits(branchName) {
        const ownerRepo = this.gh.selectedRepo;
        // Show the commit LIST straight from the GitHub API — no local clone
        // needed. A clone is only required (and prompted for) when the user
        // drills into a commit's files/diff.
        this.commitBrowser = {
            repo: ownerRepo, branch: branchName, cachePath: null,
            commits: [], loadingCommits: true,
            selectedCommit: null, files: [], selectedFile: null, fileDiff: '',
        };
        bootstrap.Modal.getOrCreateInstance(this.commitBrowserModalEl).show();
        try {
            const raw = await GIT.ghBranchCommits(ownerRepo, branchName, 100);
            this.commitBrowser.commits = (raw || []).map(c => ({
                hash: c.sha,
                short: (c.sha || '').slice(0, 7),
                author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || '',
                email: (c.commit && c.commit.author && c.commit.author.email) || '',
                date: (c.commit && c.commit.author && c.commit.author.date) || '',
                subject: ((c.commit && c.commit.message) || '').split('\n')[0],
            }));
        } catch (e) {
            this.toast('Log failed: ' + (e.message || e), 'danger');
        } finally {
            this.commitBrowser.loadingCommits = false;
        }
    },

    // Ensure a local clone exists for diff/file operations in the commit browser.
    async _ensureCommitClone() {
        if (this.commitBrowser.cachePath) return this.commitBrowser.cachePath;
        const cache = await this.ensureRepoCache(this.commitBrowser.repo, undefined, this.commitBrowser.branch);
        if (cache) {
            const b = this.commitBrowser.branch;
            try { await this._gitFetchAuthed(cache, this.commitBrowser.repo, '+refs/heads/' + b + ':refs/remotes/origin/' + b); } catch (e) {}
            this.commitBrowser.cachePath = cache;
        }
        return cache;
    },

    // Make sure a specific commit object is present locally; fetch it on demand.
    // A cached clone may be a checkout of a different branch (e.g. master) and
    // its own remote auth may not work non-interactively, so we also fall back
    // to fetching the object straight from GitHub using the gh token.
    async _ensureCommitObject(cache, sha) {
        const has = async () => {
            try { await cockpit.spawn(['git', '-C', cache, 'cat-file', '-e', sha + '^{commit}'], { err: 'message' }); return true; }
            catch (e) { return false; }
        };
        if (await has()) return true;
        const branch = this.commitBrowser.branch;
        // 1) Try the clone's own remote (works if SSH/credential-helper auth is set up).
        for (const args of [['fetch', 'origin', sha], ['fetch', 'origin', branch], ['fetch', '--all']]) {
            try { await cockpit.spawn(['git', '-C', cache, ...args], { err: 'message' }); } catch (e) {}
            if (await has()) return true;
        }
        // 2) Fall back to an explicitly gh-token-authenticated HTTPS fetch from
        //    the repo, which doesn't depend on the clone's configured remote.
        try {
            const token = await GIT.ghToken();
            const ownerRepo = this.commitBrowser.repo;
            if (token && ownerRepo) {
                const url = 'https://github.com/' + ownerRepo + '.git';
                const hdr = 'http.extraheader=Authorization: Basic ' + btoa(token + ':');
                for (const ref of [branch, sha]) {
                    try { await cockpit.spawn(['git', '-C', cache, '-c', hdr, 'fetch', '--no-tags', url, ref], { err: 'message' }); } catch (e) {}
                    if (await has()) return true;
                }
            }
        } catch (e) {}
        return await has();
    },

    async selectCommit(c) {
        this.commitBrowser.selectedCommit = c;
        this.commitBrowser.files = [];
        this.commitBrowser.selectedFile = null;
        this.commitBrowser.fileDiff = '';
        this._clearCommitDiff();
        const cache = await this._ensureCommitClone();
        if (!cache) return; // user declined to clone
        const op = this._beginOp('Fetch commit ' + c.short);
        try {
            const ok = await this._ensureCommitObject(cache, c.hash);
            if (!ok) {
                this._failOp(op, new Error('commit not found in local clone'));
                this.toast('Could not fetch commit ' + c.short + ' into the local clone.', 'danger');
                return;
            }
            this.commitBrowser.files = await GIT.showCommitFiles(cache, c.hash);
            this._endOp(op, 'done');
        } catch (e) {
            this._failOp(op, e);
            this.toast('Show failed: ' + (e.message || e), 'danger');
        }
    },

    async selectCommitFile(f) {
        this.commitBrowser.selectedFile = f;
        const cb = this.commitBrowser;
        try {
            cb.fileDiff = await GIT.fileDiff(cb.cachePath, cb.selectedCommit.hash, f.path);
            await this._ensureScript('js/diff2html-ui.min.js', 'Diff2HtmlUI');
            this.renderDiff();
        } catch (e) {
            this.toast('Diff failed: ' + e.message, 'danger');
        }
    },

    renderDiff() {
        const cb = this.commitBrowser;
        const container = document.getElementById('cbDiffContainer');
        if (!container || !cb.fileDiff) return;
        if (!window.Diff2HtmlUI) return;
        container.innerHTML = '';
        const ui = new window.Diff2HtmlUI(container, cb.fileDiff, {
            drawFileList: false,
            matching: 'lines',
            outputFormat: this.settings.diffView === 'line' ? 'line-by-line' : 'side-by-side',
            highlight: false,
        });
        ui.draw();
    },
    // diff2html renders into #cbDiffContainer imperatively, so resetting the
    // reactive fileDiff alone leaves the rendered DOM behind — wipe it too.
    _clearCommitDiff() {
        const c = document.getElementById('cbDiffContainer');
        if (c) c.innerHTML = '';
    },
    _onCommitBrowserClosed() {
        this._clearCommitDiff();
        this.commitBrowser = {
            repo: '', branch: '', cachePath: null,
            commits: [], loadingCommits: false,
            selectedCommit: null, files: [], selectedFile: null, fileDiff: '',
        };
    },

    async viewFileAtCommit(f) {
        const cb = this.commitBrowser;
        try {
            const content = await GIT.fileAtCommit(cb.cachePath, cb.selectedCommit.hash, f.path);
            await this.openReadOnly(`${f.path} @ ${cb.selectedCommit.short}`, content, this._monacoLang(f.path));
        } catch (e) { this.toast('Show failed: ' + e.message, 'danger'); }
    },

    // ─── Current-repo toolbar actions (Fetch / Pull / Push / Commit) ────────
    async loadRepoBranches(tab) {
        if (!tab || !tab.path) return;
        const ownerRepo = tab.gitInfo?.remote?.ownerRepo || null;
        const here = tab.path;
        const buildCopies = () => (ownerRepo ? this.repoCheckouts(ownerRepo) : []).map(c => ({
            path: c.path,
            title: c.title || this._defaultRepoTitle(ownerRepo, c.path),
            current: here === c.path || here.startsWith(c.path + '/'),
        }));
        this.branchSwitcher = { path: here, current: tab.gitInfo?.branch || '', locals: [], remotes: [], copies: buildCopies(), ownerRepo, loading: true };
        try {
            const r = await GIT.branchList(tab.path);
            this.branchSwitcher = { path: here, current: r.current, locals: r.locals, remotes: r.remotes, copies: buildCopies(), ownerRepo, loading: false };
        } catch (e) {
            this.branchSwitcher.loading = false;
            this.toast('Could not list branches: ' + (e.message || e), 'danger');
        }
    },

    async switchRepoBranch(tab, branch, isRemote) {
        if (!tab || !tab.path) return;
        // For a remote-only branch (origin/foo), check out the bare name so git
        // creates a local tracking branch.
        const target = isRemote ? branch.replace(/^[^/]+\//, '') : branch;
        if (!isRemote && branch === (tab.gitInfo?.branch || '')) return; // already on it
        const op = this._beginOp('Switch to branch ' + target);
        try {
            await GIT.checkoutBranch(tab.path, target);
            this._endOp(op, 'done');
            this.toast('Switched to ' + target);
            await this._refreshAllGitInfo();
            this.reload(tab);
        } catch (e) {
            this._failOp(op, e);
            this.toast('Checkout failed (uncommitted changes may block it): ' + (e.message || e), 'danger');
        }
    },

    async repoFetch(tab) {
        const op = this._beginOp('Fetch ' + tab.gitInfo.branch);
        try { await this._gitFetchAuthed(tab.path, this._repoOwnerForTab(tab), '+refs/heads/*:refs/remotes/origin/*'); this._endOp(op, 'done'); this._refreshAllGitInfo(); }
        catch (e) { this._failOp(op, e); }
    },

    async repoPull(tab) {
        const op = this._beginOp('Pull ' + tab.gitInfo.branch);
        try {
            await this._gitFetchAuthed(tab.path, this._repoOwnerForTab(tab), '+refs/heads/*:refs/remotes/origin/*');
            await GIT.pullFfLocal(tab.path);
            this._endOp(op, 'done'); this._refreshAllGitInfo(); this.reload(tab);
        }
        catch (e) { this._failOp(op, e); this.toast('Pull failed (may have diverged).', 'danger'); }
    },

    async repoStageCommit(tab, alsoPush) {
        const msg = await this.askCommitMsg(tab.gitInfo.dirtyCount, alsoPush);
        if (!msg) return;
        const op = this._beginOp((alsoPush ? 'Commit & push' : 'Commit') + ' on ' + tab.gitInfo.branch);
        try {
            await GIT.stageAll(tab.path);
            await GIT.commit(tab.path, msg);
            this._endOp(op, 'done');
            this._refreshAllGitInfo();
            if (alsoPush) await this.repoPush(tab);
        } catch (e) { this._failOp(op, e); }
    },

    // Discard ALL uncommitted changes: reset tracked files to HEAD and remove
    // untracked (non-ignored) files/dirs. Only meaningful when the tree is dirty.
    async repoRollback(tab) {
        const info = tab.gitInfo;
        if (!info || !info.dirty) return;
        const n = info.dirtyCount || 0;
        const ok = await this.askConfirm('Roll back all changes',
            'Discard ALL uncommitted changes in:\n' + tab.path + '\n\n' +
            'This resets tracked files to the last commit (' + (info.branch || 'HEAD') + ') and deletes new/untracked files' +
            (n ? (' — ' + n + ' change(s) affected') : '') + '.\n\nThis cannot be undone.',
            'Discard everything');
        if (!ok) return;
        const op = this._beginOp('Roll back ' + (info.branch || 'changes'));
        try {
            await cockpit.spawn(['git', '-C', tab.path, 'reset', '--hard', 'HEAD'], { err: 'message' });
            await cockpit.spawn(['git', '-C', tab.path, 'clean', '-fd'], { err: 'message' });
            this._endOp(op, 'done');
            this._refreshAllGitInfo();
            this.reload(tab);
            this.toast('Rolled back all changes.', 'success');
        } catch (e) { this._failOp(op, e); this.toast('Rollback failed: ' + (e.message || e), 'danger'); }
    },

    askCommitMsg(fileCount, push) {
        return new Promise(resolve => {
            this.commitMsg = { message: '', fileCount, push, resolve };
            bootstrap.Modal.getOrCreateInstance(this.commitMsgModalEl).show();
        });
    },
    resolveCommitMsg(msg) {
        const r = this.commitMsg.resolve;
        this.commitMsg.resolve = null;
        bootstrap.Modal.getOrCreateInstance(this.commitMsgModalEl).hide();
        if (r) r(msg);
    },

    async repoPush(tab) {
        // Pre-check: fetch, then look for divergence
        const op = this._beginOp('Push ' + tab.gitInfo.branch + ' — checking remote');
        const owner = this._repoOwnerForTab(tab);
        try {
            await this._gitFetchAuthed(tab.path, owner, '+refs/heads/*:refs/remotes/origin/*');
            const st = await GIT.status(tab.path);
            this._endOp(op, 'done'); // pre-check finished (always — was previously only ended on divergence, which left it hung)
            if (st && st.behind > 0) {
                const choice = await this.askPushConflict(tab, st);
                if (choice === 'cancel' || choice === 'keep') return;
                if (choice === 'discard') {
                    const opd = this._beginOp('Discard local changes on ' + st.branch);
                    try {
                        await cockpit.spawn(['git', '-C', tab.path, 'reset', '--hard', 'origin/' + st.branch], { err: 'message' });
                        this._endOp(opd, 'done');
                        this._refreshAllGitInfo();
                        this.reload(tab);
                    } catch (e) { this._failOp(opd, e); }
                    return;
                }
            }
            // Pre-check OK — push
            const op2 = this._beginOp('Push ' + tab.gitInfo.branch + ' to origin');
            try {
                await this._gitPushAuthed(tab.path, owner, tab.gitInfo.branch);
                this._endOp(op2, 'done');
                this._refreshAllGitInfo();
            } catch (e) { this._failOp(op2, e); }
        } catch (e) {
            this._failOp(op, e);
        }
    },

    askPushConflict(tab, st) {
        return new Promise(resolve => {
            this.pushConflict = { tab, behind: st.behind, ahead: st.ahead, dirtyCount: st.dirtyCount, resolve };
            bootstrap.Modal.getOrCreateInstance(this.pushConflictModalEl).show();
        });
    },
    resolvePushConflict(choice) {
        const r = this.pushConflict.resolve;
        this.pushConflict.resolve = null;
        bootstrap.Modal.getOrCreateInstance(this.pushConflictModalEl).hide();
        if (r) r(choice);
    },

    // ─── PUBLISH PLAIN FOLDER TO GITHUB ──────────────────────────────────────
    async openPublishDialog(tab) {
        // Need gh installed + authed first
        if (!(await GIT.ghAvailable())) {
            this.toast('Install the GitHub CLI first (GH button).', 'danger');
            this.openGithubPanel(tab);
            return;
        }
        const auth = await GIT.ghAuthStatus();
        if (!auth.authed) {
            this.toast('Sign in to GitHub first (GH button).', 'danger');
            this.openGithubPanel(tab);
            return;
        }
        if (!this.gh.user) {
            try { this.gh.user = (await GIT.ghMe()).login; } catch (e) { this.gh.user = auth.user; }
        }

        // Reset state
        this.publish.folder = tab.path;
        this.publish.name = Util.basename(tab.path) || '';
        this.publish.nameError = '';
        this.publish.owner = this.gh.user;
        this.publish.visibility = 'private';
        this.publish.description = '';
        this.publish.commitMessage = 'Initial commit';
        this.publish.gitignore = '';
        this.publish.license = '';
        this.publish.error = '';
        this.publish.busy = false;
        this.publish.empty = (tab.files.length === 0);
        this.publish.orgs = [];
        this.validatePublishName();

        // Pre-flight scope check
        const scopes = await GIT.ghTokenScopes();
        if (!scopes.length) {
            this.publish.scopeUnknown = true;
            this.publish.scopeBlocked = false;
        } else {
            this.publish.scopeUnknown = false;
            this.publish.scopeBlocked = !scopes.includes('repo') && !scopes.includes('public_repo');
        }

        bootstrap.Modal.getOrCreateInstance(this.publishModalEl).show();

        // Load orgs in the background (needs read:org on classic tokens)
        GIT.ghOrgs().then(orgs => { this.publish.orgs = orgs; });
    },

    validatePublishName() {
        const n = this.publish.name || '';
        if (!n) { this.publish.nameError = 'Name is required.'; return; }
        if (n.length > 100) { this.publish.nameError = 'Too long (max 100).'; return; }
        if (!/^[A-Za-z0-9._-]+$/.test(n)) { this.publish.nameError = 'Only letters, digits, . _ - allowed.'; return; }
        if (n === '.' || n === '..') { this.publish.nameError = 'Invalid name.'; return; }
        this.publish.nameError = '';
    },

    async doPublish() {
        this.validatePublishName();
        if (this.publish.nameError || this.publish.scopeBlocked) return;
        this.publish.busy = true;
        this.publish.error = '';
        const folder = this.publish.folder;
        const ownerRepo = `${this.publish.owner}/${this.publish.name}`;
        const op = this._beginOp('Publish ' + ownerRepo);
        try {
            await GIT.publishToGitHub(folder, {
                owner: this.publish.owner,
                name: this.publish.name,
                visibility: this.publish.visibility,
                description: this.publish.description,
                commitMessage: this.publish.commitMessage,
                gitignore: this.publish.gitignore,
                license: this.publish.license,
            });
            // Register as a cached checkout
            await this._addRepoCheckout(ownerRepo, folder);
            this._endOp(op, 'done');
            this.toast('Published ' + ownerRepo);
            bootstrap.Modal.getOrCreateInstance(this.publishModalEl).hide();
            // Refresh git info so the tab shows as a repo, and reload listing
            await this._refreshAllGitInfo();
            const tab = this.tabs.find(t => t.path === folder && t.kind === 'dir');
            if (tab) this.reload(tab);
        } catch (e) {
            this._failOp(op, e);
            this.publish.error = e.message || String(e);
        } finally {
            this.publish.busy = false;
        }
    },

    // Date formatting for github panel
    formatRel(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const diff = (Date.now() - d.getTime()) / 1000;
        if (diff < 60) return Math.round(diff) + 's ago';
        if (diff < 3600) return Math.round(diff / 60) + 'm ago';
        if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
        if (diff < 30 * 86400) return Math.round(diff / 86400) + 'd ago';
        return d.toISOString().slice(0, 10);
    },

}));

}); // alpine:init
