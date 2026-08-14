// Regression test for Task 3 fix-round-1 Important #1: .docx/spreadsheet
// preview branches in _loadPreviewInto must enforce the same size guard as
// markdown/text (spec §7: "Large outputs are capped ... oversized -> fall
// back to the binary panel with a note") — a huge file must NOT be read into
// an ArrayBuffer and handed to mammoth/XLSX at all.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(new URL('../js/utils.js', import.meta.url), 'utf8'), sandbox);
// editor.js references bare `Util`/`FS` (as it would via <script> globals in
// the browser) — expose them as bare globals in this same vm context, not
// just as window.* properties, before editor.js's methods actually run.
sandbox.Util = sandbox.window.Util;
// Same for ExRT (js/runtime.js): editor.js keeps the parsed workbook and the
// Monaco/Quill instances there, off Alpine reactive state.
vm.runInNewContext(fs.readFileSync(new URL('../js/runtime.js', import.meta.url), 'utf8'), sandbox);
sandbox.ExRT = sandbox.window.ExRT;
let readBinaryCalls = 0;
let readTextCalls = 0;
sandbox.FS = {
    readBinaryAsBlob: async () => { readBinaryCalls++; return { arrayBuffer: async () => new ArrayBuffer(8) }; },
    readText: async () => { readTextCalls++; return 'text'; },
};
vm.runInNewContext(fs.readFileSync(new URL('../js/features/editor.js', import.meta.url), 'utf8'), sandbox);
const E = sandbox.window.ExplorerEditor;
const Util = sandbox.window.Util;

const LIMIT_MB = 10;
const LIMIT_BYTES = LIMIT_MB * 1024 * 1024;

function makeStub() {
    return {
        settings: { previewLimitMB: LIMIT_MB },
        windows: [{ id: 1, kind: 'preview', pv: {}, loading: true }],
        _win(id) { return this.windows.find(w => w.id === id); },
        _looksPermissionDenied() { return false; },
        // Stub the lazy-loaders so a would-be *successful* (under-limit) parse
        // wouldn't crash for lack of window.mammoth/XLSX — not exercised by
        // the oversized cases below, but kept realistic for the under-limit
        // control case.
        _ensureMammoth: async () => {},
        _ensureXlsx: async () => {},
    };
}

// ---- docx, oversized: must short-circuit to 'binary' without ever reading the file.
{
    readBinaryCalls = 0;
    const stub = makeStub();
    const file = { name: 'huge.docx', path: '/d/huge.docx', type: 'f', size: LIMIT_BYTES + 1 };
    await E._loadPreviewInto.call(stub, 1, file);
    const pv = stub._win(1).pv;
    assert.strictEqual(pv.kind, 'binary', `expected binary fallback for oversized .docx, got ${pv.kind}`);
    assert.match(pv.reason || '', /too large/i);
    assert.match(pv.reason || '', new RegExp(LIMIT_MB + ' MB'));
    assert.strictEqual(readBinaryCalls, 0, 'FS.readBinaryAsBlob must NOT be called for an oversized .docx');
    console.log('OK docx oversized -> binary, reason: ' + JSON.stringify(pv.reason) + ', readBinaryAsBlob calls: ' + readBinaryCalls);
}

// ---- spreadsheet, oversized: same guard.
{
    readBinaryCalls = 0;
    const stub = makeStub();
    const file = { name: 'huge.xlsx', path: '/d/huge.xlsx', type: 'f', size: LIMIT_BYTES + 5 * 1024 * 1024 };
    await E._loadPreviewInto.call(stub, 1, file);
    const pv = stub._win(1).pv;
    assert.strictEqual(pv.kind, 'binary', `expected binary fallback for oversized .xlsx, got ${pv.kind}`);
    assert.match(pv.reason || '', /too large/i);
    assert.match(pv.reason || '', new RegExp(LIMIT_MB + ' MB'));
    assert.strictEqual(readBinaryCalls, 0, 'FS.readBinaryAsBlob must NOT be called for an oversized .xlsx');
    console.log('OK xlsx oversized -> binary, reason: ' + JSON.stringify(pv.reason) + ', readBinaryAsBlob calls: ' + readBinaryCalls);
}

// ---- control: an under-limit docx must NOT hit the guard (still attempts the read/parse path).
{
    readBinaryCalls = 0;
    const stub = makeStub();
    const file = { name: 'small.docx', path: '/d/small.docx', type: 'f', size: 1024 };
    await E._loadPreviewInto.call(stub, 1, file);
    const pv = stub._win(1).pv;
    assert.strictEqual(readBinaryCalls, 1, 'under-limit .docx should still read the file (guard must not false-trigger)');
    // window.mammoth isn't stubbed, so the actual convert call throws and this
    // still lands on kind:'binary' via the try/catch — but crucially with a
    // *different* reason than the size guard's, proving the guard itself
    // didn't fire (it's the missing-mammoth-global that fails here, which is
    // a sandbox-test artifact, not the guard).
    assert.doesNotMatch(pv.reason || '', /too large/i);
    console.log('OK docx under limit: guard did not false-trigger (readBinaryAsBlob called once); pv.kind=' + pv.kind + ' reason=' + JSON.stringify(pv.reason));
}

// Sanity: confirm the module-level `limit` used really is settings.previewLimitMB * 1MB
// by checking the boundary is exactly LIMIT_BYTES (size===limit must NOT trip the guard,
// matching the existing `>` comparison used by every other branch in this function).
{
    readBinaryCalls = 0;
    const stub = makeStub();
    const file = { name: 'exact.docx', path: '/d/exact.docx', type: 'f', size: LIMIT_BYTES };
    await E._loadPreviewInto.call(stub, 1, file);
    assert.strictEqual(readBinaryCalls, 1, 'size === limit must not trip the "too large" guard (matches the `>` comparator elsewhere)');
    console.log('OK boundary: size === limit does not trip the guard (consistent with the existing `>` comparator)');
}

console.log('preview-doc-size-guard-unit: OK');
