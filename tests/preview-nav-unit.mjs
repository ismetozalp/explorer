import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
// Load utils (for isPreviewable) + editor mixin into one sandbox.
const sandbox = { window: {}, console };
vm.runInNewContext(fs.readFileSync(new URL('../js/utils.js', import.meta.url), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(new URL('../js/features/editor.js', import.meta.url), 'utf8'), sandbox);
const Util = sandbox.window.Util;
const E = sandbox.window.ExplorerEditor;

// Build the ordered previewable sublist + starting index the way openPreview will.
function buildNav(siblings, file) {
  const list = siblings.filter(Util.isPreviewable);
  const idx = list.findIndex(s => s.path === file.path);
  return { list, idx };
}
const f = (name) => ({ name, path: '/d/' + name, type: 'f' });
const sibs = [f('a.png'), { name: 'sub', path: '/d/sub', type: 'd' }, f('b.mkv'), f('c.bin'), f('d.md')];
const nav = buildNav(sibs, f('b.mkv'));
assert.deepStrictEqual(nav.list.map(x => x.name), ['a.png', 'b.mkv', 'd.md']); // dir + .bin skipped
assert.strictEqual(nav.idx, 1);

// previewStep math via a stub `this`
const stub = {
  windows: [{ id: 1, kind: 'preview', path: '/d/b.mkv', _file: f('b.mkv'), nav, pv: {} }],
  _win(id) { return this.windows.find(w => w.id === id); },
  _winTitle: (p) => p,
  activateWindow() {},
  _loadPreviewInto() { this._loaded = (this._loaded || 0) + 1; }, // count reloads
};
E.previewCanStep.call(stub, 1, -1); // no throw
assert.strictEqual(E.previewCanStep.call(stub, 1, -1), true);
assert.strictEqual(E.previewCanStep.call(stub, 1, +1), true);
E.previewStep.call(stub, 1, +1);
assert.strictEqual(stub._win(1).nav.idx, 2);
assert.strictEqual(stub._win(1).path, '/d/d.md');
assert.strictEqual(E.previewCanStep.call(stub, 1, +1), false); // at end
E.previewStep.call(stub, 1, +1); // clamped no-op
assert.strictEqual(stub._win(1).nav.idx, 2);
E.previewStep.call(stub, 1, -1);
E.previewStep.call(stub, 1, -1);
assert.strictEqual(stub._win(1).nav.idx, 0);
assert.strictEqual(E.previewCanStep.call(stub, 1, -1), false);
console.log('preview-nav-unit: OK');
