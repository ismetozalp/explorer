// e2e for the optimistic git-bar pre-fill (v3.1.8).
//
// The problem: entering a directory inside a git repo used to show NO git
// bar at all until the throttled 8s poll (or a tab switch) eventually ran
// GIT.status() — several sequential git subprocesses over the Cockpit
// channel. Fix: for a path inside an already-registered repo cache entry,
// render the bar SYNCHRONOUSLY from the cache (owner/repo + last-known
// branch) the instant the pane's path changes (_prefillGitFromCache, called
// from _loadDir), while the real GIT.status() round trip — kicked off
// unawaited from navigate() — reconciles moments later and self-corrects a
// stale cache entry (moved/deleted repo) by clearing gitInfo outright.
//
// This plugin serves the working tree via the ~/.local/share/cockpit/explorer
// symlink, so the repo under test IS this checkout
// (/home/ismet/cockpit_projects/explorer, remote ismetozalp/explorer) — no
// fixture repo needs to be created for the "happy path" half of this test.
// The "stale cache" half creates and then deletes a throwaway repo.
//
// Registering/updating the cache writes to
// ~/.config/cockpit/explorer/repos.json and touches
// ~/.config/cockpit/explorer/tabs.yml (tab-persistence debounce writes the
// navigated path). Both are snapshotted at the start and restored
// byte-identical at the end.
//
// Run:  COCKPIT_USER=<you> COCKPIT_PASS=<pass> node tests/git-cache-e2e.mjs
import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const URL  = process.env.COCKPIT_URL  || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = process.env.SMOKE_SHOT   || '/tmp/git-cache-e2e.png';

const REPO_ROOT = process.cwd(); // this checkout — plugin serves it via the symlink
const SUBDIR = path.join(REPO_ROOT, 'tests');
const OWNER_REPO = 'ismetozalp/explorer';

const REPOS_JSON = path.join(os.homedir(), '.config', 'cockpit', 'explorer', 'repos.json');
const TABS_YML = path.join(os.homedir(), '.config', 'cockpit', 'explorer', 'tabs.yml');

// A throwaway git repo used ONLY for the stale-cache half of the test —
// created fresh, registered, then its .git (and the dir) deleted so the
// cache still points at a path that is no longer a work-tree at all.
const STALE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'git-cache-e2e-stale-'));

const BENIGN = /\b401\b|handshake failed/i;
const errors = [];

class TestFailure extends Error {}
function fail(msg) { throw new TestFailure(msg); }

function sha256(p) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
    catch (e) { return null; }
}
function snapshot(p) {
    try { return fs.readFileSync(p); } catch (e) { return null; }
}
function restore(p, content) {
    if (content === null) { try { fs.unlinkSync(p); } catch (e) {} }
    else { fs.writeFileSync(p, content); }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e.message || e) }));
page.on('console', m => { if (m.type() === 'error' && !BENIGN.test(m.text())) errors.push({ kind: 'console', text: m.text() }); });

let app = null;

const repoJsonBefore = snapshot(REPOS_JSON);
const tabsYmlBefore = snapshot(TABS_YML);
const repoJsonBeforeSum = sha256(REPOS_JSON);
const tabsYmlBeforeSum = sha256(TABS_YML);

async function restoreTabState() {
    if (!app) return;
    try {
        await app.evaluate(async () => {
            const a = window.Alpine.$data(document.body);
            if (a.activeWinId) a.closeActiveWindow();
            await a.navigate(a.currentPane(), a.homePath);
        });
        await page.waitForTimeout(600); // outlast the 400ms persistTabs debounce
    } catch (e) {}
}

try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#login-user-input, #content', { timeout: 15000 });
    if (await page.$('#login-user-input')) {
        await page.fill('#login-user-input', USER);
        await page.fill('#login-password-input', PASS);
        await page.click('#login-button');
        await page.waitForSelector('#content, iframe', { timeout: 20000 });
    }

    for (const u of [`${URL}/explorer`, `${URL}/explorer/index`]) {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        const fr = await page.waitForSelector('iframe[src*="explorer"], iframe[name*="explorer"]', { timeout: 8000 }).catch(() => null);
        if (fr) { app = await fr.contentFrame(); if (app) break; }
    }
    if (!app) fail('no plugin frame');
    await app.locator('.toolbar').filter({ visible: true }).first().waitFor({ timeout: 20000 });

    // ── Set up: navigate to the repo root and ensure it's registered ──
    // (the optimistic pre-fill only fires for a path inside a REGISTERED
    // checkout — an unregistered repo still has to wait for the real status.)
    await app.evaluate(async (dir) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), dir);
    }, REPO_ROOT);

    const repoStrip = app.locator('.repo-strip').filter({ visible: true });
    const registerBtn = repoStrip.locator('button', { hasText: '+ Register' });
    await repoStrip.waitFor({ timeout: 10000 });
    if (await registerBtn.isVisible().catch(() => false)) {
        await registerBtn.click();
        await repoStrip.locator('.badge', { hasText: 'cached' }).waitFor({ timeout: 10000 });
        console.log('OK setup: root was unregistered — registered it now');
    } else {
        console.log('OK setup: root was already registered');
    }

    // Let the real status settle at the root so the cache picks up a real
    // branch (not just the "…" placeholder) before we test the pre-fill.
    await app.evaluate(async () => {
        const a = window.Alpine.$data(document.body);
        await a._refreshTabGit(a.currentPane());
    });
    const cachedBranch = await app.evaluate((owner) => {
        const a = window.Alpine.$data(document.body);
        const hit = a.cachedRepoForPath(a.currentPane().path);
        return hit && hit.branch;
    }, OWNER_REPO);
    if (!cachedBranch) fail('expected the repo cache to have a branch cached at the root after a real status check, got: ' + cachedBranch);
    console.log(`OK setup: repo cache has branch "${cachedBranch}" cached at the root`);

    // Navigate away first so the next navigation into SUBDIR is a real path
    // change (not a same-path no-op that could get skipped by _loadDir).
    await app.evaluate(async (home) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), home);
    }, os.homedir());
    await page.waitForTimeout(150);

    // ── The core proof: navigate into a SUBFOLDER and read gitInfo the
    // instant navigate() resolves — the directory LISTING may have finished,
    // but a real GIT.status() (6 sequential git subprocesses) could not
    // plausibly have completed yet. gitInfo must already be populated from
    // the cache. ──
    const t0 = Date.now();
    const immediate = await app.evaluate(async (dir) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), dir);
        const info = a.currentPane().gitInfo;
        return info ? { branch: info.branch, ownerRepo: info.remote && info.remote.ownerRepo, optimistic: !!info._optimistic } : null;
    }, SUBDIR);
    const elapsedMs = Date.now() - t0;

    if (!immediate) fail('gitInfo was not populated synchronously after navigate() resolved — the cache pre-fill did not fire');
    if (immediate.ownerRepo !== OWNER_REPO) fail('expected immediate gitInfo.remote.ownerRepo=' + OWNER_REPO + ', got: ' + immediate.ownerRepo);
    if (!immediate.branch) fail('expected an immediate branch (from cache), got: ' + immediate.branch);
    console.log(`OK instant pre-fill: gitInfo present right after navigate() resolved (${elapsedMs}ms) — ownerRepo=${immediate.ownerRepo} branch="${immediate.branch}" optimistic=${immediate.optimistic}`);

    // The visible bar must show it too, without a wait — it's driven by the
    // same reactive gitInfo we just read.
    await repoStrip.waitFor({ timeout: 2000 });
    const barOwnerRepo = await repoStrip.locator('.repo-strip-branch > .text-muted').innerText();
    if (!barOwnerRepo.includes(OWNER_REPO)) fail('repo-strip bar does not show ' + OWNER_REPO + ' immediately: ' + barOwnerRepo);
    console.log('OK instant pre-fill: the visible .repo-strip bar shows ' + OWNER_REPO + ' with no perceptible wait');

    // ── Reconcile: shortly after, the authoritative fields must be present
    // and _optimistic gone (navigate() fires _refreshTabGit unawaited). ──
    await app.waitForFunction(() => {
        const a = window.Alpine.$data(document.body);
        const info = a.currentPane().gitInfo;
        return info && info._optimistic !== true && typeof info.dirtyCount === 'number';
    }, { timeout: 10000 });
    const reconciled = await app.evaluate(() => {
        const a = window.Alpine.$data(document.body);
        const info = a.currentPane().gitInfo;
        return { branch: info.branch, dirtyCount: info.dirtyCount, ahead: info.ahead, behind: info.behind, optimistic: !!info._optimistic };
    });
    if (reconciled.optimistic) fail('gitInfo still flagged _optimistic after reconcile');
    if (typeof reconciled.dirtyCount !== 'number') fail('reconciled gitInfo missing dirtyCount: ' + JSON.stringify(reconciled));
    console.log(`OK reconcile: authoritative gitInfo settled — branch="${reconciled.branch}" dirtyCount=${reconciled.dirtyCount} ahead=${reconciled.ahead} behind=${reconciled.behind}, _optimistic gone`);

    // ── Stale-safety: point a cache entry at a path that is NOT (or no
    // longer) a work-tree, navigate into it, and confirm the optimistic bar
    // gets CLEARED after reconcile — no false bar left standing. ──
    const STALE_OWNER = 'e2e-fixture/stale-repo';
    // A REAL repo (git init + a commit + a remote), so GIT.isWorkTree()/
    // GIT.status() behave exactly as they would for any genuine checkout —
    // then it gets deleted below so a subsequent visit's GIT.isWorkTree()
    // is definitely false.
    fs.writeFileSync(path.join(STALE_DIR, 'README.md'), 'stale fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: STALE_DIR });
    execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: STALE_DIR });
    execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: STALE_DIR });
    execFileSync('git', ['add', 'README.md'], { cwd: STALE_DIR });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: STALE_DIR });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/' + STALE_OWNER + '.git'], { cwd: STALE_DIR });

    await app.evaluate(async ({ owner, dir, branch }) => {
        const a = window.Alpine.$data(document.body);
        // Register directly (this is a synthetic, no-commit repo — the
        // normal registerCurrentTab flow expects a resolved gitInfo, which a
        // hand-built .git dir with no commits won't reliably produce).
        await a._addRepoCheckout(owner, dir, 'stale-repo', branch);
    }, { owner: STALE_OWNER, dir: STALE_DIR, branch: 'main' });

    // Verify the pre-fill DOES fire for it (proves the "stale" case is a
    // genuine test of reconcile-clears-it, not just "never showed up").
    const staleImmediate = await app.evaluate(async (dir) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), dir);
        const info = a.currentPane().gitInfo;
        return info ? { ownerRepo: info.remote && info.remote.ownerRepo, optimistic: !!info._optimistic } : null;
    }, STALE_DIR);
    if (!staleImmediate || staleImmediate.ownerRepo !== STALE_OWNER) fail('expected the stale entry to pre-fill optimistically too, got: ' + JSON.stringify(staleImmediate));
    console.log('OK stale-safety setup: optimistic bar DID render for the (about-to-be-invalidated) cached repo');

    // Now actually invalidate it — delete the whole directory — and reload
    // the SAME path so _loadDir's guard (skip if already non-optimistic same
    // repo) doesn't apply (gitInfo here is still the optimistic stub from
    // above, so it's allowed to prefill again) and _refreshTabGit runs the
    // real (now-failing) check.
    fs.rmSync(STALE_DIR, { recursive: true, force: true });
    await app.evaluate(async () => {
        const a = window.Alpine.$data(document.body);
        await a._refreshTabGit(a.currentPane());
    });
    const afterInvalidate = await app.evaluate(() => {
        const a = window.Alpine.$data(document.body);
        return a.currentPane().gitInfo;
    });
    if (afterInvalidate !== null) fail('REGRESSION: gitInfo was not cleared after the cached repo was deleted — a false git bar would persist: ' + JSON.stringify(afterInvalidate));
    console.log('OK stale-safety: after the cached repo was deleted, reconcile CLEARED gitInfo (no false bar)');

    // Forget the synthetic cache entry so it doesn't linger in the user's
    // real repo cache after restore (restore() below overwrites the whole
    // file anyway, but be tidy in case restore ever changes).
    await app.evaluate(async (owner) => {
        const a = window.Alpine.$data(document.body);
        delete a.repoCache[owner];
    }, STALE_OWNER);

    // ── Cleanup: restore tab state, then restore both settings files ──
    await restoreTabState();
    await browser.close();

    restore(REPOS_JSON, repoJsonBefore);
    restore(TABS_YML, tabsYmlBefore);
    const repoJsonAfterSum = sha256(REPOS_JSON);
    const tabsYmlAfterSum = sha256(TABS_YML);

    console.log(`repos.json sha256 before=${repoJsonBeforeSum} after-restore=${repoJsonAfterSum} match=${repoJsonBeforeSum === repoJsonAfterSum}`);
    console.log(`tabs.yml   sha256 before=${tabsYmlBeforeSum} after-restore=${tabsYmlAfterSum} match=${tabsYmlBeforeSum === tabsYmlAfterSum}`);
    if (repoJsonBeforeSum !== repoJsonAfterSum) { console.log('FAIL: repos.json not restored byte-identical'); process.exit(1); }
    if (tabsYmlBeforeSum !== tabsYmlAfterSum) { console.log('FAIL: tabs.yml not restored byte-identical'); process.exit(1); }

    try { fs.rmSync(STALE_DIR, { recursive: true, force: true }); } catch (e) {}

    const risky = errors.filter(e => e.kind === 'pageerror' || e.kind === 'console');
    if (risky.length) { console.log('FAIL: unexpected page/console errors: ' + JSON.stringify(risky)); process.exit(1); }

    console.log('git-cache-e2e: OK');
    process.exit(0);
} catch (e) {
    try { await page.screenshot({ path: SHOT }); } catch (e2) {}
    try {
        restore(REPOS_JSON, repoJsonBefore);
        restore(TABS_YML, tabsYmlBefore);
    } catch (e3) {}
    try { fs.rmSync(STALE_DIR, { recursive: true, force: true }); } catch (e4) {}
    try { await browser.close(); } catch (e5) {}
    console.log('FAIL: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
}
