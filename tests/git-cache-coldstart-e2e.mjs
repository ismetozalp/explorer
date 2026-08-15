// e2e measurement for the "optimistic git bar is dead on first navigation"
// bug (v3.1.9).
//
// The bug: _loadRepoCache() (js/app.js) used to be fired WITHOUT await, deep
// inside _initExtensions() — itself queued behind several other sequential,
// awaited fs/tmux/grub/version probes — while the FIRST directory load (the
// restored/initial tab, via a $nextTick(() => this._loadDir(tab)) callback
// registered much earlier in init()) ran essentially immediately. So
// this.repoCache stayed EMPTY for the entire window of the first navigation
// of a session — exactly when a user opens the plugin and clicks into their
// repo — meaning _prefillGitFromCache() always no-op'd on that first click
// and the git bar always waited for the full ~300-400ms authoritative
// GIT.status() reconcile (6 sequential subprocesses), never the fast,
// cache-based path proven in tests/git-cache-e2e.mjs.
//
// Fix: await this._loadRepoCache() early in init() (right after
// reapOrphanPreviews, before tab restore / the first _loadDir), plus a
// belt-and-suspenders _rearmGitPrefill() call (re-runs _prefillGitFromCache
// for every currently-open dir pane) at the end of _loadRepoCache() itself,
// for any pane that was already open before that load resolved.
//
// This test measures, with real wall-clock numbers, the very first
// navigation of a FRESH page load (deliberately not pre-waiting for
// anything beyond "a pane exists" — that's the real user scenario) into
// /home/ismet/cockpit_projects/explorer, which is registered in the user's
// repo cache as ismetozalp/explorer (branch main). It also verifies the
// _rearmGitPrefill belt-and-suspenders path directly.
//
// Run against pre-fix code (git stash) to show the regression, then
// post-fix to show it's resolved — see the fix report for both readings.
//
// Run:  COCKPIT_USER=<you> COCKPIT_PASS=<pass> node tests/git-cache-coldstart-e2e.mjs
import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const URL  = process.env.COCKPIT_URL  || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = process.env.SMOKE_SHOT   || '/tmp/git-cache-coldstart-e2e.png';

const REPO_ROOT = process.cwd(); // this checkout — plugin serves it via the symlink
const OWNER_REPO = 'ismetozalp/explorer';
const TABS_YML = path.join(os.homedir(), '.config', 'cockpit', 'explorer', 'tabs.yml');

const BENIGN = /\b401\b|handshake failed/i;
const errors = [];

class TestFailure extends Error {}
function fail(msg) { throw new TestFailure(msg); }

function sha256(p) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
    catch (e) { return null; }
}
function snapshot(p) { try { return fs.readFileSync(p); } catch (e) { return null; } }
function restore(p, content) {
    if (content === null) { try { fs.unlinkSync(p); } catch (e) {} }
    else { fs.writeFileSync(p, content); }
}

const tabsYmlBefore = snapshot(TABS_YML);
const tabsYmlBeforeSum = sha256(TABS_YML);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e.message || e) }));
page.on('console', m => { if (m.type() === 'error' && !BENIGN.test(m.text())) errors.push({ kind: 'console', text: m.text() }); });

let app = null;

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

    // ── Part 1: cold-start timing measurement ──
    // Deliberately the ONLY readiness wait is "a pane exists" — no extra
    // settle time, no pre-warming. This is the real "user opens the plugin
    // and immediately clicks into their repo" scenario, and it's the exact
    // condition that distinguishes pre-fix (tab restore/first _loadDir runs
    // before the un-awaited _loadRepoCache() resolves -> repoCache empty)
    // from post-fix (init() now awaits _loadRepoCache() before ANY pane
    // exists at all, so by the time this wait resolves the cache is
    // necessarily already warm).
    await app.waitForFunction(() => {
        const a = window.Alpine && window.Alpine.$data && window.Alpine.$data(document.body);
        return !!(a && a.currentPane && a.currentPane());
    }, { timeout: 15000 });

    const timing = await app.evaluate(async (dir) => {
        const a = window.Alpine.$data(document.body);
        const t0 = performance.now();
        let barAt = null, optimisticSeen = false, reconcileAt = null;
        const navP = a.navigate(a.currentPane(), dir);
        await new Promise((resolve) => {
            const iv = setInterval(() => {
                const info = a.currentPane().gitInfo;
                if (barAt === null && info && info.remote && info.remote.ownerRepo) {
                    barAt = performance.now() - t0;
                    optimisticSeen = !!info._optimistic;
                }
                if (reconcileAt === null && info && info.remote && info.remote.ownerRepo &&
                    info._optimistic !== true && typeof info.dirtyCount === 'number') {
                    reconcileAt = performance.now() - t0;
                    clearInterval(iv);
                    resolve();
                }
            }, 5);
            setTimeout(() => { clearInterval(iv); resolve(); }, 4000); // safety timeout
        });
        await navP;
        const info = a.currentPane().gitInfo;
        return {
            barAt, optimisticSeen, reconcileAt,
            repoCacheHadEntry: !!(a.repoCache && a.repoCache[Object.keys(a.repoCache)[0]]) || Object.keys(a.repoCache || {}).length > 0,
            finalOwnerRepo: info && info.remote && info.remote.ownerRepo,
            finalOptimistic: !!(info && info._optimistic),
            finalDirtyCount: info && info.dirtyCount,
        };
    }, REPO_ROOT);

    if (timing.finalOwnerRepo !== OWNER_REPO) fail('expected final gitInfo.remote.ownerRepo=' + OWNER_REPO + ', got: ' + timing.finalOwnerRepo);
    if (timing.finalOptimistic) fail('final gitInfo is still flagged _optimistic — reconcile never settled');
    if (typeof timing.finalDirtyCount !== 'number') fail('final gitInfo missing dirtyCount (reconcile did not complete): ' + JSON.stringify(timing));
    console.log(`MEASURED: barAt=${timing.barAt === null ? 'never' : timing.barAt.toFixed(1) + 'ms'} optimisticSeen=${timing.optimisticSeen} reconcileAt=${timing.reconcileAt === null ? 'never' : timing.reconcileAt.toFixed(1) + 'ms'} repoCacheWarmAtBar=${timing.repoCacheHadEntry}`);

    // ── Part 2: belt-and-suspenders re-arm — a pane opened while the cache
    // is empty must get the optimistic bar retroactively once the cache
    // loads, without a re-navigation. Simulates the exact sequence
    // _loadRepoCache() runs internally: `this.repoCache = <loaded>;
    // this._rearmGitPrefill();` ──
    const rearm = await app.evaluate(async ({ dir, home }) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), home); // clear any prior gitInfo (home isn't a repo)
        const savedCache = a.repoCache;
        a.repoCache = {}; // simulate "the cache hasn't loaded yet"
        await a.navigate(a.currentPane(), dir); // open the repo folder — cache empty, prefill can't fire
        const beforeInfo = a.currentPane().gitInfo; // read immediately — before the background reconcile can plausibly finish
        const beforeHasOwnerRepo = !!(beforeInfo && beforeInfo.remote && beforeInfo.remote.ownerRepo);
        // Simulate _loadRepoCache() resolving.
        a.repoCache = savedCache;
        a._rearmGitPrefill();
        const afterInfo = a.currentPane().gitInfo;
        return {
            beforeHasOwnerRepo,
            afterOwnerRepo: afterInfo && afterInfo.remote && afterInfo.remote.ownerRepo,
            afterOptimistic: !!(afterInfo && afterInfo._optimistic),
        };
    }, { dir: REPO_ROOT, home: os.homedir() });

    if (rearm.beforeHasOwnerRepo) console.log('NOTE: reconcile beat the cache-empty read (fast host) — re-arm assertion below is still meaningful');
    if (rearm.afterOwnerRepo !== OWNER_REPO) fail('REGRESSION: _rearmGitPrefill() did not retroactively pre-fill the already-open pane — got: ' + JSON.stringify(rearm));
    if (!rearm.afterOptimistic) fail('REGRESSION: _rearmGitPrefill() populated gitInfo but not as _optimistic — got: ' + JSON.stringify(rearm));
    console.log(`OK re-arm: a pane opened with an empty repoCache (ownerRepo present before rearm: ${rearm.beforeHasOwnerRepo}) got the optimistic bar retroactively after _rearmGitPrefill() — ownerRepo=${rearm.afterOwnerRepo} optimistic=${rearm.afterOptimistic}, with NO re-navigation`);

    // ── Cleanup ──
    await restoreTabState();
    await browser.close();

    restore(TABS_YML, tabsYmlBefore);
    const tabsYmlAfterSum = sha256(TABS_YML);
    console.log(`tabs.yml   sha256 before=${tabsYmlBeforeSum} after-restore=${tabsYmlAfterSum} match=${tabsYmlBeforeSum === tabsYmlAfterSum}`);
    if (tabsYmlBeforeSum !== tabsYmlAfterSum) { console.log('FAIL: tabs.yml not restored byte-identical'); process.exit(1); }

    const risky = errors.filter(e => e.kind === 'pageerror' || e.kind === 'console');
    if (risky.length) { console.log('FAIL: unexpected page/console errors: ' + JSON.stringify(risky)); process.exit(1); }

    console.log('git-cache-coldstart-e2e: OK');
    process.exit(0);
} catch (e) {
    try { await page.screenshot({ path: SHOT }); } catch (e2) {}
    try { restore(TABS_YML, tabsYmlBefore); } catch (e3) {}
    try { await browser.close(); } catch (e4) {}
    console.log('FAIL: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
}
