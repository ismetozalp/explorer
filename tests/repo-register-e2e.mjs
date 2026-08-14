// e2e for the "+ Register" / "cached" git-bar indicator bug (v3.1.7).
//
// Bug: browsing into a SUBFOLDER of an already-registered git repo still
// showed "+ Register" (and hid the "cached" badge), because the git bar
// used isCheckoutCached() (exact-path match against the registered repo
// ROOT) instead of a prefix-aware check. Fixed by pathInCachedRepo() in
// js/features/github.js + swapping the two x-show conditions in index.html.
//
// This plugin serves the working tree via the ~/.local/share/cockpit/explorer
// symlink, so the repo under test IS this checkout
// (/home/ismet/cockpit_projects/explorer, remote ismetozalp/explorer) — no
// fixture repo needs to be created.
//
// Registering writes to the repo-cache settings file
// (~/.config/cockpit/explorer/repos.json) and touches
// ~/.config/cockpit/explorer/tabs.yml (tab-persistence debounce writes the
// navigated path). Both are snapshotted at the start and restored
// byte-identical at the end.
//
// Run:  COCKPIT_USER=<you> COCKPIT_PASS=<pass> node tests/repo-register-e2e.mjs
import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const URL  = process.env.COCKPIT_URL  || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = process.env.SMOKE_SHOT   || '/tmp/repo-register-e2e.png';

const REPO_ROOT = process.cwd(); // this checkout — plugin serves it via the symlink
const SUBDIR = path.join(REPO_ROOT, 'tests');
const NON_REPO_DIR = os.homedir(); // must NOT be a git work-tree itself

const REPOS_JSON = path.join(os.homedir(), '.config', 'cockpit', 'explorer', 'repos.json');
const TABS_YML = path.join(os.homedir(), '.config', 'cockpit', 'explorer', 'tabs.yml');

const BENIGN = /\b401\b|handshake failed/i;
const errors = [];

class TestFailure extends Error {}
function fail(msg) { throw new TestFailure(msg); }

function sha256(p) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
    catch (e) { return null; } // file may legitimately not exist
}
function snapshot(p) {
    try { return fs.readFileSync(p); } catch (e) { return null; } // null = "did not exist"
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

// Snapshot BEFORE touching anything.
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

    // ── Navigate to the repo root ──
    await app.evaluate(async (dir) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), dir);
    }, REPO_ROOT);

    // Explorer keeps one .repo-strip per open TAB (hidden via x-show, not
    // removed from the DOM) — other persisted tabs from tabs.yml stay in the
    // DOM too, so every locator below must be scoped to the visible one.
    const repoStrip = app.locator('.repo-strip').filter({ visible: true });
    const registerBtn = repoStrip.locator('button', { hasText: '+ Register' });
    const cachedBadge = repoStrip.locator('.badge', { hasText: 'cached' });
    // Git bar should be visible with a branch name at the root of a git work-tree.
    await repoStrip.waitFor({ timeout: 10000 });
    const ownerRepoText = await repoStrip.locator('.repo-strip-branch > .text-muted').innerText();
    if (!/ismetozalp\/explorer/.test(ownerRepoText)) fail('expected repo-strip to show ismetozalp/explorer, got: ' + ownerRepoText);

    // Alpine's x-show leaves the element in the DOM and toggles its inline
    // style, so `.count()` is always 1 here — visibility (not presence) is
    // what x-show actually controls, so that's what must be asserted.
    if (await registerBtn.isVisible().catch(() => false)) {
        await registerBtn.click();
        await cachedBadge.waitFor({ timeout: 10000 });
        console.log('OK register: root was unregistered — clicked "+ Register", "cached" badge now shows at root');
    } else {
        await cachedBadge.waitFor({ timeout: 5000 });
        console.log('OK register: root was already registered — "cached" badge shown, nothing to click');
    }
    if (await registerBtn.isVisible().catch(() => false)) fail('"+ Register" should be gone at the root after registering');
    console.log('OK root: "+ Register" hidden, "cached" badge shown at the registered root');

    // ── Navigate INTO a subfolder — this is the regression ──
    await app.evaluate(async (dir) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), dir);
    }, SUBDIR);
    await repoStrip.waitFor({ timeout: 10000 });
    const subOwnerRepoText = await repoStrip.locator('.repo-strip-branch > .text-muted').innerText();
    if (!/ismetozalp\/explorer/.test(subOwnerRepoText)) fail('subfolder git bar missing ismetozalp/explorer: ' + subOwnerRepoText);
    const subBranch = (await repoStrip.locator('.branch-dd-toggle strong').innerText()).trim();
    if (!subBranch) fail('subfolder git bar missing a branch name');
    await cachedBadge.waitFor({ timeout: 5000 });
    if (await registerBtn.isVisible().catch(() => false)) fail('REGRESSION: "+ Register" is visible in a subfolder of an already-registered repo');
    console.log(`OK subfolder (${path.relative(REPO_ROOT, SUBDIR)}): branch "${subBranch}" + ismetozalp/explorer shown, "cached" badge shown, "+ Register" NOT shown`);

    // ── Sanity: a directory NOT in any registered repo must not falsely show "cached" ──
    await app.evaluate(async (dir) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), dir);
    }, NON_REPO_DIR);
    // Give the git-info refresh a beat, then confirm the repo-strip either
    // isn't shown at all (not a work-tree) or, if it is a work-tree for some
    // other reason, is at least not falsely flagged as this cached repo.
    await page.waitForTimeout(500);
    const stripVisible = await repoStrip.isVisible().catch(() => false);
    if (stripVisible) {
        const falseCached = await cachedBadge.isVisible().catch(() => false);
        if (falseCached) fail('REGRESSION: non-repo/unregistered directory falsely shows "cached"');
    }
    console.log(`OK non-repo dir (${NON_REPO_DIR}): no false "cached" badge`);

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

    const risky = errors.filter(e => e.kind === 'pageerror' || e.kind === 'console');
    if (risky.length) { console.log('FAIL: unexpected page/console errors: ' + JSON.stringify(risky)); process.exit(1); }

    console.log('repo-register-e2e: OK');
    process.exit(0);
} catch (e) {
    try { await page.screenshot({ path: SHOT }); } catch (e2) {}
    // Best-effort restore even on failure, so a failed run doesn't leave the
    // user's real repo cache / tab state mutated.
    try {
        restore(REPOS_JSON, repoJsonBefore);
        restore(TABS_YML, tabsYmlBefore);
    } catch (e3) {}
    try { await browser.close(); } catch (e4) {}
    console.log('FAIL: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
}
