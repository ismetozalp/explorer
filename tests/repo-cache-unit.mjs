import assert from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';

// Load js/features/github.js into a sandbox that provides the `window` it
// assigns to, then pull out the mixin object so we can call its methods
// against a stub `this`.
const src = fs.readFileSync(new URL('../js/features/github.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const Github = sandbox.window.ExplorerGithub;

// Stub `this` providing repoCheckouts() the way app.js's repoCache model
// does: ownerRepo -> [{ path, title }, ...].
function stub(repoCache) {
    return {
        repoCache,
        repoCheckouts: Github.repoCheckouts,
    };
}

const ROOT = '/home/ismet/cockpit_projects/explorer';
const OWNER_REPO = 'ismetozalp/explorer';
const ctx = stub({ [OWNER_REPO]: [{ path: ROOT, title: 'explorer' }] });

// Exact root match.
assert.strictEqual(Github.pathInCachedRepo.call(ctx, OWNER_REPO, ROOT), true,
    'exact registered root should be cached');

// Nested subfolders (the reported bug: browsing into tests/ under a
// registered repo root must still read as "cached").
assert.strictEqual(Github.pathInCachedRepo.call(ctx, OWNER_REPO, ROOT + '/tests'), true,
    'a subfolder of the registered root should be cached');
assert.strictEqual(Github.pathInCachedRepo.call(ctx, OWNER_REPO, ROOT + '/a/b/c'), true,
    'a deeply nested subfolder should be cached');

// Sibling directory that merely shares ROOT as a string prefix — must NOT
// match. This is the important edge: without the `+ '/'` guard,
// '/home/.../explorer-other'.startsWith('/home/.../explorer') is true.
assert.strictEqual(Github.pathInCachedRepo.call(ctx, OWNER_REPO, ROOT + '-other'), false,
    'a sibling dir sharing only a string prefix must not be treated as cached');

// Unrelated path.
assert.strictEqual(Github.pathInCachedRepo.call(ctx, OWNER_REPO, '/home/ismet/Documents'), false,
    'an unrelated path must not be treated as cached');

// Unregistered owner (no entry in repoCache at all).
assert.strictEqual(Github.pathInCachedRepo.call(ctx, 'someone/else', ROOT), false,
    'an owner/repo with no registered checkout must not be treated as cached');

// Missing args.
assert.strictEqual(Github.pathInCachedRepo.call(ctx, '', ROOT), false, 'empty ownerRepo must be false');
assert.strictEqual(Github.pathInCachedRepo.call(ctx, OWNER_REPO, ''), false, 'empty path must be false');

// Mutation guard: if the `+ '/'` boundary check were dropped (bare
// `path.startsWith(e.path)`), the sibling-prefix case above would wrongly
// return true. Verify that regression directly against a hand-rolled
// "broken" version, so a future edit that removes the guard is caught even
// if someone only reads this test file (not just the source).
function brokenPathInCachedRepo(ownerRepo, path) {
    if (!ownerRepo || !path) return false;
    return Github.repoCheckouts.call(ctx, ownerRepo).some(e =>
        e.path && (path === e.path || path.startsWith(e.path))); // missing '/' guard
}
assert.strictEqual(brokenPathInCachedRepo(OWNER_REPO, ROOT + '-other'), true,
    'sanity: the broken (no-slash-guard) version DOES wrongly match the sibling — proves the test is meaningful');

console.log('repo-cache-unit: OK');
