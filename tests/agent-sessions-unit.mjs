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

console.log('agent-sessions-unit: OK');
