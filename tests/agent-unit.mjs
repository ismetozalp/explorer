// Unit tests for the pure helpers in js/features/agent.js — validators,
// CLI-command building (incl. resume + invalid-id handling), labels, diff argv
// per mode, unified-diff file parsing, and the change-hash. vm-loaded with
// {filename} for coverage.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const sb = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../js/features/agent.js', import.meta.url), 'utf8'),
    sb, { filename: new URL('../js/features/agent.js', import.meta.url).pathname });
const G = sb.window.ExplorerAgent;
assert.ok(G, 'ExplorerAgent defined (IIFE ran)');

// validators
assert.ok(G._aiValidDir('/home/ismet') && !G._aiValidDir('rel') && !G._aiValidDir(''));
assert.ok(G._aiValidTmux('claude_1-a-b') && !G._aiValidTmux('bad name') && !G._aiValidTmux('') && !G._aiValidTmux('a'.repeat(65)));
assert.ok(!G._aiValidTmux('claude-app.js'), 'tmux rejects "." (app.js folder) — validator must too');
// sanitize → always a VALID tmux name (periods, spaces, parens → "-")
assert.strictEqual(G._aiSanitizeTmux('claude-my project (x)'), 'claude-my-project-x');
assert.strictEqual(G._aiSanitizeTmux('claude-app.js'), 'claude-app-js');
assert.ok(G._aiValidTmux(G._aiSanitizeTmux('claude-app.js')));
assert.strictEqual(G._aiSanitizeTmux('///'), 'session');
assert.ok(G._aiValidTmux(G._aiSanitizeTmux('a'.repeat(200))) && G._aiSanitizeTmux('a'.repeat(200)).length === 64);
assert.ok(G._aiValidTmux(G._aiSanitizeTmux('codex-inFlightTV-01a04cf4')));
// name+suffix: the SUFFIX is preserved, the base is truncated to fit ≤ 64
assert.strictEqual(G._aiTmuxName('claude-explorer', '-11d5c0a4'), 'claude-explorer-11d5c0a4');
assert.strictEqual(G._aiTmuxName('x', ''), 'x');
const longTmux = G._aiTmuxName('a'.repeat(70), '-11d5c0a4');
assert.ok(longTmux.endsWith('-11d5c0a4') && longTmux.length <= 64 && G._aiValidTmux(longTmux), 'long base keeps the resume suffix and stays valid');
assert.ok(G._aiValidUuid('01a04cf4-a0e1-7dd0-93e1-8997be5d476a') && G._aiValidUuid('11d5c0a4-b9cb-42db-b51b-a4a7893b0208'));
assert.ok(!G._aiValidUuid('abc') && !G._aiValidUuid('x;rm -rf') && !G._aiValidUuid(''));

// cli command (new + resume + invalid resume)
assert.strictEqual(G._aiCliCommand('claude', null), 'claude');
assert.strictEqual(G._aiCliCommand('codex', null), 'codex');
assert.strictEqual(G._aiCliCommand('claude', '11d5c0a4-b9cb-42db-b51b-a4a7893b0208'), 'claude --resume 11d5c0a4-b9cb-42db-b51b-a4a7893b0208');
assert.strictEqual(G._aiCliCommand('codex', '01a04cf4-a0e1-7dd0-93e1-8997be5d476a'), 'codex resume 01a04cf4-a0e1-7dd0-93e1-8997be5d476a');
assert.strictEqual(G._aiCliCommand('codex', 'not-a-uuid'), null, 'invalid resume id → null (caller errors, no silent new session)');

// labels
assert.strictEqual(G._aiNextLabel([], 'claude'), 'claude');
assert.strictEqual(G._aiNextLabel([{ tool: 'claude' }, { tool: 'codex' }], 'claude'), 'claude 2');
assert.strictEqual(G._aiNextLabel([{ tool: 'claude' }], 'codex'), 'codex');

// diff script per mode (bounded shell body: tracked + untracked, capped)
const sAll = G._aiDiffScript('all');
assert.ok(sAll.includes('diff') && sAll.includes(' HEAD ') && sAll.includes('4b825dc642cb6eb9a060e54bf8d69288fbee4904') &&
    sAll.includes('ls-files --others') && sAll.includes('xargs -0') && sAll.includes('core.quotePath=false') &&
    sAll.includes('color.ui=false') && sAll.includes('--no-color') && sAll.includes('--src-prefix=a/') && sAll.includes('--no-ext-diff') &&
    sAll.includes('rev-parse --show-toplevel') && sAll.includes('head -c 300000'),
    'all: diff HEAD + empty-tree fallback + NUL untracked + color off + fixed prefixes + toplevel cd + 300 KB cap');
const sUn = G._aiDiffScript('unstaged');
assert.ok(sUn.includes('--no-ext-diff') && sUn.includes('ls-files --others') && !sUn.includes(' HEAD ') && !sUn.includes('--staged'),
    'unstaged: git diff + untracked, no HEAD, not staged');
const sSt = G._aiDiffScript('staged');
assert.ok(sSt.includes('--staged') && !sSt.includes('ls-files --others'),
    'staged: git diff --staged, no untracked');

// unified-diff → changed-files strip
const diff = [
    'diff --git a/js/app.js b/js/app.js',
    'index 111..222 100644',
    '--- a/js/app.js',
    '+++ b/js/app.js',
    '@@ -1,3 +1,4 @@',
    ' context',
    '-old line',
    '+new line',
    '+another added',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1 @@',
    '-title',
    '+Title',
].join('\n');
const files = G._aiDiffFiles(diff).map(f => `${f.file}:${f.added}:${f.removed}`);
assert.deepStrictEqual([...files], ['js/app.js:2:1', 'README.md:1:1']);

// change hash
const s = { diff: { hash: '' } };
assert.ok(G._aiDiffChanged(s, 'abc'), 'first content is a change');
assert.ok(!G._aiDiffChanged(s, 'abc'), 'same content is not a change');
assert.ok(G._aiDiffChanged(s, 'abcd'), 'new content is a change');

// group-by-project (resume browser)
const rows = [
  { cwd:'/a', tool:'claude', id:'1', mtime:100, title:'a1', path:'p1' },
  { cwd:'/b', tool:'codex',  id:'2', mtime:300, title:'b1', path:'p2' },
  { cwd:'/a', tool:'claude', id:'3', mtime:200, title:'a2', path:'p3' },
];
const groups = G._aiGroupByProject(rows);
assert.strictEqual(groups.length, 2, 'two distinct project folders');
assert.strictEqual(groups[0].cwd, '/b', 'group with newest session (/b @300) sorts first');
assert.strictEqual(groups[1].cwd, '/a');
assert.strictEqual(groups[1].count, 2);
assert.strictEqual(groups[1].latest.id, '3', 'latest in /a is the newest (mtime 200)');
assert.deepStrictEqual([...groups[1].sessions.map(x=>x.id)], ['3','1'], 'sessions newest-first within a group');
assert.strictEqual(G._aiGroupByProject([{ cwd:'', tool:'claude', id:'x', mtime:1, path:'p' }])[0].cwd, '(unknown folder)');

// tmux session names on a tab (for close-time terminate prompt)
assert.deepStrictEqual([...G._aiTabTmuxNames({ terminals: [{ tmux: 'claude-a' }, { tmux: '' }, {}, { tmux: 'codex-b' }] })], ['claude-a', 'codex-b']);
assert.deepStrictEqual([...G._aiTabTmuxNames({ terminals: [] })], []);
assert.deepStrictEqual([...G._aiTabTmuxNames(null)], []);

// git-quoted path decoding (non-ASCII → octal-escaped UTF-8; control chars)
assert.strictEqual(G._aiDecodeGitPath('caf\\303\\251.txt'), 'café.txt');
assert.strictEqual(G._aiDecodeGitPath('a\\tb\\"c'), 'a\tb"c');
// mixed LITERAL Unicode (kept raw by core.quotePath=false) + an escape must not corrupt the UTF-8
assert.strictEqual(G._aiDecodeGitPath('café\\t.txt'), 'café\t.txt');
assert.strictEqual(G._aiDecodeGitPath('é\\303\\251'), 'éé');
assert.strictEqual(G._aiDiffFilePath('diff --git a/js/app.js b/js/app.js'), 'js/app.js');
assert.strictEqual(G._aiDiffFilePath('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"'), 'café.txt');
// a name with spaces makes the "diff --git" header ambiguous — the real path
// must come from the +++/--- markers (via _aiDiffFiles/_aiDiffSections)
assert.strictEqual(G._aiPathFromMarker('+++ b/a b/file.txt'), 'a b/file.txt');
assert.strictEqual(G._aiPathFromMarker('--- /dev/null'), '');
assert.strictEqual(G._aiPathFromMarker('+++ "b/caf\\303\\251 x.txt"'), 'café x.txt');
const spaceDiff = ['diff --git a/a b/file.txt b/a b/file.txt', 'index 1..2 100644', '--- a/a b/file.txt', '+++ b/a b/file.txt', '@@ -1 +1 @@', '-x', '+y'].join('\n');
assert.strictEqual(G._aiDiffFiles(spaceDiff)[0].file, 'a b/file.txt', 'space-in-name: path from +++ marker, not the ambiguous header');
assert.strictEqual(G._aiDiffSections(spaceDiff)[0].file, 'a b/file.txt');
assert.strictEqual(G._aiDiffFiles(spaceDiff)[0].added, 1);

// diff sectioning + per-file selection + colored HTML
const sample = [
    'diff --git a/js/app.js b/js/app.js', 'index 1..2 100644', '--- a/js/app.js', '+++ b/js/app.js',
    '@@ -1,2 +1,2 @@', ' ctx', '-old', '+new',
    'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-a', '+b',
].join('\n');
const sections = G._aiDiffSections(sample);
assert.strictEqual(sections.length, 2, 'two file sections');
assert.deepStrictEqual([...sections.map(s => s.file)], ['js/app.js', 'README.md']);
// no selection → all; selection → only chosen sections, back-to-back
assert.strictEqual(G._aiVisibleDiffText({ diff: { text: sample, selected: [] } }), sample);
const visOne = G._aiVisibleDiffText({ diff: { text: sample, selected: ['README.md'] } });
assert.ok(visOne.includes('README.md') && !visOne.includes('js/app.js'), 'only the selected file section shows');
// colored HTML with the expected line classes
const html = G.aiDiffHtml({ diff: { text: sample, selected: [] } });
assert.ok(html.includes('adl add') && html.includes('adl del') && html.includes('adl hunk') && html.includes('adl meta') && html.includes('adl ctx'));
// line-number gutters parsed from the "@@ -1,2 +1,2 @@" hunk: context line 1/1, deletion old=2 new blank
assert.ok(html.includes('<span class="ln">1</span><span class="ln">1</span><span class="lc"> ctx</span>'), 'context line shows old+new number');
assert.ok(html.includes('<span class="ln">2</span><span class="ln"></span><span class="lc">-old</span>'), 'deletion shows old number only');
assert.ok(html.includes('<span class="ln"></span><span class="ln">2</span><span class="lc">+new</span>'), 'addition shows new number only');
// content lines that begin with "+++"/"---" INSIDE a hunk are add/del content, not file-header meta
const tricky = ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,2 +1,3 @@', ' keep', '-++removed', '+++added', '+tail'].join('\n');
const th = G.aiDiffHtml({ diff: { text: tricky, selected: [] } });
assert.ok(th.includes('<div class="adl del"><span class="ln">2</span><span class="ln"></span><span class="lc">-++removed</span>'), '"-++" line is a deletion, numbered');
assert.ok(th.includes('<div class="adl add"><span class="ln"></span><span class="ln">2</span><span class="lc">+++added</span>'), '"+++" line inside a hunk is an addition, numbered');
assert.ok(th.includes('<div class="adl add"><span class="ln"></span><span class="ln">3</span><span class="lc">+tail</span>'), 'gutter counter stays correct after "+++" content');
// same "+++"/"---" content must be COUNTED in the changed-files strip, not skipped as a header
const tf = G._aiDiffFiles(tricky);
assert.strictEqual(tf.length, 1);
assert.strictEqual(tf[0].added, 2, '"+++added" and "+tail" both counted as additions');
assert.strictEqual(tf[0].removed, 1, '"-++removed" counted as a deletion');
// HTML is escaped
assert.ok(G.aiDiffHtml({ diff: { text: 'diff --git a/x b/x\n+<b>&z', selected: [] } }).includes('&lt;b&gt;&amp;z'));
assert.strictEqual(G.aiDiffHtml({ diff: { text: '', selected: [] } }), '', 'empty diff → empty html');
// toggle selection
const sSel = { diff: { selected: [] } };
G.aiDiffToggleFile(sSel, 'a'); G.aiDiffToggleFile(sSel, 'b');
assert.deepStrictEqual([...sSel.diff.selected], ['a', 'b']);
assert.ok(G.aiDiffFileSelected(sSel, 'a'));
G.aiDiffToggleFile(sSel, 'a');
assert.deepStrictEqual([...sSel.diff.selected], ['b']);
G.aiDiffClearSelection(sSel);
assert.deepStrictEqual([...sSel.diff.selected], []);

console.log('agent-unit: OK');
