// Unit tests for closeTerminal's split/tab-close invariant: closing the LAST
// terminal must close the split (dir) or the tab (terminal-kind) regardless of
// which sub-tab was active — so no path can leave an open-but-empty terminal
// pane. Loads the mixin into a vm sandbox and calls closeTerminal with a stub
// `this` (no cockpit/DOM needed).
import { readFileSync } from 'fs';
import vm from 'vm';
import assert from 'assert';

const src = readFileSync(new URL('../js/features/terminal.js', import.meta.url), 'utf8');
const sandbox = {
  window: { removeEventListener() {} },
  ExRT: { term: { get: () => null, del() {} } },
  Util: {}, cockpit: {}, document: {}, console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: new URL('../js/features/terminal.js', import.meta.url).pathname });
const T = sandbox.window.ExplorerTerminal;
assert.ok(T && typeof T.closeTerminal === 'function', 'ExplorerTerminal.closeTerminal should be defined');

function makeThis(extra = {}) {
  return Object.assign(Object.create(T), {
    closeTab() { this._closeTabCalled = true; },
    selectTerminal(tab, id) { tab.activeTermId = id; this._selected = id; },
  }, extra);
}

// 1. THE latent gap: last terminal closed while activeTermId points elsewhere
//    (stale/null). The split must still close.
{
  const self = makeThis();
  const tab = { kind: 'dir', splitOpen: true, activeTermId: 'STALE', terminals: [{ id: 'A' }] };
  self.closeTerminal(tab, 'A');
  assert.strictEqual(tab.terminals.length, 0);
  assert.strictEqual(tab.splitOpen, false, 'split must close even when activeTermId was stale');
  assert.strictEqual(tab.activeTermId, null);
  console.log('  ok: stale-active last-close closes the split');
}

// 2. Normal case: closing the active last terminal closes the split.
{
  const self = makeThis();
  const tab = { kind: 'dir', splitOpen: true, activeTermId: 'A', terminals: [{ id: 'A' }] };
  self.closeTerminal(tab, 'A');
  assert.strictEqual(tab.splitOpen, false);
  assert.strictEqual(tab.activeTermId, null);
  console.log('  ok: active last-close closes the split');
}

// 3. Closing the active terminal with others remaining reselects a neighbour;
//    split stays open.
{
  const self = makeThis();
  const tab = { kind: 'dir', splitOpen: true, activeTermId: 'A', terminals: [{ id: 'A' }, { id: 'B' }] };
  self.closeTerminal(tab, 'A');
  assert.deepStrictEqual(tab.terminals.map(t => t.id), ['B']);
  assert.strictEqual(tab.activeTermId, 'B', 'reselected the neighbour');
  assert.strictEqual(tab.splitOpen, true);
  console.log('  ok: active close with others reselects, split stays');
}

// 4. Closing a NON-active terminal leaves the active one and the split intact.
{
  const self = makeThis();
  const tab = { kind: 'dir', splitOpen: true, activeTermId: 'A', terminals: [{ id: 'A' }, { id: 'B' }] };
  self.closeTerminal(tab, 'B');
  assert.deepStrictEqual(tab.terminals.map(t => t.id), ['A']);
  assert.strictEqual(tab.activeTermId, 'A', 'active unchanged');
  assert.strictEqual(tab.splitOpen, true);
  console.log('  ok: non-active close keeps active + split');
}

// 5. terminal-kind tab: closing the last terminal closes the whole tab, even
//    when activeTermId was stale.
{
  const self = makeThis();
  const tab = { id: 'tab1', kind: 'terminal', activeTermId: 'STALE', terminals: [{ id: 'A' }] };
  self.closeTerminal(tab, 'A');
  assert.strictEqual(self._closeTabCalled, true, 'terminal-kind last-close closes the tab');
  console.log('  ok: terminal-kind last-close closes the tab');
}

console.log('terminal-close-unit: OK');
