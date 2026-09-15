// e2e for the code-census JSON export (JSON + Zip all) and the report/export
// button lifecycle.
//
// Regressions covered:
//   1. The Report button got stuck disabled when a pre-report analysis threw —
//      fixed by wrapping the flow in try/finally (v4.2.2).
//   2. The Report AND Zip-all buttons got stuck disabled when a second census
//      operation reused the shared folder dialog (askDirectory), silently
//      dropping the first call's resolve so its await hung and its busy flag
//      never cleared — fixed by (a) mutually-exclusive census ops and
//      (b) askDirectory cancelling a pending picker before opening a new one
//      (v4.3.x).
//   3. The JSON/Zip-all export pipeline actually writes valid files — the
//      single JSON to census-<table>.json, and Zip-all to a census-export.zip
//      built server-side with python3.
//
// The plugin under test is the INSTALLED copy (/explorer); it runs the census
// against THIS checkout (a real git repo). Files are written server-side to a
// temp dir on this same host and read back with node's fs.
//
// Run:  COCKPIT_USER=<you> COCKPIT_PASS=<pass> node tests/scc-export-e2e.mjs
import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';

const URL  = process.env.COCKPIT_URL  || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';

const REPO_ROOT = process.cwd();                 // this checkout — a real git repo
const EXPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-export-e2e-'));
const TABS_YML = path.join(os.homedir(), '.config', 'cockpit', 'explorer', 'tabs.yml');

const BENIGN = /\b401\b|handshake failed/i;
const errors = [];
class TestFailure extends Error {}
function fail(msg) { throw new TestFailure(msg); }
function snapshot(p) { try { return fs.readFileSync(p); } catch (e) { return null; } }
function restore(p, c) { if (c === null) { try { fs.unlinkSync(p); } catch (e) {} } else { try { fs.writeFileSync(p, c); } catch (e) {} } }

if (!PASS) { console.log('scc-export-e2e: SKIP (no COCKPIT_PASS)'); process.exit(0); }

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e.message || e) }));
page.on('console', m => { if (m.type() === 'error' && !BENIGN.test(m.text())) errors.push({ kind: 'console', text: m.text() }); });

let app = null;
const tabsYmlBefore = snapshot(TABS_YML);

// Poll a boolean predicate evaluated inside the frame.
async function waitFor(desc, fn, timeout = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        if (await app.evaluate(fn).catch(() => false)) return;
        await page.waitForTimeout(250);
    }
    fail('timeout waiting for: ' + desc);
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

    // ── Open a dir tab on the repo, reveal the inline repo panel, Census view ──
    await app.evaluate(async (dir) => {
        const a = window.Alpine.$data(document.body);
        a.newTab(dir);
        await new Promise(r => setTimeout(r, 1500));
        const t = a.activeTab();
        await a.aiToggleRepoPanel(t);
        a.aiRepoSetView(t, 'census');
    }, REPO_ROOT);

    // scc must be installed for this test to mean anything.
    await waitFor('scc installed', () => {
        const a = window.Alpine.$data(document.body); const s = a.paneSession(a.activeTab());
        return !!(s && s.scc && s.scc.installed);
    });
    // The census auto-runs the active analysis (Language table) on open.
    await waitFor('language table ran', () => {
        const a = window.Alpine.$data(document.body); const s = a.paneSession(a.activeTab());
        return !!(s && s.scc && s.scc.table.ranAt);
    });

    // ── TEST 1: Report button is NOT stuck disabled after a fresh run ──
    {
        const st = await app.evaluate(() => {
            const a = window.Alpine.$data(document.body); const s = a.paneSession(a.activeTab());
            // Inactive tab panes stay mounted (x-show), so scope to the VISIBLE
            // Report button (offsetParent === null when hidden).
            const vis = [...document.querySelectorAll('.repo-panel button')].filter(b => b.title === 'Generate report' && b.offsetParent !== null);
            return { reporting: !!s.scc.reporting, exporting: !!s.scc.exporting, tableRan: !!s.scc.table.ranAt, visibleCount: vis.length, disabled: vis[0] ? vis[0].disabled : 'no-btn' };
        });
        if (st.reporting !== false) fail('reporting flag should start false, got ' + JSON.stringify(st));
        if (st.disabled !== false) fail('Report button should be enabled after a run, got ' + JSON.stringify(st));
        console.log('OK report-button: enabled after analyses run (not stuck)');
    }

    // ── TEST 2: canExport reflects whether the active table has data ──
    {
        // Cache-independent: the active (run) table exports true; the same table
        // with its ranAt cleared exports false. (Which OTHER tables are cached is
        // repo-dependent, so don't assume any specific one is un-run.)
        const ok = await app.evaluate(() => {
            const a = window.Alpine.$data(document.body); const s = a.paneSession(a.activeTab());
            s.scc.sub = 'table';
            const can = a.aiSccCanExport(s);
            const saved = s.scc.table.ranAt; s.scc.table.ranAt = 0;
            const cannot = a.aiSccCanExport(s);
            s.scc.table.ranAt = saved;                          // restore
            return can === true && cannot === false;
        });
        if (!ok) fail('aiSccCanExport should be true for a run table and false once its ranAt is cleared');
        console.log('OK can-export: true for a table with data, false once cleared');
    }

    // ── TEST 3: concurrency — a second census op is refused while the folder
    //    dialog is open, and the first flag clears when the dialog is dismissed.
    //    (The picker is a static modal, so dismiss via the real _dpCancel path.) ──
    {
        await app.evaluate(() => {
            const a = window.Alpine.$data(document.body);
            a.aiSccReport(a.paneSession(a.activeTab()));        // runs analyses, then opens the dialog
        });
        await waitFor('report folder dialog open', () => {
            const a = window.Alpine.$data(document.body);
            return !!(a.dirPicker && a.dirPicker.resolve);
        }, 25000);

        const during = await app.evaluate(async () => {
            const a = window.Alpine.$data(document.body); const s = a.paneSession(a.activeTab());
            const reportingUp = !!s.scc.reporting;
            a.aiSccExportAll(s);                               // must be REFUSED (report in progress)
            await new Promise(r => setTimeout(r, 400));
            return { reportingUp, exportingAfter: !!s.scc.exporting };
        });
        if (!during.reportingUp) fail('Report should set reporting=true');
        if (during.exportingAfter !== false) fail('Zip-all must be refused while a Report is in progress (exporting=' + during.exportingAfter + ')');

        await page.waitForTimeout(400);                        // let the show-transition settle before hide
        await app.evaluate(() => { const a = window.Alpine.$data(document.body); a._dpCancel(); });
        await waitFor('reporting cleared after dismiss', () => {
            const a = window.Alpine.$data(document.body); const s = a.paneSession(a.activeTab());
            return s.scc.reporting === false;
        }, 10000);
        const after = await app.evaluate(() => {
            const a = window.Alpine.$data(document.body); const s = a.paneSession(a.activeTab());
            const rbtn = [...document.querySelectorAll('.repo-panel button')].find(b => b.title === 'Generate report' && b.offsetParent !== null);
            return { exporting: !!s.scc.exporting, reportDisabled: rbtn ? rbtn.disabled : 'no-btn' };
        });
        if (after.exporting !== false) fail('exporting must be false after dismiss');
        if (after.reportDisabled !== false) fail('Report button must be re-enabled after dismiss');
        console.log('OK concurrency: Zip-all refused during Report; both flags + buttons reset on dialog dismiss');
        await page.waitForTimeout(500);                        // settle before the next modal open
    }

    // ── TEST 4: askDirectory cancels a pending picker (no silently-dropped resolve) ──
    {
        const r = await app.evaluate(async () => {
            const a = window.Alpine.$data(document.body);
            // Bound each await so a returning regression FAILS the test instead of
            // hanging the (deadline-less) script forever.
            const bound = (p, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' hung')), 6000))]);
            const p1 = a.askDirectory('first', '/');            // opens picker #1
            const p2 = a.askDirectory('second', '/');           // must cancel #1 (resolve null)
            const first = await bound(p1, 'superseded askDirectory');   // resolves synchronously — must not hang
            await new Promise(r => setTimeout(r, 400));         // let the modal settle before dismissing
            a._dpCancel();                                      // close picker #2 the normal way
            const second = await bound(p2, 'cancelled picker');
            return { first, second };
        });
        if (r.first !== null) fail('a superseded askDirectory must resolve null, got ' + JSON.stringify(r.first));
        if (r.second !== null) fail('the cancelled picker #2 must resolve null, got ' + JSON.stringify(r.second));
        console.log('OK askDirectory: a second call cancels the pending one (first resolves null, no hang)');
        await page.waitForTimeout(500);
    }

    // ── TEST 5: single JSON export writes census-<table>.json ──
    {
        await app.evaluate(async (dir) => {
            const a = window.Alpine.$data(document.body); const s = a.paneSession(a.activeTab());
            s.scc.sub = 'table';
            a.askDirectory = async () => dir;                  // stub the picker to our temp dir
            await a.aiSccExport(s);
        }, EXPORT_DIR);
        await page.waitForTimeout(800);
        const f = path.join(EXPORT_DIR, 'census-languages.json');
        if (!fs.existsSync(f)) fail('single export did not write ' + f);
        const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (doc.table !== 'languages' || !Array.isArray(doc.languages)) fail('census-languages.json has the wrong shape');
        console.log('OK json-export: wrote a valid census-languages.json (' + doc.languages.length + ' languages)');
    }

    // ── TEST 6: Zip-all writes census-export.zip containing one JSON per table ──
    {
        await app.evaluate(async (dir) => {
            const a = window.Alpine.$data(document.body); const s = a.paneSession(a.activeTab());
            a.askDirectory = async () => dir;
            await a.aiSccExportAll(s);
        }, EXPORT_DIR);
        // Zip-all runs the core analyses first, so give it room, then poll for the file.
        const zip = path.join(EXPORT_DIR, 'census-export.zip');
        const t0 = Date.now();
        while (!fs.existsSync(zip) && Date.now() - t0 < 60000) await page.waitForTimeout(500);
        if (!fs.existsSync(zip)) fail('Zip-all did not write ' + zip);
        // PK\x03\x04 magic + non-trivial size = a real zip with entries.
        const buf = fs.readFileSync(zip);
        if (buf.length < 200 || buf[0] !== 0x50 || buf[1] !== 0x4b) fail('census-export.zip is not a valid zip');
        const entries = (buf.toString('latin1').match(/census-[a-z]+\.json/g) || []);
        const uniq = [...new Set(entries)];
        if (uniq.length < 2) fail('census-export.zip should contain several table JSONs, found: ' + uniq.join(','));
        console.log('OK zip-all: wrote census-export.zip with ' + uniq.length + ' table JSONs (' + buf.length + ' bytes)');
    }

    if (errors.length) fail(errors.length + ' browser error(s): ' + errors.map(e => '[' + e.kind + '] ' + e.text).join(' | '));
    console.log('scc-export-e2e: OK');
    process.exitCode = 0;
} catch (e) {
    console.log('scc-export-e2e: FAIL — ' + (e instanceof TestFailure ? e.message : (e && e.stack || e)));
    if (errors.length) console.log('browser errors:\n' + errors.map(e => '  [' + e.kind + '] ' + e.text).join('\n'));
    process.exitCode = 1;
} finally {
    // Restore tab persistence + clean the temp export dir.
    try {
        if (app) await app.evaluate(async () => {
            const a = window.Alpine.$data(document.body);
            if (a.activeWinId) a.closeActiveWindow();
        });
        await page.waitForTimeout(600);
    } catch (e) {}
    await browser.close();
    restore(TABS_YML, tabsYmlBefore);
    try { fs.rmSync(EXPORT_DIR, { recursive: true, force: true }); } catch (e) {}
}
