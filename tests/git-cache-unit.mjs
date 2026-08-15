// Unit tests for the git-bar cache pre-fill (v3.1.8): cachedRepoForPath() —
// a pure, synchronous lookup used to render the git bar optimistically
// before GIT.status() resolves — and _updateCachedBranch() — the "write the
// observed branch back to the cache, only if it changed" helper that keeps
// the pre-fill fresh without thrashing repos.json.
//
// Run: node tests/git-cache-unit.mjs
import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/features/github.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const Github = sandbox.window.ExplorerGithub;

// Stub `this` the way app.js's repoCache model does: ownerRepo -> [{ path,
// title, branch? }, ...]. repoCheckouts/_saveRepoCache come straight from
// the module (or a spy, for the save-tracking tests) so behaviour matches
// production, not a hand-rolled re-implementation.
function stub(repoCache, opts) {
    opts = opts || {};
    const saves = [];
    return {
        repoCache,
        repoCheckouts: Github.repoCheckouts,
        _saveRepoCache: async function () { saves.push(JSON.parse(JSON.stringify(this.repoCache))); },
        _saves: saves,
    };
}

const ROOT = '/home/ismet/cockpit_projects/explorer';
const OWNER_REPO = 'ismetozalp/explorer';

// Field-by-field comparison, not assert.deepStrictEqual: cachedRepoForPath is
// defined inside a vm.runInNewContext sandbox, a SEPARATE realm with its own
// Object.prototype — deepStrictEqual treats that as a mismatch even when
// every field matches, since it compares prototypes too.
function assertHit(hit, ownerRepo, root, branch, msg) {
    assert.ok(hit, msg + ' (expected a hit, got null)');
    assert.strictEqual(hit.ownerRepo, ownerRepo, msg + ' (ownerRepo)');
    assert.strictEqual(hit.root, root, msg + ' (root)');
    assert.strictEqual(hit.branch, branch, msg + ' (branch)');
}

// ─── cachedRepoForPath ──────────────────────────────────────────────────────
{
    const ctx = stub({ [OWNER_REPO]: [{ path: ROOT, title: 'explorer', branch: 'main' }] });

    // Exact root.
    assertHit(Github.cachedRepoForPath.call(ctx, ROOT), OWNER_REPO, ROOT, 'main', 'exact root should hit with its branch');

    // Nested subfolder.
    assertHit(Github.cachedRepoForPath.call(ctx, ROOT + '/tests'), OWNER_REPO, ROOT, 'main', 'a subfolder should hit the same root entry');
    assertHit(Github.cachedRepoForPath.call(ctx, ROOT + '/a/b/c'), OWNER_REPO, ROOT, 'main', 'a deeply nested subfolder should hit');

    // Sibling-prefix guard (the exact regression pathInCachedRepo already
    // guards against — cachedRepoForPath must have the same '+ "/"' boundary).
    assert.strictEqual(Github.cachedRepoForPath.call(ctx, ROOT + '-other'), null,
        'a sibling dir sharing only a string prefix must not match');

    // Unrelated path / empty cache / missing arg.
    assert.strictEqual(Github.cachedRepoForPath.call(ctx, '/home/ismet/Documents'), null, 'unrelated path must be null');
    assert.strictEqual(Github.cachedRepoForPath.call(stub({}), ROOT), null, 'empty cache must be null');
    assert.strictEqual(Github.cachedRepoForPath.call(ctx, ''), null, 'empty path must be null');
    assert.strictEqual(Github.cachedRepoForPath.call(ctx, null), null, 'null path must be null');

    console.log('OK cachedRepoForPath: exact root, nested subfolder, sibling-prefix guard, empty/unrelated all correct');
}

// branch passes through / is null when absent (back-compat: old cache
// entries written before this feature have no `branch` field).
{
    const ctx = stub({ [OWNER_REPO]: [{ path: ROOT, title: 'explorer' }] }); // no branch
    const hit = Github.cachedRepoForPath.call(ctx, ROOT);
    assert.strictEqual(hit.branch, null, 'branch must be null (not undefined/throw) when the cache entry predates this feature');
    assert.strictEqual(hit.ownerRepo, OWNER_REPO);
    assert.strictEqual(hit.root, ROOT);
    console.log('OK cachedRepoForPath: back-compat — missing branch on an old-format entry comes through as null, not a crash');
}

// Mutation guard: without the '+ "/"' boundary, the sibling-prefix path
// would wrongly match. Prove the test is meaningful by checking a
// hand-rolled "broken" version actually DOES match (same technique as
// repo-cache-unit.mjs's pathInCachedRepo guard).
{
    const ctx = stub({ [OWNER_REPO]: [{ path: ROOT, title: 'explorer' }] });
    function brokenCachedRepoForPath(path) {
        for (const [ownerRepo, list] of Object.entries(ctx.repoCache || {})) {
            for (const e of list) {
                if (e && e.path && (path === e.path || path.startsWith(e.path))) // missing '/' guard
                    return { ownerRepo, root: e.path, branch: e.branch || null };
            }
        }
        return null;
    }
    assert.notStrictEqual(brokenCachedRepoForPath(ROOT + '-other'), null,
        'sanity: the broken (no-slash-guard) version DOES wrongly match the sibling — proves the guard test is meaningful');
    console.log('OK mutation guard: trailing-slash boundary is load-bearing (broken version wrongly matches the sibling)');
}

// ─── _updateCachedBranch ────────────────────────────────────────────────────
// Targets the ROOT entry, not the subfolder path it was actually resolved
// against (mirrors how GIT.status(pane.path) is called on a subfolder, but
// the branch belongs on the repo-root cache entry).
{
    const ctx = stub({ [OWNER_REPO]: [{ path: ROOT, title: 'explorer', branch: 'main' }] });
    await Github._updateCachedBranch.call(ctx, OWNER_REPO, ROOT + '/tests', 'feature-x');
    assert.strictEqual(ctx.repoCache[OWNER_REPO][0].path, ROOT, 'the entry that got the branch write must still be the ROOT path');
    assert.strictEqual(ctx.repoCache[OWNER_REPO][0].branch, 'feature-x', 'branch must be updated on the root entry');
    assert.strictEqual(ctx._saves.length, 1, 'a real branch change must persist exactly once');
    console.log('OK _updateCachedBranch: writes to the ROOT entry when called with a subfolder path, and saves');
}

// No-op (and no save) when the branch is unchanged — the "don't thrash
// repos.json on every poll" guard.
{
    const ctx = stub({ [OWNER_REPO]: [{ path: ROOT, title: 'explorer', branch: 'main' }] });
    await Github._updateCachedBranch.call(ctx, OWNER_REPO, ROOT, 'main'); // same branch as already cached
    assert.strictEqual(ctx.repoCache[OWNER_REPO][0].branch, 'main', 'branch must remain unchanged');
    assert.strictEqual(ctx._saves.length, 0, 'an unchanged branch must NOT trigger a save — this is the anti-thrash guard');
    console.log('OK _updateCachedBranch: unchanged branch is a true no-op — zero saves (anti-thrash guard holds)');
}

// No-op when there's no matching cached entry for that ownerRepo/path at all
// (path outside any registered checkout, or ownerRepo not registered).
{
    const ctx = stub({ [OWNER_REPO]: [{ path: ROOT, title: 'explorer', branch: 'main' }] });
    await Github._updateCachedBranch.call(ctx, OWNER_REPO, '/some/other/place', 'feature-x');
    assert.strictEqual(ctx.repoCache[OWNER_REPO][0].branch, 'main', 'unrelated path must not touch the cached entry');
    assert.strictEqual(ctx._saves.length, 0, 'no matching entry must NOT save');

    await Github._updateCachedBranch.call(ctx, 'someone/else', ROOT, 'feature-x');
    assert.strictEqual(ctx._saves.length, 0, 'an unregistered ownerRepo must NOT save');
    console.log('OK _updateCachedBranch: no matching cached entry (wrong path or unregistered owner) is a no-op');
}

// Missing args (no ownerRepo, no branch) must be a no-op, not a throw.
{
    const ctx = stub({ [OWNER_REPO]: [{ path: ROOT, title: 'explorer', branch: 'main' }] });
    await Github._updateCachedBranch.call(ctx, null, ROOT, 'feature-x');
    await Github._updateCachedBranch.call(ctx, OWNER_REPO, ROOT, null);
    await Github._updateCachedBranch.call(ctx, OWNER_REPO, ROOT, '');
    assert.strictEqual(ctx._saves.length, 0, 'missing ownerRepo/branch must not save');
    console.log('OK _updateCachedBranch: missing ownerRepo or branch is a no-op, no throw');
}

// Mutation guard: without the "only if changed" comparison, an unchanged
// branch would still overwrite + save every time (thrashing repos.json on
// every navigate/poll tick).
{
    const ctx = stub({ [OWNER_REPO]: [{ path: ROOT, title: 'explorer', branch: 'main' }] });
    async function brokenUpdateCachedBranch(ownerRepo, path, branch) {
        if (!ownerRepo || !branch) return;
        const list = ctx.repoCheckouts.call(ctx, ownerRepo);
        const entry = list.find(e => e.path && (path === e.path || path.startsWith(e.path + '/')));
        if (!entry) return; // missing the "entry.branch === branch" no-op check
        entry.branch = branch;
        ctx.repoCache[ownerRepo] = list;
        await ctx._saveRepoCache();
    }
    await brokenUpdateCachedBranch(OWNER_REPO, ROOT, 'main'); // same branch as already cached
    assert.strictEqual(ctx._saves.length, 1,
        'sanity: the broken (no "only if changed") version DOES save on every call — proves the anti-thrash test is meaningful');
    console.log('OK mutation guard: "only save when changed" comparison is load-bearing (broken version thrashes repos.json)');
}

// ─── _rearmGitPrefill (v3.1.9) ──────────────────────────────────────────────
// Belt-and-suspenders companion to the init()-time `await
// this._loadRepoCache()`: re-runs the REAL _prefillGitFromCache for every
// currently-open dir pane (both panes in dual mode), so a folder opened
// before the cache resolved gets the instant bar retroactively.
{
    const dirA = { kind: 'dir', path: ROOT, gitInfo: null };
    const dirB_paneB = { kind: 'dir', path: ROOT + '/tests', gitInfo: null };
    const dualTab = { kind: 'dir', path: ROOT, gitInfo: null, dual: true, paneB: dirB_paneB };
    const terminalTab = { kind: 'terminal', path: '/tmp', gitInfo: null };
    const ctx = {
        repoCache: { [OWNER_REPO]: [{ path: ROOT, title: 'explorer', branch: 'main' }] },
        repoCheckouts: Github.repoCheckouts,
        cachedRepoForPath: Github.cachedRepoForPath,
        _prefillGitFromCache: Github._prefillGitFromCache,
        tabs: [dirA, dualTab, terminalTab],
    };
    Github._rearmGitPrefill.call(ctx);

    assert.ok(dirA.gitInfo && dirA.gitInfo._optimistic, 'pane A (a plain dir tab) must get pre-filled');
    assert.strictEqual(dirA.gitInfo.remote.ownerRepo, OWNER_REPO);
    assert.ok(dualTab.gitInfo && dualTab.gitInfo._optimistic, 'the dual tab\'s own pane A must ALSO get pre-filled');
    assert.ok(dirB_paneB.gitInfo && dirB_paneB.gitInfo._optimistic, 'dual-mode pane B must get pre-filled too, not just pane A');
    assert.strictEqual(dirB_paneB.gitInfo.remote.ownerRepo, OWNER_REPO);
    assert.strictEqual(terminalTab.gitInfo, null, 'a non-dir (terminal) tab must be left alone — no gitInfo concept there');
    console.log('OK _rearmGitPrefill: pre-fills every dir pane, INCLUDING dual-mode pane B, skips non-dir tabs');
}

// Respects the existing no-clobber guard: an already-resolved, non-optimistic
// status for the pane's repo must not be reset back to the placeholder.
{
    const realInfo = { branch: 'main', dirty: true, dirtyCount: 4, ahead: 1, behind: 0, remoteBranch: 'origin/main', remote: { ownerRepo: OWNER_REPO }, statusLines: ['x'] };
    const dirA = { kind: 'dir', path: ROOT, gitInfo: realInfo };
    const ctx = {
        repoCache: { [OWNER_REPO]: [{ path: ROOT, title: 'explorer', branch: 'main' }] },
        repoCheckouts: Github.repoCheckouts,
        cachedRepoForPath: Github.cachedRepoForPath,
        _prefillGitFromCache: Github._prefillGitFromCache,
        tabs: [dirA],
    };
    Github._rearmGitPrefill.call(ctx);
    assert.strictEqual(dirA.gitInfo, realInfo, 'an already-resolved real status must NOT be clobbered back to the optimistic placeholder');
    assert.strictEqual(dirA.gitInfo.dirtyCount, 4, 'real dirtyCount must survive re-arm untouched');
    console.log('OK _rearmGitPrefill: does not clobber an already-resolved, non-optimistic status (reuses _prefillGitFromCache\'s own guard)');
}

// Safe with zero tabs.
{
    const ctx = { repoCache: {}, repoCheckouts: Github.repoCheckouts, cachedRepoForPath: Github.cachedRepoForPath, _prefillGitFromCache: Github._prefillGitFromCache, tabs: [] };
    assert.doesNotThrow(() => Github._rearmGitPrefill.call(ctx), 'must be a no-op, not a throw, with zero tabs');
    console.log('OK _rearmGitPrefill: safe no-op with zero tabs');
}

console.log('git-cache-unit: OK');
