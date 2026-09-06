// Unit tests for _parseShells / _pickDefaultShell (js/core/settings.js) — the
// pure half of the /etc/shells handling that js/app.js's _initExtensions()
// wraps in I/O. Same vm-sandbox pattern as repo-cache-unit.mjs: load the mixin
// into a sandbox that provides the `window` it assigns to, then call its
// methods directly.
//
// The regression under test is issue #1: a duplicate line in /etc/shells fed
// an x-for keyed on the shell path (html/modals/toolbar.html), Alpine saw two
// identical :key values, and its keyed diff threw inside init — taking the
// whole component down, so Cockpit showed "Ooops!" instead of the file
// manager. Uniqueness of the returned list is the invariant that markup needs.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const url = new URL('../js/core/settings.js', import.meta.url);
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(url, 'utf8'), sandbox, { filename: url.pathname });
const S = sandbox.window.ExplorerSettings;

const DEFAULTS = ['/bin/sh', '/bin/bash'];
// The mixin runs inside the vm, so the arrays it builds carry the sandbox's
// Array.prototype — which deepStrictEqual counts as a difference. Spreading
// re-homes the result in this realm so the comparisons read normally.
const parse = (txt, fallback = DEFAULTS) => [...S._parseShells(txt, fallback)];

// ── The reported bug ────────────────────────────────────────────────────────
// The exact /etc/shells from issue #1, duplicate line and all.
assert.deepStrictEqual(
    parse([
        '# /etc/shells: valid login shells',
        '/bin/sh',
        '/bin/bash',
        '/bin/zsh',
        '/usr/bin/zsh',
        '/usr/bin/zsh',
        '',
    ].join('\n')),
    ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/zsh'],
    'a repeated line must collapse to one entry'
);

// The invariant the markup depends on, stated directly: whatever the file
// holds, no two entries are equal.
for (const txt of [
    '/bin/sh\n/bin/sh\n/bin/sh',
    '/bin/bash\n/bin/sh\n/bin/bash\n/bin/sh',
    '  /bin/zsh  \n/bin/zsh\n\t/bin/zsh\t',           // dupes only after trimming
]) {
    const out = parse(txt);
    assert.strictEqual(new Set(out).size, out.length, `keys must be unique for: ${JSON.stringify(txt)}`);
}

// Order is first-seen: the settings dropdown shouldn't reshuffle because a
// duplicate appeared further down the file.
assert.deepStrictEqual(
    parse('/bin/zsh\n/bin/sh\n/bin/zsh\n/bin/bash'),
    ['/bin/zsh', '/bin/sh', '/bin/bash'],
    'de-duplication keeps the first occurrence, in file order'
);

// ── Parsing ─────────────────────────────────────────────────────────────────
assert.deepStrictEqual(parse('/bin/sh\n/bin/bash\n'), ['/bin/sh', '/bin/bash'], 'trailing newline yields no empty entry');
assert.deepStrictEqual(parse('  /bin/sh  \n\t/bin/bash\t'), ['/bin/sh', '/bin/bash'], 'entries are trimmed');
assert.deepStrictEqual(parse('# comment\n/bin/sh\n   # indented comment\n/bin/bash'), ['/bin/sh', '/bin/bash'], 'comments are dropped, including indented ones');
assert.deepStrictEqual(parse('/bin/sh\n\n\n/bin/bash'), ['/bin/sh', '/bin/bash'], 'blank lines are dropped');

// ── tmux is never offered as a login shell ──────────────────────────────────
// It is driven by the dedicated session manager (toolbar button).
assert.deepStrictEqual(
    parse('/bin/sh\n/usr/bin/tmux\n/bin/bash'),
    ['/bin/sh', '/bin/bash'],
    'tmux is excluded even when /etc/shells lists it'
);
assert.deepStrictEqual(parse('/bin/sh\n/bin/tmux'), ['/bin/sh'], 'tmux is matched on basename, at any path');
assert.deepStrictEqual(
    parse('/bin/sh\n/usr/local/bin/tmux-next'),
    ['/bin/sh', '/usr/local/bin/tmux-next'],
    'only an exact "tmux" basename is excluded, not shells merely starting with it'
);

// ── Never an empty list ─────────────────────────────────────────────────────
// this.shells[0] is read directly (js/core/output.js), so an unusable file
// must leave the caller's current list in place rather than empty it.
assert.deepStrictEqual(parse(''), DEFAULTS, 'empty file falls back');
assert.deepStrictEqual(parse(null), DEFAULTS, 'null (unreadable file) falls back');
assert.deepStrictEqual(parse(undefined), DEFAULTS, 'undefined falls back');
assert.deepStrictEqual(parse('# only comments\n\n'), DEFAULTS, 'comments-only file falls back');
assert.deepStrictEqual(parse('/usr/bin/tmux\n'), DEFAULTS, 'a tmux-only file falls back rather than leaving an empty list');

// The fallback is normalised the same way, so a caller cannot smuggle a
// duplicate (and thus a duplicate :key) in through it.
assert.deepStrictEqual(
    parse('', ['/bin/sh', '/bin/sh', '/usr/bin/tmux', '/bin/bash']),
    ['/bin/sh', '/bin/bash'],
    'the fallback is de-duplicated and tmux-filtered too'
);
assert.deepStrictEqual(parse('', []), [], 'an empty fallback is returned as-is (nothing better to offer)');

// ── Default shell selection ─────────────────────────────────────────────────
const pick = (shells, current) => S._pickDefaultShell(shells, current);

assert.strictEqual(pick(['/bin/sh', '/bin/bash'], '/bin/sh'), '/bin/sh', 'a still-available choice is kept');
assert.strictEqual(pick(['/bin/sh', '/bin/bash'], '/bin/zsh'), '/bin/bash', 'a choice the host no longer offers falls back to bash');
assert.strictEqual(pick(['/bin/sh', '/bin/bash'], ''), '/bin/bash', 'with nothing configured, bash wins');
assert.strictEqual(pick(['/bin/sh', '/bin/bash'], undefined), '/bin/bash', 'undefined is treated as nothing configured');
assert.strictEqual(pick(['/usr/bin/zsh', '/bin/sh'], ''), '/usr/bin/zsh', 'without bash, the first entry wins');
assert.strictEqual(pick(['/bin/sh', '/usr/local/bin/bash'], ''), '/usr/local/bin/bash', 'bash is matched at any path');
assert.strictEqual(pick([], ''), '', 'an empty list yields "" rather than undefined');

// End to end over the two helpers: the reported file produces a usable default.
{
    const shells = parse('# /etc/shells\n/bin/sh\n/bin/bash\n/usr/bin/zsh\n/usr/bin/zsh\n');
    assert.deepStrictEqual(shells, ['/bin/sh', '/bin/bash', '/usr/bin/zsh']);
    assert.strictEqual(pick(shells, ''), '/bin/bash');
}

console.log('shells-unit: OK');
