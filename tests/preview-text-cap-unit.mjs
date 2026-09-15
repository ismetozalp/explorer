// Unit test for _pvTextPrep — the text-preview size cap that stops a big or
// minified file from locking the tab (the <pre> renders the whole file at once
// and Prism wraps every token in a span; a 3.7 MB file measured ~27 s before
// this). Caps rendered text at 512 KB and drops syntax highlighting past 100 KB.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(new URL('../js/features/editor.js', import.meta.url), 'utf8'),
    sandbox, { filename: new URL('../js/features/editor.js', import.meta.url).pathname });
const E = sandbox.window.ExplorerEditor;
assert.ok(E && typeof E._pvTextPrep === 'function', 'ExplorerEditor._pvTextPrep defined');

const PV_TEXT_MAX = 512 * 1024, PV_HL_MAX = 100 * 1024;

// small file: full content, highlighting on, not truncated
{
    const r = E._pvTextPrep('const x = 1;\n');
    assert.strictEqual(r.content, 'const x = 1;\n');
    assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.noHighlight, false);
    assert.strictEqual(r.fullBytes, 13);
}

// null/undefined → empty, safe
{
    const r = E._pvTextPrep(null);
    assert.strictEqual(r.content, ''); assert.strictEqual(r.truncated, false);
    assert.strictEqual(r.noHighlight, false); assert.strictEqual(r.fullBytes, 0);
}

// between HL and TEXT caps: full content kept, but highlighting OFF
{
    const s = 'a'.repeat(PV_HL_MAX + 5000);
    const r = E._pvTextPrep(s);
    assert.strictEqual(r.truncated, false, 'under text cap → not truncated');
    assert.strictEqual(r.content.length, s.length, 'full content kept');
    assert.strictEqual(r.noHighlight, true, 'over highlight cap → highlighting off');
}

// exactly at the highlight cap: still highlighted (boundary is `>`)
{
    const r = E._pvTextPrep('b'.repeat(PV_HL_MAX));
    assert.strictEqual(r.noHighlight, false, 'length === PV_HL_MAX must not disable highlighting');
}

// over the text cap: truncated to the cap, highlighting off, fullBytes is the real size
{
    const s = 'x'.repeat(PV_TEXT_MAX + 12345);
    const r = E._pvTextPrep(s);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.content.length, PV_TEXT_MAX, 'content capped at PV_TEXT_MAX');
    assert.strictEqual(r.fullBytes, s.length, 'fullBytes reports the untruncated size');
    assert.strictEqual(r.noHighlight, true, 'a truncated (huge) file is never highlighted');
}

// exactly at the text cap: not truncated (boundary is `>`)
{
    const r = E._pvTextPrep('y'.repeat(PV_TEXT_MAX));
    assert.strictEqual(r.truncated, false, 'length === PV_TEXT_MAX must not truncate');
}

console.log('preview-text-cap-unit: OK');
