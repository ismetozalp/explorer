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

    // Open the plugin frame directly (authenticated session cookie is set).
    await page.goto(`${URL}/cockpit/@localhost/explorer/index.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Alpine mounts on <body x-data="explorer">; the directory toolbar is the
    // first thing rendered. Its presence = the component assembled + ran.
    await page.waitForSelector('.toolbar', { timeout: 20000 });
    // Give init() a beat to run (it may log expected cockpit warnings).
    await page.waitForTimeout(2500);

    const hasTabs   = await page.$('.tab-bar, [class*="tab"]') != null;
    const bodyAlpine = await page.$('body[x-data="explorer"]') != null;
    await page.screenshot({ path: SHOT, fullPage: false }).catch(() => {});

    const risky = errors.filter(e => e.kind === 'pageerror' || RISK.test(e.text));
    if (risky.length) done(1, `FAIL — ${risky.length} risky JS error(s) after plugin load (see below). Screenshot: ${SHOT}`);
    else done(0, `OK — plugin rendered (toolbar present, x-data=${bodyAlpine}, tabs=${hasTabs}); no uncaught/risky JS errors. Screenshot: ${SHOT}`);
} catch (e) {
    await page.screenshot({ path: SHOT }).catch(() => {});
    done(3, `ERROR driving the browser: ${e.message}. Screenshot: ${SHOT}`);
}
