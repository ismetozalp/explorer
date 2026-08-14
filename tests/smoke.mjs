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
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL  = process.env.COCKPIT_URL  || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = process.env.SMOKE_SHOT   || '/tmp/claude-1000/-home-ismet-explorer/11d5c0a4-b9cb-42db-b51b-a4a7893b0208/scratchpad/smoke.png';

const errors = [];   // uncaught pageerrors + error-level console lines
const RISK = /is not a function|is not defined|Cannot read propert|Explorer[A-Z]|\bExRT\b|undefined is not/i;

// tabs.yml (persisted open tabs, incl. current path — see the preview-smoke
// finally block below) can already have a real user tab pointing somewhere
// meaningful. Snapshot now and force-restore the exact bytes at the end
// instead of trusting "navigate back to homePath" to reproduce it (it won't,
// if the original tab wasn't already at homePath).
const TABS_YML = path.join(os.homedir(), '.config', 'cockpit', 'explorer', 'tabs.yml');
let tabsSnapshot = null;
try { tabsSnapshot = fs.readFileSync(TABS_YML); } catch (e) {}
function restoreTabsFile() {
    if (tabsSnapshot == null) return;
    try { fs.writeFileSync(TABS_YML, tabsSnapshot); } catch (e) {}
}

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

    // Exercise extracted mixins live: open Settings (settings.js) and close it
    // via its Close button (dialogs/settings machinery). Note: Esc-to-close works
    // in the real UI but is NOT asserted here — Playwright can't reliably route a
    // key event into the Cockpit iframe to Bootstrap's document-level handler.
    let settingsOK = false;
    try {
        await app.locator('button[title="Settings"]').first().click({ timeout: 5000 });
        await app.locator('#settingsModal.show').waitFor({ timeout: 5000 });
        await app.locator('#settingsModal .btn-close, #settingsModal [data-bs-dismiss="modal"]').first().click({ timeout: 5000 });
        await app.locator('#settingsModal.show').waitFor({ state: 'hidden', timeout: 5000 });
        settingsOK = true;   // modal opened AND closed
    } catch (e) { errors.push({ kind: 'interaction', text: 'settings open/close failed: ' + e.message }); }

    // Preview surface (richer-preview, 3.0): a fast, dependency-free sanity
    // pass — no ffmpeg/office fixtures needed, just a plain text file. Opens
    // it the normal way (double-click), and checks the controls that every
    // preview window relies on: content renders, ◀/▶ stay hidden when the
    // folder has only one previewable file, and Maximize is present.
    let previewOK = false;
    const fixDir = path.join(os.homedir(), '.cache', 'explorer-preview-smoke');
    try {
        await app.evaluate(async (dir) => {
            await FS.mkdir(dir);
            await FS.writeText(dir + '/hello.txt', 'hello from the preview smoke test\n');
        }, fixDir);
        await app.evaluate(async (dir) => {
            const a = window.Alpine.$data(document.body);
            await a.navigate(a.currentPane(), dir);
        }, fixDir);
        await app.locator('.file-list tbody tr').first().waitFor({ timeout: 10000 });
        await app.locator(`tr[data-path="${fixDir}/hello.txt"]`).dblclick();
        await app.locator('#windowHost.show').waitFor({ timeout: 10000 });
        await app.locator('.preview-code-wrap').waitFor({ timeout: 10000 });
        const content = await app.locator('.preview-code-wrap .preview-code').innerText();
        if (!content.includes('hello from the preview smoke test')) throw new Error('preview did not show file contents: ' + content);
        if (await app.locator('.win-nav-btn').first().isVisible()) throw new Error('◀/▶ should be hidden with a single previewable file');
        if (!(await app.locator('.win-btn[title="Maximize"]').count())) throw new Error('Maximize control missing');
        await app.locator('.win-btn-close').click();
        previewOK = true;
    } catch (e) {
        errors.push({ kind: 'interaction', text: 'preview smoke failed: ' + e.message });
    } finally {
        // Explorer persists open tabs (incl. current path) server-side at
        // ~/.config/cockpit/explorer/tabs.yml (on by default), debounced
        // 400ms. Navigate back to homePath and outwait the debounce BEFORE
        // deleting fixDir, or the next session restores to a deleted path.
        await app.evaluate(async () => {
            const a = window.Alpine.$data(document.body);
            if (a.activeWinId) a.closeActiveWindow();
            await a.navigate(a.currentPane(), a.homePath);
        }).catch(() => {});
        await page.waitForTimeout(600);
        await app.evaluate(async (dir) => { try { await FS.remove([dir]); } catch (e) {} }, fixDir).catch(() => {});
        try { fs.rmSync(fixDir, { recursive: true, force: true }); } catch (e) {}
    }

    // Committed-fixture preview pass (tests/samples/, see
    // samples-manifest-unit.mjs + samples-preview-e2e.mjs): a few
    // no-conversion kinds only — image, pdf, markdown, text — so this stays
    // fast and independent of ffmpeg (heavy video transcoding is exercised
    // in tests/samples-preview-e2e.mjs, not here).
    let samplesOK = false;
    const SAMPLES = path.join(__dirname, 'samples');
    try {
        await app.evaluate(async (dir) => {
            const a = window.Alpine.$data(document.body);
            await a.navigate(a.currentPane(), dir);
        }, SAMPLES);
        await app.locator('.file-list tbody tr[data-path]').first().waitFor({ timeout: 10000 });

        const openAndCheck = async (name, check) => {
            const sel = `tr[data-path="${SAMPLES}/${name}"]`;
            await app.locator(sel).dblclick();
            await app.locator('#windowHost.show').waitFor({ timeout: 10000 });
            await app.locator('.loading-overlay').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
            await check();
            await app.locator('.win-btn-close').click();
            await app.locator('#windowHost.show').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        };

        await openAndCheck('sample.png', async () => {
            const img = app.locator('img.preview-img');
            await img.waitFor({ timeout: 5000 });
            const w = await img.evaluate(el => el.naturalWidth);
            if (!(w > 0)) throw new Error('image preview: naturalWidth is 0');
        });
        await openAndCheck('sample.pdf', async () => {
            const frame = app.locator('iframe.preview-iframe');
            await frame.waitFor({ timeout: 5000 });
            const src = await frame.getAttribute('src');
            if (!src || !src.startsWith('blob:')) throw new Error('pdf preview: iframe has no blob: src');
        });
        await openAndCheck('sample.md', async () => {
            const doc = app.locator('iframe.preview-doc');
            await doc.waitFor({ timeout: 5000 });
            const srcdoc = await doc.getAttribute('srcdoc');
            if (!srcdoc || !/<h1/i.test(srcdoc)) throw new Error('markdown preview: srcdoc missing rendered <h1>');
        });
        await openAndCheck('sample.js', async () => {
            const content = await app.locator('.preview-code-wrap .preview-code').innerText();
            if (!content.includes('function greet')) throw new Error('text preview: missing expected file content');
        });

        samplesOK = true;
    } catch (e) {
        errors.push({ kind: 'interaction', text: 'samples preview smoke failed: ' + e.message });
    } finally {
        await app.evaluate(async () => {
            const a = window.Alpine.$data(document.body);
            if (a.activeWinId) a.closeActiveWindow();
            await a.navigate(a.currentPane(), a.homePath);
        }).catch(() => {});
        await page.waitForTimeout(600);
        restoreTabsFile();
    }

    await page.screenshot({ path: SHOT }).catch(() => {});
    const risky = errors.filter(e => e.kind === 'pageerror' || RISK.test(e.text) || (e.kind === 'interaction' && (!settingsOK || !previewOK || !samplesOK)));
    if (risky.length) done(1, `FAIL — ${risky.length} issue(s) after plugin load (see below). files=${fileCount}, settings=${settingsOK}, preview=${previewOK}, samples=${samplesOK}. Screenshot: ${SHOT}`);
    else done(0, `OK — 3.0.0 functional: visible toolbar, file list populated (${fileCount} rows), Settings modal open+close=${settingsOK}, preview controls=${previewOK}, samples preview (image/pdf/markdown/text)=${samplesOK}; no uncaught/risky JS errors. Screenshot: ${SHOT}`);
} catch (e) {
    restoreTabsFile();
    await page.screenshot({ path: SHOT }).catch(() => {});
    done(3, `ERROR driving the browser: ${e.message}. Screenshot: ${SHOT}`);
}
