// Unit tests for js/features/agent-sessions.js — the pure registry parsers
// (Claude top-level schema + Codex nested payload schema), complete-line
// handling, filename uuid, and sort. vm-loaded with {filename} for coverage.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const sandbox = { window: {} };
vm.runInNewContext(
    fs.readFileSync(new URL('../js/features/agent-sessions.js', import.meta.url), 'utf8'),
    sandbox, { filename: new URL('../js/features/agent-sessions.js', import.meta.url).pathname });
const A = sandbox.window.ExplorerAgentSessions;
assert.ok(A, 'ExplorerAgentSessions defined');

// ── expand-home ──
assert.strictEqual(A._aiExpandHome('~/.claude/projects', '/home/ismet'), '/home/ismet/.claude/projects');
assert.strictEqual(A._aiExpandHome('~', '/home/ismet'), '/home/ismet');
assert.strictEqual(A._aiExpandHome('/abs/path', '/home/ismet'), '/abs/path');

// ── Claude head (top-level cwd/sessionId/message.content) ──
const claudeHead =
    '{"type":"mode","sessionId":"11d5c0a4-b9cb-42db-b51b-a4a7893b0208"}\n' +
    '{"type":"user","cwd":"/home/ismet/explorer","message":{"role":"user","content":"help me fix the archive action"}}\n';
const c = A._aiParseHead(claudeHead, 'fallback');
assert.strictEqual(c.id, '11d5c0a4-b9cb-42db-b51b-a4a7893b0208');
assert.strictEqual(c.cwd, '/home/ismet/explorer');
assert.ok(/archive action/.test(c.title), 'claude title from message.content');

// content as an array of {text}
const claudeArr = '{"type":"user","cwd":"/x","message":{"role":"user","content":[{"type":"text","text":"hello there"}]}}\n';
assert.strictEqual(A._aiParseHead(claudeArr, 'fb').title, 'hello there');

// ── Codex head (nested payload; cwd on session_meta; user text in response_item) ──
// payload.id (the rollout id `codex resume` takes; == the filename) must win
// over payload.session_id (the PARENT thread id).
const codexHead =
    '{"timestamp":"t","type":"session_meta","payload":{"id":"01a097ca-e17b-7fd2-a402-cd02b9877a99","session_id":"01a097ca-e0c9-7423-ba6a-de8a7a5c1a9f","cwd":"/home/ismet/cockpit_projects/explorer"}}\n' +
    '{"timestamp":"t","type":"event_msg","payload":{"type":"turn"}}\n' +
    '{"timestamp":"t","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<recommended_plugins>ignore me</recommended_plugins>"}]}}\n' +
    '{"timestamp":"t","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"add a login screen"}]}}\n';
const x = A._aiParseHead(codexHead, 'fallback');
assert.strictEqual(x.id, '01a097ca-e17b-7fd2-a402-cd02b9877a99', 'codex resume id = payload.id (rollout id), not payload.session_id');
assert.strictEqual(x.cwd, '/home/ismet/cockpit_projects/explorer', 'codex cwd from payload.cwd');
assert.strictEqual(x.title, 'add a login screen', 'codex title skips <meta> wrapper, takes real user text');

// ── truncated head: drop the partial last line ──
const truncated = '{"type":"mode","sessionId":"abc"}\n{"type":"user","cwd":"/good","message":{"role":"user","content":"real"}}\n{"type":"user","cwd":"/BAD","message":{"role":"user","content":"trunc';
const tr = A._aiParseHead(truncated, 'fb');
assert.strictEqual(tr.cwd, '/good', 'truncated final record dropped');

// ── codex filename uuid + mtime listing + sort ──
assert.deepStrictEqual({ ...A._aiParseCodexName('rollout-2026-08-29T12-58-15-01a04cf4-a0e1-7dd0-93e1-8997be5d476a.jsonl') },
    { id: '01a04cf4-a0e1-7dd0-93e1-8997be5d476a' });
assert.strictEqual(A._aiParseCodexName('nope.txt'), null);

const listing = A._aiParseMtimeListing('1756400000.5\t/a/x.jsonl\n1756500000\t/a/y.jsonl\n', 'claude');
assert.deepStrictEqual([...listing.map(r => r.path)], ['/a/x.jsonl', '/a/y.jsonl']);
assert.strictEqual(listing[0].mtime, 1756400000);

assert.deepStrictEqual([...A._aiSortSessions([{ mtime: 1 }, { mtime: 9 }, { mtime: 5 }]).map(s => s.mtime)], [9, 5, 1]);

// ── filename base + parent dir (scan primitives) ──
assert.strictEqual(A._aiBase('/a/b/11d5c0a4-b9cb-42db-b51b-a4a7893b0208.jsonl'), '11d5c0a4-b9cb-42db-b51b-a4a7893b0208');
assert.strictEqual(A._aiDirOf('/a/b/c.jsonl'), '/a/b');

// ── group-by-dir (Claude: one head per project directory) ──
const grouped = A._aiGroupByDir([
    { path: '/proj-a/s1.jsonl', mtime: 1 },
    { path: '/proj-b/s2.jsonl', mtime: 2 },
    { path: '/proj-a/s3.jsonl', mtime: 3 },
]);
assert.strictEqual(grouped.size, 2, 'two distinct project dirs');
assert.deepStrictEqual([...grouped.get('/proj-a').map(f => f.path)], ['/proj-a/s1.jsonl', '/proj-a/s3.jsonl']);
assert.deepStrictEqual([...grouped.get('/proj-b').map(f => f.path)], ['/proj-b/s2.jsonl']);

// ── uuid session filter (exclude nested subagent transcripts) ──
assert.ok(A._aiIsUuid('11d5c0a4-b9cb-42db-b51b-a4a7893b0208') && A._aiIsUuid('01A04CF4-A0E1-7DD0-93E1-8997BE5D476A'));
assert.ok(!A._aiIsUuid('agent-a4fdd912d1fe691be') && !A._aiIsUuid('') && !A._aiIsUuid('subagents'));

// ── temp-folder exclusion (by real cwd) ──
assert.ok(A._aiIsTempPath('/tmp/claude-1000/x/scratchpad'), '/tmp subpath is temp');
assert.ok(A._aiIsTempPath('/tmp'), 'the temp root itself');
assert.ok(A._aiIsTempPath('/var/tmp/foo') && A._aiIsTempPath('/dev/shm/bar'), 'other temp roots');
assert.ok(!A._aiIsTempPath('/home/ismet/tmpwork'), 'tmp as a name fragment is not temp');
assert.ok(!A._aiIsTempPath('/home/ismet/cockpit_projects/explorer') && !A._aiIsTempPath('') && !A._aiIsTempPath(null));
// ── temp-folder exclusion (by encoded Claude folder name, cwd-less head) ──
assert.ok(A._aiEncodedDirIsTemp('-tmp-claude-1000--home-ismet-x-scratchpad'), 'encoded /tmp/... folder');
assert.ok(A._aiEncodedDirIsTemp('-var-tmp-x') && A._aiEncodedDirIsTemp('-dev-shm-y'));
assert.ok(!A._aiEncodedDirIsTemp('-home-ismet-cockpit-projects-explorer'), 'a real project folder');
assert.ok(!A._aiEncodedDirIsTemp('-home-ismet-tmpwork'), 'tmp as a name fragment');

// ── max-depth clamp (user-configurable scan depth) ──
assert.strictEqual(A._aiMaxDepth(3, 2), 3, 'valid depth passes through');
assert.strictEqual(A._aiMaxDepth('4', 2), 4, 'numeric string coerced');
assert.strictEqual(A._aiMaxDepth(undefined, 2), 2, 'missing → default');
assert.strictEqual(A._aiMaxDepth(0, 5), 5, 'below 1 → default');
assert.strictEqual(A._aiMaxDepth(-1, 5), 5, 'negative → default');
assert.strictEqual(A._aiMaxDepth('abc', 5), 5, 'non-numeric → default');
assert.strictEqual(A._aiMaxDepth(999, 2), 12, 'clamped to 12 ceiling');

console.log('agent-sessions-unit: OK');
