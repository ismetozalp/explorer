// Playwright e2e for the Users & sudo modal (3.3.0). DELIBERATELY performs NO
// privileged mutation — creating or deleting real OS accounts on the live host
// is not something to automate. It verifies the read/render path and that the
// client-side username validator is live in the browser:
//   - the modal opens and finishes loading;
//   - the current user is listed (from `getent passwd`, no escalation needed);
//   - the create form is present;
//   - _suValidUsername accepts a real name and rejects an injection-y one.
//
// Run:  COCKPIT_USER=<you> COCKPIT_PASS=<pass> node tests/sudoers-e2e.mjs
import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL  = process.env.COCKPIT_URL  || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = path.join(os.tmpdir(), 'explorer-sudoers-e2e.png');

const errors = [];
const RISK = /is not a function|is not defined|Cannot read propert|Explorer[A-Z]|\bExRT\b|undefined is not/i;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e.message || e) }));
page.on('console', m => { if (m.type() === 'error') errors.push({ kind: 'console', text: m.text() }); });

function fail(msg) { console.log('FAIL: ' + msg); if (errors.length) for (const e of errors) console.log(`  [${e.kind}] ${e.text}`); browser.close().then(() => process.exit(1)); }

try {
    if (!PASS) { console.log('Set COCKPIT_PASS to run this test.'); await browser.close(); process.exit(2); }
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#login-user-input, #content', { timeout: 15000 });
    if (await page.$('#login-user-input')) {
        await page.fill('#login-user-input', USER);
        await page.fill('#login-password-input', PASS);
        await page.click('#login-button');
        await page.waitForSelector('#content, iframe', { timeout: 20000 });
    }
    let app = null;
    for (const u of [`${URL}/explorer`, `${URL}/explorer/index`]) {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        const fr = await page.waitForSelector('iframe[src*="explorer"]', { timeout: 8000 }).catch(() => null);
        if (fr) { app = await fr.contentFrame(); if (app) break; }
    }
    if (!app) fail('no plugin frame');
    await app.locator('.toolbar').filter({ visible: true }).first().waitFor({ timeout: 20000 });

    // Open the modal the normal way (the toolbar button), then wait for the load.
    await app.evaluate(() => window.Alpine.$data(document.body).openUsers());
    await app.locator('#sudoersModal.show').waitFor({ timeout: 10000 });
    await app.waitForFunction(() => { const a = window.Alpine.$data(document.body); return a && a.su && !a.su.loading; }, null, { timeout: 15000 });

    // Current user is listed (getent passwd — no escalation needed).
    const me = await app.evaluate(() => window.Alpine.$data(document.body).su.me);
    if (!me) fail('su.me not resolved (id -un failed?)');
    const meRow = await app.locator(`#sudoersModal tbody tr`).filter({ hasText: me }).count();
    if (!meRow) fail(`current user "${me}" not shown in the user table`);

    // Create form present.
    if (!(await app.locator('#sudoersModal form input[type="password"]').count())) fail('create-user password field missing');
    if (!(await app.locator('#sudoersModal form input[type="text"]').count())) fail('create-user username field missing');

    // Client-side validator is live and strict (this is the injection guard).
    const v = await app.evaluate(() => {
        const a = window.Alpine.$data(document.body);
        return { good: a._suValidUsername('alice'), self: a._suValidUsername(a.su.me),
                 inja: a._suValidUsername('bad; rm -rf /'), injb: a._suValidUsername('Alice'), empty: a._suValidUsername('') };
    });
    if (!(v.good === true && v.self === true && v.inja === false && v.injb === false && v.empty === false))
        fail('username validator not behaving as expected: ' + JSON.stringify(v));

    await app.locator('#sudoersModal .btn-close').click();
    await app.locator('#sudoersModal.show').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

    await page.screenshot({ path: SHOT }).catch(() => {});
    const risky = errors.filter(e => e.kind === 'pageerror' || RISK.test(e.text));
    if (risky.length) fail(`${risky.length} risky browser error(s)`);
    console.log(`sudoers-e2e: OK — modal opens, lists "${me}", create form present, validator strict (no mutations performed).`);
    await browser.close();
    process.exit(0);
} catch (e) {
    await page.screenshot({ path: SHOT }).catch(() => {});
    fail('threw: ' + (e && e.message ? e.message : String(e)));
}
