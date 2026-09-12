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
assert.ok(G._aiValidTmux('claude_1.a-b') && !G._aiValidTmux('bad name') && !G._aiValidTmux('') && !G._aiValidTmux('a'.repeat(65)));
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

// diff argv per mode
assert.deepStrictEqual([...G._aiDiffArgv('/x', 'all')], ['git', '-C', '/x', 'diff', 'HEAD']);
assert.deepStrictEqual([...G._aiDiffArgv('/x', 'unstaged')], ['git', '-C', '/x', 'diff']);
assert.deepStrictEqual([...G._aiDiffArgv('/x', 'staged')], ['git', '-C', '/x', 'diff', '--staged']);

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

console.log('agent-unit: OK');
