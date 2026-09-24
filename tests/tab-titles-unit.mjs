// Unit tests for editable tab / sub-tab titles (v4.4.0): the customTitle
// override in tabLabel/termLabel and the edit start/commit/cancel helpers.
import { readFileSync } from 'fs';
import vm from 'vm';
import assert from 'assert';

const src = readFileSync(new URL('../js/core/tabs.js', import.meta.url), 'utf8');
const Util = { basename: p => (p || '').split('/').filter(Boolean).pop() || p };
const sandbox = { window: {}, Util, FS: {}, ExRT: { term: { del() {} } }, cockpit: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: new URL('../js/core/tabs.js', import.meta.url).pathname });
const T = sandbox.window.ExplorerTabs;
const makeThis = () => Object.assign(Object.create(T), { _persistCalls: 0, _persistTabs() { this._persistCalls++; } });

// ── tabLabel: customTitle wins over the dynamic label, for every kind ──
{
  const self = makeThis();
  assert.strictEqual(self.tabLabel({ kind: 'dir', path: '/home/ismet/x' }), 'x', 'dir label = basename');
  assert.strictEqual(self.tabLabel({ kind: 'dir', path: '/home/ismet/x', customTitle: 'Work' }), 'Work', 'customTitle overrides dir');
  assert.strictEqual(self.tabLabel({ kind: 'agent', terminals: [], customTitle: 'Bots' }), 'Bots', 'customTitle overrides agent');
  assert.strictEqual(self.tabLabel({ kind: 'output', outputActionLabel: 'build' }), '▶ build', 'no customTitle → dynamic');
}

// ── termLabel: customTitle wins over tmux/cwd ──
{
  const self = makeThis();
  assert.strictEqual(self.termLabel({ tmux: 'srv' }), '⧉ srv', 'tmux default');
  assert.strictEqual(self.termLabel({ tmux: 'srv', customTitle: 'Server' }), 'Server', 'customTitle overrides tmux');
  assert.strictEqual(self.termLabel({ dir: '/var/log', customTitle: 'Logs' }), 'Logs', 'customTitle overrides cwd');
  assert.strictEqual(self.termLabel(null), '', 'null → empty');
}

// ── top-tab edit lifecycle ──
{
  const self = makeThis();
  const tab = { kind: 'dir', path: '/home/ismet/proj' };
  self.startTabTitleEdit(tab);
  assert.strictEqual(tab._editingTitle, true);
  assert.strictEqual(tab._titleDraft, 'proj', 'draft prefills with current label');
  self.commitTabTitle(tab, '  My Project  ');
  assert.strictEqual(tab.customTitle, 'My Project', 'commit trims + stores');
  assert.strictEqual(tab._editingTitle, false);
  assert.strictEqual(self._persistCalls, 1, 'commit persists');
  // editing again prefills with the custom title
  self.startTabTitleEdit(tab);
  assert.strictEqual(tab._titleDraft, 'My Project');
  // committing empty clears the custom title (back to dynamic)
  self.commitTabTitle(tab, '   ');
  assert.strictEqual(tab.customTitle, '', 'empty clears customTitle');
  assert.strictEqual(self.tabLabel(tab), 'proj', 'reverts to dynamic label');
}

// ── cancel keeps the old title ──
{
  const self = makeThis();
  const tab = { kind: 'dir', path: '/a/b', customTitle: 'Keep' };
  self.startTabTitleEdit(tab);
  self.cancelTabTitle(tab);
  assert.strictEqual(tab._editingTitle, false);
  assert.strictEqual(tab.customTitle, 'Keep', 'cancel does not change the title');
  assert.strictEqual(self._persistCalls, 0, 'cancel does not persist');
}

// ── sub-tab edit: prefill differs for AI sessions vs plain/tmux terminals ──
{
  const self = makeThis();
  const term = { dir: '/srv/app' };
  self.startTermTitleEdit(term);
  assert.strictEqual(term._titleDraft, '❯ /srv/app', 'terminal prefills from termLabel');
  const ai = { tool: 'claude', label: 'auth-refactor', dir: '/srv/app' };
  self.startTermTitleEdit(ai);
  assert.strictEqual(ai._titleDraft, 'auth-refactor', 'AI session prefills from its label, not the cwd');
  self.commitTermTitle(ai, 'Auth work');
  assert.strictEqual(ai.customTitle, 'Auth work');
  assert.strictEqual(ai._editingTitle, false);
  assert.strictEqual(self._persistCalls, 1, 'sub-tab commit persists');
}

// ── null-safety: the edit helpers no-op on a missing tab/terminal ──
{
  const self = makeThis();
  self.startTabTitleEdit(null); self.commitTabTitle(null, 'x'); self.cancelTabTitle(null);
  self.startTermTitleEdit(null); self.commitTermTitle(null, 'x'); self.cancelTermTitle(null);
  assert.strictEqual(self._persistCalls, 0, 'no-ops never persist');
}

console.log('tab-titles-unit: OK');
