// Unit tests for the git-bar reconcile race guard (v3.1.8 fix round 1).
//
// Bug: navigate() now fires an authoritative _refreshTabGit(pane) reconcile
// in the background (unawaited) on every path change. isWorkTree()/status()
// are each a real subprocess round trip — slow enough that a SECOND, faster
// navigation can complete and start its OWN reconcile before the first one
// resolves. _refreshTabGit used to assign `pane.gitInfo` unconditionally at
// every await point, so the slower, now-stale check for the OLD path could
// clobber the pane with the WRONG repo's status — showing repo A's bar while
// the user is looking at non-repo (or different-repo) B, sometimes for as
// long as the 8s poll.
//
// Fix: pin `pane.path` at entry and re-check it immediately before every
// assignment to gitInfo/gitChecked; bail without touching either if the pane
// has moved on to a different path.
//
// This exercises the REAL js/app.js source (loaded into a vm sandbox that
// mimics the browser globals it expects: `document`, `Alpine`, and a stubbed
// `GIT`), not a hand-reimplementation, so a regression in the actual
// _refreshTabGit has to break these tests.
//
// Run: node tests/git-refresh-race-unit.mjs
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

// Load js/runtime.js (ExRT — app.js's `settings` state initializer reads
// ExRT.const.DEFAULT_SETTINGS), js/features/github.js (real source —
// provides _updateCachedBranch, which _refreshTabGit calls on a successful
// status), and js/app.js (real source — provides _refreshTabGit itself)
// into ONE sandbox, the way index.html loads them as sequential <script>
// tags before Alpine wires them together via `...window.ExplorerGithub`
// inside Alpine.data(...).
function loadApp(gitStub) {
    const sandbox = {
        window: {},
        console,
        structuredClone, // Node global; not auto-present inside a vm context
        // app.js's top level is `document.addEventListener('alpine:init', cb)`
        // — invoke the callback immediately, synchronously, the way the real
        // 'alpine:init' event does once Alpine boots.
        document: { addEventListener: (ev, cb) => { if (ev === 'alpine:init') cb(); } },
        // Alpine.data('explorer', factory) — capture the factory so the test
        // can call it (once per test, for a fresh component instance).
        Alpine: { data: (name, factory) => { sandbox._factory = factory; } },
        // GIT is referenced as a bare global in both app.js and github.js
        // (`window.GIT = (function(){...})()` in the real app) — a plain
        // sandbox property is enough since vm.createContext makes `sandbox`
        // itself the global object bare identifiers resolve against.
        GIT: gitStub,
    };
    vm.createContext(sandbox);
    for (const rel of ['../js/runtime.js', '../js/features/github.js', '../js/app.js']) {
        const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
        vm.runInContext(src, sandbox);
        // In a real browser `window` IS the global object, so `window.ExRT =`
        // also creates a bare global `ExRT` automatically — app.js's state
        // initializer reads it as a bare identifier. Our sandboxed `window`
        // is just a plain nested object, so mirror the same alias by hand.
        if (sandbox.window.ExRT && !sandbox.ExRT) sandbox.ExRT = sandbox.window.ExRT;
    }
    const app = sandbox._factory();      // fresh component instance (own repoCache etc.)
    app._saveRepoCache = async () => {}; // no real disk I/O in this test
    return app;
}

// A controllable, deferred promise — lets the test decide exactly when
// isWorkTree()/status() "complete", so the race can be reproduced
// deterministically instead of depending on real timing.
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function buildPane(path) {
    return { kind: 'dir', path, gitInfo: null, gitChecked: false };
}

// ─── The race: status(A) resolves AFTER the pane has moved to B ────────────
{
    const dA = deferred(); // GIT.status(A)
    const app = loadApp({
        isWorkTree: async (p) => true, // both A and B "are" work-trees for this test
        status: async (p) => (p === '/repo/A' ? dA.promise : { branch: 'b-branch', dirty: false, dirtyCount: 0, ahead: 0, behind: 0, remoteBranch: null, remote: { ownerRepo: 'x/b' }, statusLines: [] }),
    });

    const pane = buildPane('/repo/A');
    const p1 = app._refreshTabGit(pane); // kicks off isWorkTree(A) -> status(A) (blocked on dA)

    // Real navigation: the pane moves on to B BEFORE A's status resolves —
    // exactly the sequence navigate() -> _refreshTabGit(tab) -> (still
    // in-flight) -> navigate() again produces.
    pane.path = '/repo/B';
    pane.gitInfo = { branch: 'b-real', dirty: false, dirtyCount: 0, ahead: 0, behind: 0, remoteBranch: null, remote: { ownerRepo: 'x/b' }, statusLines: [] };
    pane.gitChecked = true;

    // NOW let A's slow status() resolve — after B has already been set.
    dA.resolve({ branch: 'a-branch', dirty: true, dirtyCount: 3, ahead: 0, behind: 0, remoteBranch: null, remote: { ownerRepo: 'x/a' }, statusLines: ['x'] });
    await p1;

    assert.strictEqual(pane.path, '/repo/B', 'sanity: pane really is on B by the time the A-check finishes');
    assert.ok(pane.gitInfo, 'gitInfo must not have been cleared');
    assert.strictEqual(pane.gitInfo.remote.ownerRepo, 'x/b', 'REGRESSION: the stale A-check clobbered gitInfo with repo A while the pane is showing repo B');
    assert.strictEqual(pane.gitInfo.branch, 'b-real', 'gitInfo must still be B\'s real status, untouched by the late A resolution');
    console.log('OK race guard (success path): a slow status(A) resolving after navigation to B does NOT clobber B\'s gitInfo with A\'s result');
}

// ─── Same race, but the stale check is the one that would CLEAR gitInfo
// (isWorkTree(A) resolves false — "not a repo" — after the pane moved to B,
// which IS a repo). The null-clear must be guarded exactly like the
// success-path assignment. ───────────────────────────────────────────────
{
    const wtA = deferred(); // GIT.isWorkTree(A)
    const app = loadApp({
        isWorkTree: async (p) => (p === '/repo/A' ? wtA.promise : true),
        status: async (p) => ({ branch: 'b-real', dirty: false, dirtyCount: 0, ahead: 0, behind: 0, remoteBranch: null, remote: { ownerRepo: 'x/b' }, statusLines: [] }),
    });

    const pane = buildPane('/repo/A');
    const p1 = app._refreshTabGit(pane); // blocked on wtA

    pane.path = '/repo/B';
    pane.gitInfo = { branch: 'b-real', dirty: false, dirtyCount: 0, ahead: 0, behind: 0, remoteBranch: null, remote: { ownerRepo: 'x/b' }, statusLines: [] };
    pane.gitChecked = true;

    wtA.resolve(false); // A "turns out" not to be a work-tree, resolved late
    await p1;

    assert.ok(pane.gitInfo, 'REGRESSION: the stale (late, now-irrelevant) isWorkTree(A)=false result cleared gitInfo for pane B, which IS a repo');
    assert.strictEqual(pane.gitInfo.remote.ownerRepo, 'x/b', 'gitInfo must still be B\'s');
    console.log('OK race guard (null-clear path): a late isWorkTree(A)=false does NOT null out B\'s already-set gitInfo');
}

// ─── Mutation guard: prove the guard is load-bearing by re-running the
// FIRST race scenario against a hand-rolled "broken" version with the
// path-pin checks removed (the pre-fix shape) — it must reproduce exactly
// the clobber the fix prevents, so the guard test above is not vacuous. ───
{
    async function brokenRefreshTabGit(pane, GITStub) {
        if (!pane || pane.kind !== 'dir') return;
        try {
            if (await GITStub.isWorkTree(pane.path)) {
                const info = await GITStub.status(pane.path);
                pane.gitInfo = info; // no path re-check — the bug
            } else {
                pane.gitInfo = null;
            }
        } catch (e) { pane.gitInfo = null; }
        pane.gitChecked = true;
    }
    const dA = deferred();
    const gitStub = {
        isWorkTree: async () => true,
        status: async (p) => (p === '/repo/A' ? dA.promise : { branch: 'b-real', remote: { ownerRepo: 'x/b' } }),
    };
    const pane = buildPane('/repo/A');
    const p1 = brokenRefreshTabGit(pane, gitStub);
    // Timing matters here: `GITStub.status(pane.path)` is a plain expression
    // evaluated ONCE, at the moment that line runs — a later mutation to
    // `pane.path` can't retroactively change what argument an already-issued
    // call was made with. So to reproduce the real bug (reviewer's
    // timeline: isWorkTree(A) resolves, status(A) is issued WHILE the pane
    // is still on A, and ONLY THEN does the user navigate to B while
    // status(A) is still in flight) the mutation has to land AFTER
    // brokenRefreshTabGit has already reached and invoked the status() call
    // — not before. Drain enough microtask ticks for it to get there.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    pane.path = '/repo/B';
    pane.gitInfo = { branch: 'b-real', remote: { ownerRepo: 'x/b' } };
    dA.resolve({ branch: 'a-branch', remote: { ownerRepo: 'x/a' } });
    await p1;
    assert.strictEqual(pane.gitInfo.remote.ownerRepo, 'x/a',
        'sanity: the broken (no path-pin) version DOES clobber B with A\'s stale result — proves the race-guard test is meaningful');
    console.log('OK mutation guard: the path-pin re-check is load-bearing (broken version reproduces the exact "wrong repo\'s bar" clobber)');
}

// ─── Reconcile-to-null is not itself broken by the guard: a NORMAL (no
// race) check that finds the repo gone must still clear gitInfo — i.e. the
// guard only suppresses STALE writes, it doesn't suppress legitimate ones.
// This is also the "self-corrects a stale cached repo" behaviour itself:
// mutation-test by removing the null-clear entirely and confirming it fails. ─
{
    const app = loadApp({
        isWorkTree: async () => false, // repo is gone
        status: async () => { throw new Error('should not be called'); },
    });
    const pane = buildPane('/repo/gone');
    pane.gitInfo = { branch: 'stale-optimistic', _optimistic: true, remote: { ownerRepo: 'x/gone' } };
    await app._refreshTabGit(pane);
    assert.strictEqual(pane.gitInfo, null, 'a real (non-stale) check finding the repo gone must clear gitInfo to null');
    assert.strictEqual(pane.gitChecked, true, 'gitChecked must still be set true for a real, non-superseded check');
    console.log('OK reconcile-to-null: an ordinary (non-raced) check on a gone repo clears the optimistic bar');

    // Mutation: a version that "forgot" the null-clear (left the optimistic
    // value in place instead of assigning null when isWorkTree is false)
    // must fail the same assertion — prove it directly, so the assertion
    // above isn't vacuously true.
    async function brokenNoClear(pane, GITStub) {
        if (await GITStub.isWorkTree(pane.path)) {
            pane.gitInfo = await GITStub.status(pane.path);
        } // else: forgot `pane.gitInfo = null` — the bug
        pane.gitChecked = true;
    }
    const paneBroken = buildPane('/repo/gone');
    paneBroken.gitInfo = { branch: 'stale-optimistic', _optimistic: true, remote: { ownerRepo: 'x/gone' } };
    await brokenNoClear(paneBroken, { isWorkTree: async () => false, status: async () => { throw new Error('should not be called'); } });
    assert.notStrictEqual(paneBroken.gitInfo, null,
        'sanity: the broken (missing null-clear) version leaves the stale optimistic bar in place — proves this test is meaningful');
    console.log('OK mutation guard: the null-clear-on-gone-repo assertion is load-bearing (a version that skips it leaves a false bar)');
}

console.log('git-refresh-race-unit: OK');
