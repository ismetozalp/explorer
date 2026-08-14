// Regression test for preview-reap-hardening FIX 1 + FIX 2, driving the ACTUAL
// shipped reap script text (exported as ExplorerVideo._vpReapScript(), see
// js/features/videoplayer.js) through /bin/sh against a real temp dir tree —
// no browser, no cockpit, no mocked shell semantics.
//
//   FIX 1 (heartbeat): ffmpeg exits once conversion finishes, but hls.js keeps
//   reading segments off disk for the rest of playback, so "no ffmpeg found"
//   no longer means "safe to delete". A live *player* proves itself instead
//   via a periodically-touched <dir>/.alive marker; the reap must treat a
//   FRESH marker as "still in use" and a STALE one as reapable again.
//
//   FIX 2 (fail inert, not destructive): the old script was
//   `pgrep -f "$d" >/dev/null 2>&1 || rm -rf "$d"` — exit 1 (no match) and
//   exit 127 (pgrep missing) are indistinguishable, so a host without procps
//   would delete EVERY session dir, including ones in active use. The script
//   must now bail out entirely (delete nothing) when pgrep isn't on PATH.
//
//   Fix-round-1: the liveness check itself, `[ -n "$(find "$d/.alive"
//   -mmin -2 2>/dev/null)" ]`, has the identical failure mode — if `find` is
//   missing (or fails for any other reason, hidden by 2>/dev/null), the
//   command substitution is empty, the check is false, and a dir with a
//   FRESH marker falls through to `rm -rf`. `find` now gets the same
//   up-front `command -v` bail as `pgrep`.
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../js/features/videoplayer.js', import.meta.url), 'utf8'), sandbox);
const V = sandbox.window.ExplorerVideo;
const script = V._vpReapScript();
assert.strictEqual(typeof script, 'string');
assert.ok(script.includes('pgrep'), 'sanity: this is the real reap script, not an empty stub');

function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-reap-')); }
function mkDir(root, name) { const d = path.join(root, name); fs.mkdirSync(d); return d; }
function touchStale(file, minutesAgo) {
    fs.writeFileSync(file, '');
    const t = new Date(Date.now() - minutesAgo * 60 * 1000);
    fs.utimesSync(file, t, t);
}
function runReap(root, env) {
    execFileSync('/bin/sh', ['-c', script, 'sh', root], { env: env || process.env });
}
// Build a PATH resolving every named binary EXCEPT `exclude`, via symlinks to
// the real ones (found through a clean `sh -c 'command -v'`, unaffected by
// whatever wrapper functions the host shell may have for these names).
// Returns { dir, cleanup() }.
function pathWithout(names, exclude) {
    const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-reap-bin-'));
    for (const bin of names) {
        if (bin === exclude) continue;
        const real = execFileSync('/bin/sh', ['-c', 'command -v ' + bin]).toString().trim();
        fs.symlinkSync(real, path.join(tmpBin, bin));
    }
    return { dir: tmpBin, cleanup: () => fs.rmSync(tmpBin, { recursive: true, force: true }) };
}

const cleanupRoots = [];

try {
    // (a) a dir with a FRESH .alive survives — this is the whole point of the
    //     heartbeat: no ffmpeg is running for it (nothing pgrep would match),
    //     yet it must not be reaped because a fresh marker proves a live
    //     player is still reading its segments.
    {
        const root = mkRoot(); cleanupRoots.push(root);
        const d = mkDir(root, 'fresh-session');
        fs.writeFileSync(path.join(d, '.alive'), '');   // just touched, like the heartbeat does
        runReap(root);
        assert.ok(fs.existsSync(d), 'a dir with a FRESH .alive must survive the reap');
        console.log('OK (a): fresh .alive survives');
    }

    // (b) a dir with a STALE .alive (older than the ~2min window) is deleted.
    {
        const root = mkRoot(); cleanupRoots.push(root);
        const d = mkDir(root, 'stale-session');
        touchStale(path.join(d, '.alive'), 10);   // last touched 10 minutes ago — the tab is gone
        runReap(root);
        assert.ok(!fs.existsSync(d), 'a dir with a STALE .alive must be deleted');
        console.log('OK (b): stale .alive is reaped');
    }

    // (c) a dir with no .alive and no matching process is deleted (the
    //     ordinary "leftover from a crashed session" case).
    {
        const root = mkRoot(); cleanupRoots.push(root);
        const d = mkDir(root, 'orphan-session');
        runReap(root);
        assert.ok(!fs.existsSync(d), 'a dir with no .alive and no process must be deleted');
        console.log('OK (c): orphan with no marker and no process is reaped');
    }

    // (d) pgrep unavailable: NOTHING is deleted, not even genuine orphans —
    //     fail inert, not destructive. Build a PATH with find/rm/touch but
    //     deliberately no pgrep.
    {
        const root = mkRoot(); cleanupRoots.push(root);
        const orphan = mkDir(root, 'orphan');
        const stale = mkDir(root, 'stale');
        touchStale(path.join(stale, '.alive'), 10);
        const fresh = mkDir(root, 'fresh');
        fs.writeFileSync(path.join(fresh, '.alive'), '');

        const bin = pathWithout(['find', 'rm', 'touch'], 'pgrep');   // pgrep never symlinked in — not in the `names` list
        try {
            runReap(root, { PATH: bin.dir });
        } finally {
            bin.cleanup();
        }
        assert.ok(fs.existsSync(orphan), 'no pgrep on PATH must leave even a genuine orphan alone (fail inert)');
        assert.ok(fs.existsSync(stale), 'no pgrep on PATH must leave a stale-marker dir alone too');
        assert.ok(fs.existsSync(fresh), 'no pgrep on PATH must leave a fresh-marker dir alone');
        console.log('OK (d): pgrep unavailable -> reap deletes nothing (fail inert, not destructive)');
    }

    // (e) find unavailable: NOTHING is deleted either — fix-round-1 regression
    //     guard. Before this fix, a PATH with pgrep+rm but no find made the
    //     `[ -n "$(find ... )" ]` liveness check silently empty/false, so a
    //     dir with a FRESH .alive (nothing pgrep would match, since ffmpeg has
    //     already exited) fell straight through to rm -rf — the exact
    //     scenario the heartbeat exists to prevent.
    {
        const root = mkRoot(); cleanupRoots.push(root);
        const orphan = mkDir(root, 'orphan');
        const stale = mkDir(root, 'stale');
        touchStale(path.join(stale, '.alive'), 10);
        const fresh = mkDir(root, 'fresh');
        fs.writeFileSync(path.join(fresh, '.alive'), '');   // fresh marker, no matching process — this is the one `find`-missing used to kill

        const bin = pathWithout(['pgrep', 'rm', 'touch'], 'find');   // find deliberately absent
        try {
            runReap(root, { PATH: bin.dir });
        } finally {
            bin.cleanup();
        }
        assert.ok(fs.existsSync(fresh), 'no find on PATH must leave a dir with a FRESH .alive alone — this is the exact fix-round-1 regression');
        assert.ok(fs.existsSync(stale), 'no find on PATH must leave a stale-marker dir alone too (fail inert, not "guess and delete")');
        assert.ok(fs.existsSync(orphan), 'no find on PATH must leave a genuine orphan alone as well');
        console.log('OK (e): find unavailable -> reap deletes nothing, including a dir with a FRESH .alive (fail inert)');
    }

    console.log('preview-reap-unit: OK');
} finally {
    for (const root of cleanupRoots) fs.rmSync(root, { recursive: true, force: true });
}
