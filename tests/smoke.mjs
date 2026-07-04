// Playwright smoke test for the Explorer Cockpit plugin (2.0.0 modularization).
// Drives your SYSTEM Chrome (no browser download). Logs into Cockpit, opens the
// plugin, and fails if the Alpine component doesn't render or any uncaught JS
// error fires — which is exactly how a broken/missing mixin would surface.
//
// Run:  COCKPIT_USER=<you> COCKPIT_PASS=<pass> node tests/smoke.mjs
//   (defaults: URL https://localhost:9090, USER = $USER)
// Without COCKPIT_PASS it stops at the login page and screenshots it.
import { chromium } from 'playwright';
import os from 'os';

const URL  = process.env.COCKPIT_URL  || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = process.env.SMOKE_SHOT   || '/tmp/claude-1000/-home-ismet-explorer/11d5c0a4-b9cb-42db-b51b-a4a7893b0208/scratchpad/smoke.png';

const errors = [];   // uncaught pageerrors + error-level console lines
const RISK = /is not a function|is not defined|Cannot read propert|Explorer[A-Z]|\bExRT\b|undefined is not/i;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e.message || e) }));
page.on('console', m => { if (m.type() === 'error') errors.push({ kind: 'console', text: m.text() }); });

function done(code, msg) {
    console.log(msg);
    if (errors.length) { console.log(`\n${errors.length} browser error(s):`); for (const e of errors) console.log(`  [${e.kind}] ${e.text}`); }
    browser.close().then(() => process.exit(code));
}

try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Cockpit login page
    await page.waitForSelector('#login-user-input, #content', { timeout: 15000 });

    if (!PASS) {
        await page.screenshot({ path: SHOT }).catch(() => {});
        console.log(`Reached Cockpit at ${URL} (login page). Set COCKPIT_PASS to run the full plugin test. Screenshot: ${SHOT}`);
        await browser.close();
        process.exit(2);
    }

    if (await page.$('#login-user-input')) {
        await page.fill('#login-user-input', USER);
        await page.fill('#login-password-input', PASS);
        await page.click('#login-button');
        await page.waitForSelector('#content, .system-information, iframe', { timeout: 20000 });
    }

    // Load the plugin THROUGH the Cockpit shell so cockpit.js transport is live
    // (channels/superuser work). A directly-loaded frame 401s and can't list
    // files. Try shell URLs, then fall back to the direct frame (degraded).
    let app = null;
    for (const u of [`${URL}/explorer`, `${URL}/explorer/index`, `${URL}/cockpit/@localhost/explorer/index.html`]) {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        const frameEl = await page.waitForSelector('iframe[src*="explorer"], iframe[name*="explorer"]', { timeout: 8000 }).catch(() => null);
        if (frameEl) { app = await frameEl.contentFrame(); if (app) break; }
        if (u.includes('index.html') && await page.$('.toolbar')) { app = page; break; }  // direct fallback
    }
    if (!app) done(3, `could not locate the plugin (no iframe/toolbar). Screenshot: ${SHOT}`);

    // Component assembled + rendered (visible toolbar; inactive tabs are hidden).
    await app.locator('.toolbar').filter({ visible: true }).first().waitFor({ timeout: 20000 });
    // Real transport working: the directory listing actually populated — a
    // cockpit.spawn/file round-trip, i.e. the app FUNCTIONS post-refactor.
    await app.locator('.file-name').first().waitFor({ timeout: 20000 });
    const fileCount = await app.locator('.file-list tbody tr').count();

    // Exercise extracted mixins live: open Settings (settings.js), close it —
    // preferring Esc (settings.js onKey), falling back to the Close button so a
    // Playwright iframe-keyboard nuance doesn't mask that the modal machinery works.
    let settingsOK = false, escClosed = false;
    try {
        await app.locator('button[title="Settings"]').first().click({ timeout: 5000 });
        await app.locator('#settingsModal.show').waitFor({ timeout: 5000 });
        await app.locator('#settingsModal').evaluate(el =>
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true })));
        escClosed = await app.locator('#settingsModal.show').waitFor({ state: 'hidden', timeout: 2500 }).then(() => true).catch(() => false);
        if (!escClosed) {
            await app.locator('#settingsModal .btn-close, #settingsModal [data-bs-dismiss="modal"]').first().click({ timeout: 5000 });
            await app.locator('#settingsModal.show').waitFor({ state: 'hidden', timeout: 5000 });
        }
        settingsOK = true;   // modal opened AND closed (by Esc or the button)
    } catch (e) { errors.push({ kind: 'interaction', text: 'settings open/close failed: ' + e.message }); }

    await page.screenshot({ path: SHOT }).catch(() => {});
    const risky = errors.filter(e => e.kind === 'pageerror' || RISK.test(e.text) || (e.kind === 'interaction' && !settingsOK));
    if (risky.length) done(1, `FAIL — ${risky.length} issue(s) after plugin load (see below). files=${fileCount}, settings=${settingsOK}, esc=${escClosed}. Screenshot: ${SHOT}`);
    else done(0, `OK — 2.0.0 functional: visible toolbar, file list populated (${fileCount} rows), Settings modal open+close=${settingsOK} (Esc-close=${escClosed}); no uncaught/risky JS errors. Screenshot: ${SHOT}`);
} catch (e) {
    await page.screenshot({ path: SHOT }).catch(() => {});
    done(3, `ERROR driving the browser: ${e.message}. Screenshot: ${SHOT}`);
}
