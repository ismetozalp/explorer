// Regression test for preview-reap-hardening FIX 3: _loadPreviewInto is
// called concurrently for one window on rapid ◀/▶ (previewStep) or a
// retry-as-admin race. Before this fix there was no generation guard, so a
// slow-finishing OLDER load could resolve after a faster NEWER one and
// clobber both `pv` and (worse) the spreadsheet workbook registry — the
// spreadsheet branch called `ExRT.preview.workbooks.set(id, wb)` AFTER its
// own set(), so the older load could leave the newer file's pv.sheets paired
// against the OLDER file's workbook, and the sheet picker then threw
// ("Could not render sheet.").
//
// This drives the REAL js/features/editor.js _loadPreviewInto with FS/XLSX
// stubbed and one call deliberately parked mid-flight so the interleaving is
// deterministic: the older call is released only after the newer one has
// already written pv + the workbook.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(new URL('../js/utils.js', import.meta.url), 'utf8'), sandbox);
sandbox.Util = sandbox.window.Util;   // editor.js refers to the bare global, same as in a real page (window IS global there)
vm.runInNewContext(fs.readFileSync(new URL('../js/runtime.js', import.meta.url), 'utf8'), sandbox);
sandbox.ExRT = sandbox.window.ExRT;
vm.runInNewContext(fs.readFileSync(new URL('../js/features/editor.js', import.meta.url), 'utf8'), sandbox);
const Util = sandbox.window.Util;
const E = sandbox.window.ExplorerEditor;
const ExRT = sandbox.ExRT;

function makeApp(extra) {
    return Object.assign(Object.create(null), E, {
        settings: { previewLimitMB: 10 },
        windows: [],
        _win(id) { return this.windows.find((w) => w.id === id); },
        _looksPermissionDenied: () => false,
        _vpMaybeStart() {},
    }, extra || {});
}

// ─────────────────────────────────────────────────────────────────────────
// (1) Spreadsheet race: older load resolves after the newer one — the
//     workbook registry and pv.sheets must both reflect the NEWER load, not
//     get split between the two (the exact "Could not render sheet." bug).
// ─────────────────────────────────────────────────────────────────────────
{
    ExRT.preview.workbooks.clear(); ExRT.preview.gen.clear();
    let readSeq = 0;
    let releaseA;
    const parkA = new Promise((resolve) => { releaseA = resolve; });
    sandbox.FS = {
        readText: async () => '',
        readBinaryAsBlob: async (path) => {
            if (path === '/d/a.xlsx') await parkA;   // older call parks here
            return { arrayBuffer: async () => new ArrayBuffer(0) };
        },
    };
    // XLSX.read is called AFTER readBinaryAsBlob resolves, so call order
    // (not file identity) tags which workbook is "newer": B (fast) reads
    // first -> seq 1; A (parked, slow) reads second -> seq 2, once released.
    sandbox.XLSX = {
        read: () => { readSeq += 1; const name = 'Sheet-' + readSeq; return { SheetNames: [name], Sheets: { [name]: {} } }; },
        utils: { sheet_to_html: () => '<table></table>' },
    };

    const fileA = { name: 'a.xlsx', path: '/d/a.xlsx', size: 100, type: 'f' };
    const fileB = { name: 'b.xlsx', path: '/d/b.xlsx', size: 100, type: 'f' };
    assert.ok(Util.isSpreadsheet(fileA));

    const app = makeApp({ _ensureXlsx: async () => {} });
    app.windows.push({ id: 'w1', kind: 'preview', path: fileA.path, _file: fileA, pv: { kind: null }, loading: true });

    const pA = E._loadPreviewInto.call(app, 'w1', fileA);          // older, will park mid-read
    await new Promise((r) => setTimeout(r, 0));                     // let A reach the park point
    const pB = E._loadPreviewInto.call(app, 'w1', fileB);           // newer, supersedes A
    await pB;

    const afterB = app._win('w1');
    assert.strictEqual(afterB.pv.kind, 'sheet');
    assert.deepStrictEqual(afterB.pv.sheets, ['Sheet-1'], 'the newer (faster) load must own pv after it resolves');
    assert.strictEqual(ExRT.preview.workbooks.get('w1').SheetNames[0], 'Sheet-1', 'workbook must match the newer load');

    releaseA();                    // the dangerous moment: the OLDER load finally resolves
    await pA;

    const afterA = app._win('w1');
    assert.deepStrictEqual(afterA.pv.sheets, ['Sheet-1'],
        'a superseded OLDER load must not overwrite pv with its own (Sheet-2) data');
    assert.strictEqual(ExRT.preview.workbooks.get('w1').SheetNames[0], 'Sheet-1',
        'a superseded OLDER load must not overwrite the workbook registry — this is the exact bug: ' +
        'pv.sheets and the workbook going out of sync makes the sheet picker throw');
    console.log('OK FIX3 (spreadsheet): superseded older load wrote neither pv nor the workbook registry');
}

// ─────────────────────────────────────────────────────────────────────────
// (2) General pv clobber + no leak: an image preview race. The superseded
//     load's own object URL must be revoked (not silently leaked) instead of
//     landing in pv, and the newer load's URL must be left alone.
// ─────────────────────────────────────────────────────────────────────────
{
    ExRT.preview.workbooks.clear(); ExRT.preview.gen.clear();
    let releaseA;
    const parkA = new Promise((resolve) => { releaseA = resolve; });
    sandbox.FS = {
        readBinaryAsBlob: async (path) => {
            const tag = path === '/d/a.png' ? 'A' : 'B';
            if (tag === 'A') await parkA;
            return { tag };
        },
    };
    sandbox.URL = { createObjectURL: (blob) => 'blob:' + blob.tag };

    const fileA = { name: 'a.png', path: '/d/a.png', size: 10, type: 'f' };
    const fileB = { name: 'b.png', path: '/d/b.png', size: 10, type: 'f' };
    assert.ok(Util.isImage(fileA));

    const revoked = [];
    const app = makeApp({ _revokePvUrl: (url) => { if (url) revoked.push(url); } });
    app.windows.push({ id: 'w2', kind: 'preview', path: fileA.path, _file: fileA, pv: { kind: null }, loading: true });

    const pA = E._loadPreviewInto.call(app, 'w2', fileA);
    await new Promise((r) => setTimeout(r, 0));
    const pB = E._loadPreviewInto.call(app, 'w2', fileB);
    await pB;

    assert.strictEqual(app._win('w2').pv.url, 'blob:B', 'the newer load must own pv.url');
    assert.deepStrictEqual(revoked, [], 'nothing should be revoked yet — the newer load had no previous url to free');

    releaseA();
    await pA;

    assert.strictEqual(app._win('w2').pv.url, 'blob:B', 'a superseded older load must not clobber pv.url');
    assert.deepStrictEqual(revoked, ['blob:A'], 'the superseded load must revoke its OWN url instead of leaking it, and must not touch the newer one');
    console.log('OK FIX3 (image): superseded older load left pv alone and revoked only its own url (no leak)');
}

// ─────────────────────────────────────────────────────────────────────────
// (3) previewStep / retryPreviewAsAdmin still work in the normal, non-racing
//     case (each is a single _loadPreviewInto call — the generation bump
//     must be transparent).
// ─────────────────────────────────────────────────────────────────────────
{
    ExRT.preview.workbooks.clear(); ExRT.preview.gen.clear();
    sandbox.FS = { readText: async (p) => 'hello ' + p };
    const file = { name: 'a.txt', path: '/d/a.txt', size: 10, type: 'f' };
    const app = makeApp();
    app.windows.push({ id: 'w3', kind: 'preview', path: file.path, _file: file, pv: { kind: null }, loading: true });
    await E._loadPreviewInto.call(app, 'w3', file);
    assert.strictEqual(app._win('w3').pv.kind, 'text');
    assert.strictEqual(app._win('w3').pv.content, 'hello /d/a.txt');
    assert.strictEqual(ExRT.preview.gen.get('w3'), 1);
    // A second, sequential (non-overlapping) load bumps the generation again
    // and still writes normally — the guard only blocks a call whose
    // generation has been superseded, not sequential calls.
    await E._loadPreviewInto.call(app, 'w3', file, true);
    assert.strictEqual(ExRT.preview.gen.get('w3'), 2);
    assert.strictEqual(app._win('w3').pv.content, 'hello /d/a.txt');
    console.log('OK previewStep/retryPreviewAsAdmin: sequential loads still write normally');
}

console.log('preview-load-race-unit: OK');
