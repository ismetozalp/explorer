import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appFile = new URL('../js/app.js', import.meta.url);

function setup(savedTabs, fromStorage = false) {
    const settings = Promise.withResolvers();
    const ticks = [];
    const classes = new Set(['explorer-loading']);
    const error = { hidden: true };
    let register;
    let factory;
    const sandbox = {
        document: {
            documentElement: { classList: { contains: name => classes.has(name), remove: name => classes.delete(name) } },
            addEventListener(event, fn) { if (event === 'alpine:init') register = fn; },
            getElementById: () => error,
        },
        Alpine: { data: (_, fn) => { factory = fn; } },
        ExRT: { const: { DEFAULT_SETTINGS: { persistTabs: true }, LS_KEY_TABS: 'explorer:tabs' } },
        FS: {
            homeDir: async () => '/home/demo',
            readText: async () => (savedTabs && !fromStorage ? JSON.stringify(savedTabs) : ''),
        },
        jsyaml: { load: JSON.parse },
        localStorage: {
            getItem: () => fromStorage ? JSON.stringify(savedTabs) : null,
            removeItem() {},
        },
        GIT: { ghAvailable: async () => false },
        cockpit: { spawn: async () => '/home/demo' },
        console: { error() {} },
        structuredClone,
        matchMedia: () => ({ matches: true, addEventListener() {} }),
        addEventListener() {},
    };
    sandbox.window = sandbox;
    vm.runInNewContext(fs.readFileSync(appFile, 'utf8'), sandbox, { filename: appFile.pathname });
    register();
    const app = Object.assign(factory(), {
        _loadRepoCache: async () => {},
        reapOrphanPreviews: async () => {},
        _loadSettings: () => settings.promise,
        _initExtensions() {},
        _initDeepLink() {},
        _handleDeepLink() {},
        _loadCustomActions() {},
        $watch() {},
        $nextTick(fn) { ticks.push(fn); },
        _buildTab(path) { return { id: path, path, kind: 'dir' }; },
        newTab(path) {
            const tab = this._buildTab(path);
            this.tabs.push(tab);
            this.activeTabId = tab.id;
        },
        activeTab() { return this.tabs.find(tab => tab.id === this.activeTabId); },
        _loadDir(tab) { this.listed = tab.path; },
        _restoreWindows(data) { this.restoredWindows = data.windows; },
    });
    return { app, settings, ticks, error, classes };
}

test('startup waits for settings and Alpine bindings before revealing the tabs', async () => {
    const saved = {
        tabs: [{ path: '/work', title: 'Work' }, { path: '/work' }, { path: '/tmp', kind: 'output' }],
        windows: [{ path: '/work/notes.txt' }],
        activeIdx: 3,
    };
    const legacy = {
        ...saved, activeIdx: undefined, tmuxTabs: [{ name: 'work' }], tmuxTitle: 'Terminal',
        tmuxTitles: { work: 'Work terminal' }, agentTabs: [{ path: '/work' }],
    };
    for (const state of [undefined, saved, legacy]) {
        const { app, classes, settings, ticks } = setup(state, state === legacy);
        const init = app.init();
        await Promise.resolve();
        assert.equal(classes.has('explorer-loading'), true);
        assert.equal(ticks.length, 0);

        settings.resolve();
        await init;
        assert.equal(classes.has('explorer-loading'), true);
        assert.equal(app.tabs.length, 1);
        assert.equal(app.activeTab().path, state ? '/work' : '/home/demo');
        assert.equal(app.ui.phone, true);
        if (state === legacy) {
            assert.equal(app._savedTmuxTabs[0].name, legacy.tmuxTabs[0].name);
            assert.deepEqual({ ...app._savedTmuxTitles }, legacy.tmuxTitles);
            assert.equal(app._savedTmuxTitle, legacy.tmuxTitle);
            assert.equal(app._savedAgentData.agentTabs[0].path, legacy.agentTabs[0].path);
        }

        assert.equal(ticks.length, 1);
        ticks[0]();
        assert.equal(classes.has('explorer-loading'), false);
        assert.equal(app.listed, app.activeTab().path);
        assert.equal(app.restoredWindows?.[0].path, state?.windows[0].path);
    }
});

test('a startup error keeps the interface hidden and displays an error', async () => {
    const { app, classes, error, settings, ticks } = setup();
    const init = app.init();
    settings.reject(new Error('Settings initialization failed'));
    await init;
    assert.equal(classes.has('explorer-loading'), true);
    assert.equal(error.hidden, false);
    assert.equal(ticks.length, 0);
});
