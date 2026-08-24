// Unit tests for moveTab / moveTerminal (pure array reorder). Loads the
// ExplorerTabs mixin into a vm sandbox and calls the methods on a stub `this`.
import { readFileSync } from 'fs';
import vm from 'vm';
import assert from 'assert';

const src = readFileSync(new URL('../js/core/tabs.js', import.meta.url), 'utf8');
const sandbox = { window: {}, Util: {}, FS: {}, ExRT: { term: { del() {} } }, cockpit: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: new URL('../js/core/tabs.js', import.meta.url).pathname });
const T = sandbox.window.ExplorerTabs;
assert.ok(T && typeof T.moveTab === 'function', 'moveTab should be defined');
assert.ok(typeof T.moveTerminal === 'function', 'moveTerminal should be defined');

function makeThis(tabs) {
  return Object.assign(Object.create(T), { tabs, _persistCalls: 0, _persistTabs() { this._persistCalls++; } });
}
const ids = arr => arr.map(x => x.id);

// ---- moveTab ----
{
  const self = makeThis([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  self.moveTab('a', 2);
  assert.deepStrictEqual(ids(self.tabs), ['b', 'c', 'a'], 'move first to end');
  assert.strictEqual(self._persistCalls, 1, 'persisted');
}
{
  const self = makeThis([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  self.moveTab('c', 0);
  assert.deepStrictEqual(ids(self.tabs), ['c', 'a', 'b'], 'move last to front');
}
{
  const self = makeThis([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  self.moveTab('b', 2);
  assert.deepStrictEqual(ids(self.tabs), ['a', 'c', 'b'], 'move middle to end');
}
{
  const self = makeThis([{ id: 'a' }, { id: 'b' }]);
  self.moveTab('a', 99); // out-of-range → clamp to end
  assert.deepStrictEqual(ids(self.tabs), ['b', 'a'], 'clamp high position');
}
{
  const self = makeThis([{ id: 'a' }, { id: 'b' }]);
  self.moveTab('zzz', 0); // unknown id → no-op, no persist
  assert.deepStrictEqual(ids(self.tabs), ['a', 'b'], 'unknown id no-op');
  assert.strictEqual(self._persistCalls, 0, 'no persist on no-op');
}
{
  const self = makeThis([{ id: 'a' }]);
  self.moveTab('a', 0); // single element → order unchanged
  assert.deepStrictEqual(ids(self.tabs), ['a'], 'single element');
}

// ---- moveTerminal ----
{
  const tab = { id: 'T', terminals: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] };
  const self = makeThis([tab]);
  self.moveTerminal(tab, 't1', 2);
  assert.deepStrictEqual(ids(tab.terminals), ['t2', 't3', 't1'], 'move sub-tab to end');
  assert.strictEqual(self._persistCalls, 1, 'persisted');
}
{
  const tab = { id: 'T', terminals: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] };
  const self = makeThis([tab]);
  self.moveTerminal({ id: 'T' }, 't3', 0); // pass a raw ref → must re-acquire proxy from this.tabs
  assert.deepStrictEqual(ids(tab.terminals), ['t3', 't1', 't2'], 'reacquire proxy + move to front');
}
{
  const tab = { id: 'T', terminals: [{ id: 't1' }] };
  const self = makeThis([tab]);
  self.moveTerminal(tab, 'nope', 0); // unknown terminal → no-op
  assert.deepStrictEqual(ids(tab.terminals), ['t1'], 'unknown terminal no-op');
  assert.strictEqual(self._persistCalls, 0, 'no persist on no-op');
}

// ---- serialization order (offline replica of _persistTabs() extraction) ----
// Confirms reordering via moveTab/moveTerminal changes the exact array
// values _persistTabs() would serialize, not just internal `this.tabs` order.
{
  const self = makeThis([
    { id: 'd1', kind: 'dir', path: '/a' },
    { id: 'd2', kind: 'dir', path: '/b' },
    { id: 'd3', kind: 'dir', path: '/c' },
  ]);
  const dirPathsBefore = self.tabs.filter(t => t.kind === 'dir').map(t => t.path);
  assert.deepStrictEqual(dirPathsBefore, ['/a', '/b', '/c'], 'dir paths start in insertion order');

  self.moveTab('d1', 2);

  const dirPathsAfter = self.tabs.filter(t => t.kind === 'dir').map(t => t.path);
  assert.deepStrictEqual(dirPathsAfter, ['/b', '/c', '/a'], 'dir path serialization order tracks moveTab reorder');
}
{
  const tab = {
    id: 'T', kind: 'terminal', termKind: 'tmux', activeTermId: 's1',
    terminals: [{ id: 's1', tmux: 'alpha' }, { id: 's2', tmux: 'beta' }, { id: 's3', tmux: 'gamma' }],
  };
  const self = makeThis([tab]);
  assert.strictEqual(self.termKindOf(tab), 'tmux', 'termKindOf reports tmux for termKind:"tmux" tab');

  const tmuxNamesOf = () => Array.from(new Set(self.tabs
    .filter(t => t.kind === 'terminal' && self.termKindOf(t) === 'tmux')
    .flatMap(t => (t.terminals || []).filter(x => x.tmux).map(x => x.tmux))));

  assert.deepStrictEqual(tmuxNamesOf(), ['alpha', 'beta', 'gamma'], 'tmux names start in insertion order');

  self.moveTerminal(tab, 's1', 2);

  assert.deepStrictEqual(tmuxNamesOf(), ['beta', 'gamma', 'alpha'], 'tmux name serialization order tracks moveTerminal reorder');
}

console.log('tab-reorder-unit: OK');
