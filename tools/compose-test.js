#!/usr/bin/env node
// Runtime composition test for the 2.0 modularization: loads runtime.js +
// js/features/*.js + js/core/*.js + app.js in browser order inside a vm sandbox,
// runs the captured Alpine.data('explorer') factory, and asserts every module's
// methods actually landed on the component. A missing/broken mixin spread drops
// methods silently — node --check can't catch that, this does.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const load = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// Permissive stub for library globals (cockpit/Util/FS/GIT/monaco/…): any read
// returns a callable no-op proxy, so load + factory eval never hit "X undefined".
const anyProxy = new Proxy(function () {}, {
    get: (t, p) => (p === Symbol.toPrimitive ? () => '' : anyProxy),
    apply: () => anyProxy, construct: () => anyProxy,
});

let alpineInit = null, factory = null;
const sandbox = {};
Object.assign(sandbox, {
    window: sandbox, globalThis: sandbox, self: sandbox,
    document: { addEventListener: (ev, cb) => { if (ev === 'alpine:init') alpineInit = cb; },
                querySelector: () => null, querySelectorAll: () => [], createElement: () => anyProxy,
                body: anyProxy },
    Alpine: { data: (name, f) => { if (name === 'explorer') factory = f; }, store: () => {}, magic: () => {} },
    console, structuredClone, JSON, Math, Date, Object, Array, Map, Set, Promise, RegExp, String, Number,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { clipboard: undefined, userAgent: 'node' },
    location: { href: 'http://localhost/', protocol: 'http:' },
    cockpit: anyProxy, Util: anyProxy, FS: anyProxy, GIT: anyProxy, bootstrap: anyProxy,
    Terminal: anyProxy, FitAddon: anyProxy, Prism: anyProxy, monaco: anyProxy, Quill: anyProxy,
    jsyaml: anyProxy, TextDecoder: anyProxy, TextEncoder: anyProxy, fetch: () => Promise.resolve(anyProxy),
    getComputedStyle: () => ({ zIndex: '0' }), atob: s => s, btoa: s => s, URL: anyProxy,
});
vm.createContext(sandbox);

// Load in the exact index.html order.
const files = ['js/runtime.js'];
for (const sub of ['js/features', 'js/core'])
    for (const f of fs.readdirSync(path.join(root, sub)).sort()) if (f.endsWith('.js')) files.push(sub + '/' + f);
files.push('js/app.js');

for (const rel of files) {
    try { vm.runInContext(load(rel), sandbox, { filename: rel }); }
    catch (e) { console.error(`LOAD FAILED ${rel}: ${e.message}`); process.exit(1); }
}

// Check every feature/core global is a real object (not undefined → dead spread).
const globals = ['ExRT','ExplorerGrub','ExplorerMounts','ExplorerGithub','ExplorerActions',
    'ExplorerTerminal','ExplorerUpload','ExplorerEditor','ExplorerTabs','ExplorerFileList',
    'ExplorerFileOps','ExplorerOutput','ExplorerDialogs','ExplorerSettings'];
const missingG = globals.filter(g => !sandbox[g] || typeof sandbox[g] !== 'object');
if (missingG.length) { console.error('MISSING GLOBALS:', missingG.join(', ')); process.exit(1); }

if (!alpineInit) { console.error('alpine:init callback never registered'); process.exit(1); }
alpineInit();                       // runs Alpine.data('explorer', factory)
if (!factory) { console.error('Alpine.data("explorer", …) never called'); process.exit(1); }

let comp;
try { comp = factory(); } catch (e) { console.error('factory() threw:', e.message, '\n', e.stack); process.exit(1); }

// Representative method from every module — must be a function on the component.
const need = {
    tabs: ['newTab','activateTab','closeTab','currentPane','navigate','goBack','reload'],
    filelist: ['selectedFiles','sortedFiles','closeContextMenu','runSearch','termLabel'],
    fileops: ['copyToClipboard','paste','renameSelected','deleteSelected','downloadSelected','propertiesSelected'],
    output: ['_beginOp','_endOp','_failOp','_feedOutput','openRunCommand','doRunCommand','clearFinishedOperations'],
    dialogs: ['askConfirm','askPrompt','toast','_dpChoose'],
    settings: ['saveSettings','onKey'],
    editor: ['openPreview','openEditor','closeActiveWindow','termKindOf'],
    upload: ['_doUpload','extractHere','compressSelected'],
    actions: ['runCustomAction','reloadActions','openActionsManager','_promptTmuxName'],
    terminal: ['addTerminalToTab','openTmuxSession','_mountTerminal','_copyToClipboard'],
    github: ['openGithubPanel','checkForUpdate','browseCommits','ghLogin','_withGhAuth'],
    grub: ['loadGrub','saveGrub','openGrub'],
    mounts: ['loadFstab','saveFstab','_hasFindmnt'],
    init: ['init','_initExtensions'],
};
const missing = [];
for (const [mod, methods] of Object.entries(need))
    for (const m of methods) if (typeof comp[m] !== 'function') missing.push(`${mod}.${m}`);

const keys = Object.keys(comp);
const fnCount = keys.filter(k => typeof comp[k] === 'function').length;

if (missing.length) {
    console.error(`COMPONENT MISSING ${missing.length} method(s):`);
    for (const m of missing) console.error('  ' + m);
    process.exit(1);
}
console.log(`OK — component assembled: ${keys.length} keys (${fnCount} methods), all ${Object.values(need).flat().length} probed methods present across 13 modules + init.`);
