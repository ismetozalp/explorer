// runtime.js — shared, non-reactive runtime for the Explorer component (2.0
// modularization). Loaded BEFORE every js/features/*.js and app.js. Holds config
// constants and the "reactivity firewall" instance registries: xterm/Monaco/
// Quill instances and op callbacks that must NOT live on Alpine reactive state
// (Alpine would deep-walk them and break their internals / fire callbacks during
// dependency tracking). Every feature mixin reads/writes these through window.ExRT.
window.ExRT = {
    const: {
        DEFAULT_SETTINGS: {
            showHidden: true,
            followSymlinks: true,
            persistTabs: true,
            columns: { size: true, modified: true, perms: true, owner: true, type: false },
            previewLimitMB: 10,
            outputMaxLines: 5000,      // streaming-pane line cap (0 = unlimited; oldest lines drop)
            theme: 'system',           // 'system' | 'light' | 'dark'
            updateRepo: 'ismetozalp/explorer',  // GitHub owner/repo (or releases URL) to check for updates
            updateCheckOnStart: true,           // auto-check for a newer release at startup
            clipboardUploadDir: '/tmp/explorer-clip', // remote dir for pasted terminal images
            clipboardKeepHours: 24,             // prune clip-* older than this many hours on paste (0 = never)
        },
        USER_ACTIONS_PATH_SUFFIX: '/.config/cockpit/explorer/actions.json',
        SYSTEM_ACTIONS_PATH: '/etc/cockpit/explorer/actions.json',
        USER_SCRIPTS_DIR_SUFFIX: '/.config/cockpit/explorer/scripts',
        SYSTEM_SCRIPTS_DIR: '/etc/cockpit/explorer/scripts',
        // Explorer Script Prompt Protocol markers (see interactive-scripts).
        PROMPT_START: '===EXPLORER-PROMPT===',
        MSG_START: '===EXPLORER-MESSAGE===',
        PROMPT_END: '===EXPLORER-END===',
        DISPLAY_TYPES: ['message', 'info', 'note', 'notify', 'progress', 'status', 'log'],
        LS_KEY_TABS: 'explorer:tabs',
        LS_KEY_SETTINGS: 'explorer:settings',
    },

    // Op callbacks (cancel fn, retry-as-admin fn) keyed by op.id. Kept off
    // reactive state: a function on a reactive op object gets evaluated during
    // Alpine dependency tracking, which fired op.cancel() immediately.
    ops: {
        cbs: new Map(),
        set(opId, key, fn) {
            let entry = this.cbs.get(opId);
            if (!entry) { entry = {}; this.cbs.set(opId, entry); }
            entry[key] = fn;
        },
        get(opId, key) {
            const entry = this.cbs.get(opId);
            return entry ? entry[key] : null;
        },
        clear(opId) { this.cbs.delete(opId); },
    },

    // Integrated-terminal instances (xterm Terminal + cockpit channel), keyed by
    // tab.id. Off reactive state so Alpine doesn't deep-walk xterm internals.
    term: {
        map: new Map(),
        reconn: new Map(),   // termId → { attempt, waits, timer } for auto-reconnect backoff
        pending: new Set(),  // termIds with a _mountTerminal chain in flight (double-mount guard)
        set(tabId, val) { this.map.set(tabId, val); },
        get(tabId) { return this.map.get(tabId); },
        del(tabId) {
            const inst = this.map.get(tabId);
            if (!inst) return;
            try { inst.channel && inst.channel.close('terminated'); } catch (e) {}
            try { inst.term && inst.term.dispose(); } catch (e) {}
            this.map.delete(tabId);
        },
    },

    // Monaco editor + per-window models. Enormous, self-referential objects that
    // freeze the page if proxied by reactivity — kept here as mutable properties.
    editor: { file: null, models: new Map() },   // file: single Monaco instance; models: windowId -> ITextModel
    actionsEditor: { editor: null, model: null }, // custom-actions JSON/YAML editor
    quill: { editor: null },                      // WYSIWYG editor (md/html)

    // Server-side video sessions (js/features/videoplayer.js). An hls.js
    // instance and a live cockpit.spawn() process handle must never be walked
    // by Alpine: reading them back through a reactive proxy is how a teardown
    // ends up calling destroy()/close() on a Proxy and throwing (which the
    // catch-alls then hide, turning "never leaks" into "leaks silently").
    //   sessions: windowId -> { hls, proc, dir, token }
    //   gen:      windowId -> monotonically increasing start generation; a
    //             start whose generation is stale has been superseded by a
    //             newer start (rapid ◀/▶) and must free only its own process.
    //   hb:       setInterval handle for the shared "prove this session is
    //             still being watched" heartbeat (touches <dir>/.alive for
    //             every live session), or null when no session is live. A
    //             timer handle is exactly the kind of thing this firewall
    //             exists for — never put it on reactive state.
    video: { sessions: new Map(), gen: new Map(), hb: null },

    // Parsed SheetJS workbooks for spreadsheet previews, windowId -> workbook.
    // Same firewall: the workbook is a big self-referential object; only the
    // rendered srcdoc + sheet names belong on the reactive window.
    //   gen: windowId -> monotonically increasing preview-load generation; a
    //        _loadPreviewInto call whose generation is stale has been
    //        superseded by a newer load for the same window (rapid ◀/▶) and
    //        must not write pv or register a workbook.
    preview: { workbooks: new Map(), gen: new Map() },
};
