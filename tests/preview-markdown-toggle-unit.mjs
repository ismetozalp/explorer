// Regression test for Task 3 fix-round-1 Important #2: when marked fails to
// load/render (_renderMarkdown returns null), _loadPreviewInto falls back to
// {kind:'text', lang:'markdown', mdMode:'source'} with no srcdoc. Before the
// fix, toggleMarkdownMode could still be reached (the button's x-show only
// checked pv.kind/pv.lang, not pv.srcdoc) and a second click flipped
// kind → 'markdown' while srcdoc stayed undefined — a blank iframe. The fix
// makes toggleMarkdownMode itself refuse to switch to 'markdown' without a
// srcdoc, so no sequence of toggle clicks can reach that state, independent
// of whatever mdMode _loadPreviewInto happens to leave behind.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(new URL('../js/utils.js', import.meta.url), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(new URL('../js/features/editor.js', import.meta.url), 'utf8'), sandbox);
const E = sandbox.window.ExplorerEditor;

function stubWith(pv) {
    return { windows: [{ id: 1, kind: 'preview', pv }], _win(id) { return this.windows.find(w => w.id === id); } };
}
// Invariant this test exists to enforce: never reach kind==='markdown' with no
// srcdoc to actually render, whatever mdMode says.
function assertNeverBlankMarkdown(pv) {
    assert.ok(!(pv.kind === 'markdown' && !pv.srcdoc), `blank markdown iframe: ${JSON.stringify(pv)}`);
}

// ---- 1. The render-failure fallback state _loadPreviewInto now produces
// (mdMode:'source' explicitly set alongside the html==null branch). Click the
// toggle several times (covers any parity of clicks a user might make) and
// assert the invariant holds after every single click, plus that we never
// even leave 'text' (there is nothing valid to switch to).
{
    const stub = stubWith({ kind: 'text', content: 'raw md', lang: 'markdown', mdMode: 'source', srcdoc: undefined, permissionDenied: false });
    for (let i = 0; i < 5; i++) {
        E.toggleMarkdownMode.call(stub, 1);
        const pv = stub._win(1).pv;
        assertNeverBlankMarkdown(pv);
        assert.strictEqual(pv.kind, 'text', `click ${i + 1}: kind should stay 'text' with no srcdoc, got ${pv.kind}`);
    }
    console.log('OK fallback (mdMode:"source", no srcdoc): 5 toggle clicks all stayed on text, no blank iframe');
}

// ---- 2. Defense in depth: even the OLD/pre-fix shape (mdMode left
// undefined, as _loadPreviewInto's html==null branch did before this fix)
// must not blank out either — the guard in toggleMarkdownMode is what
// actually prevents it, not just the mdMode default.
{
    const stub = stubWith({ kind: 'text', content: 'raw md', lang: 'markdown', srcdoc: undefined, permissionDenied: false }); // no mdMode at all
    for (let i = 0; i < 5; i++) {
        E.toggleMarkdownMode.call(stub, 1);
        const pv = stub._win(1).pv;
        assertNeverBlankMarkdown(pv);
        assert.strictEqual(pv.kind, 'text', `click ${i + 1}: kind should stay 'text' with no srcdoc, got ${pv.kind}`);
    }
    console.log('OK fallback (no mdMode, no srcdoc): 5 toggle clicks all stayed on text, no blank iframe — guard holds even without the mdMode fix');
}

// ---- 3. Success path must still work: srcdoc present → toggle flips
// markdown/rendered ↔ text/source cleanly and back, srcdoc never lost.
{
    const stub = stubWith({ kind: 'markdown', md: '# H', content: '# H', lang: 'markdown', mdMode: 'rendered', srcdoc: '<h1>H</h1>', permissionDenied: false });
    E.toggleMarkdownMode.call(stub, 1);
    let pv = stub._win(1).pv;
    assert.strictEqual(pv.kind, 'text');
    assert.strictEqual(pv.mdMode, 'source');
    assert.strictEqual(pv.srcdoc, '<h1>H</h1>', 'srcdoc must survive the round trip');
    E.toggleMarkdownMode.call(stub, 1);
    pv = stub._win(1).pv;
    assert.strictEqual(pv.kind, 'markdown');
    assert.strictEqual(pv.mdMode, 'rendered');
    assert.strictEqual(pv.srcdoc, '<h1>H</h1>');
    console.log('OK success path: markdown/rendered <-> text/source toggles cleanly, srcdoc preserved');
}

console.log('preview-markdown-toggle-unit: OK');
