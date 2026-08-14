// Consolidated e2e for the "richer file preview" feature (Task 7).
// Boot boilerplate follows tests/plugins-e2e.mjs. Desktop viewport.
//
// Fixtures are created (and removed) from inside the test, under the
// logged-in user's home directory, via the app's own FS helper — so the
// test is self-contained and leaves nothing behind:
//   ~/.cache/explorer-preview-e2e/
//     a.md    — "# Heading" (rendered-markdown assertion)
//     b.txt   — plain text (nav filler)
//     c.png   — tiny non-image bytes (nav filler; not actually rendered)
//     d.mkv   — dummy bytes (ffmpeg-missing-panel assertion; never decoded)
//     e.avi   — dummy bytes (fix-round-1 regression guard: .avi must route
//               to the video/ffmpeg-missing panel, NOT the "looks like a
//               binary file" text fallback — see Util.isVideo in utils.js)
//
// Run:  COCKPIT_USER=<you> COCKPIT_PASS=<pass> node tests/preview-e2e.mjs
import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';

const URL  = process.env.COCKPIT_URL  || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = process.env.SMOKE_SHOT   || '/tmp/preview-e2e.png';

const FIXDIR = path.join(os.homedir(), '.cache', 'explorer-preview-e2e');

const errors = [];
const BENIGN = /\b401\b|handshake failed/i;

// Thrown to unwind to the single catch block below, which does cleanup +
// screenshot + exit(1) exactly once (no fire-and-forget exit races).
class TestFailure extends Error {}
function fail(msg) { throw new TestFailure(msg); }

function cleanupHostFixtures() {
    // Best-effort local cleanup too (same machine/user as the Cockpit login
    // in the normal dev-loop case) — belt-and-braces alongside the in-page
    // FS.remove, in case the page/browser died mid-test.
    try { fs.rmSync(FIXDIR, { recursive: true, force: true }); } catch (e) {}
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e.message || e) }));
page.on('console', m => { if (m.type() === 'error' && !BENIGN.test(m.text())) errors.push({ kind: 'console', text: m.text() }); });

let app = null;

// Explorer persists open tabs (incl. the current path) server-side at
// ~/.config/cockpit/explorer/tabs.yml (Settings > "Persist open tabs",
// on by default) via a 400ms-debounced write. If we delete FIXDIR while a
// tab/window is still pointing at it, that stale path gets written and the
// *next* session (real user or another test) opens to a "No such file or
// directory" tab. Navigate back to homePath and outwait the debounce first.
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

    // ── Fixtures: create from inside the page (real FS transport) ──
    await app.evaluate(async (dir) => {
        await FS.mkdir(dir);
        await FS.writeText(dir + '/a.md', '# Heading\n\nSome body text for the preview e2e test.\n');
        await FS.writeText(dir + '/b.txt', 'plain text fixture\n');
        await FS.writeText(dir + '/c.png', 'not a real png, just tiny bytes');
        await FS.writeText(dir + '/d.mkv', 'dummy mkv bytes (never decoded by this test)');
        await FS.writeText(dir + '/e.avi', 'dummy avi bytes (never decoded by this test)');
    }, FIXDIR);

    // Force the ffmpeg-missing state up front (before any video preview is
    // loaded) rather than actually installing/removing ffmpeg on the host.
    // _vpProbeFfmpeg() caches this.video.ffmpeg once truthy, so setting it
    // here — before d.mkv is ever previewed — makes every subsequent video
    // load see "ffmpeg missing" without touching the real host state.
    await app.evaluate(() => { window.Alpine.$data(document.body).video.ffmpeg = { ffmpeg: false, ffprobe: false }; });

    // ── Navigate the active pane to the fixtures dir ──
    await app.evaluate(async (dir) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), dir);
    }, FIXDIR);
    // Wait for the LAST fixture row specifically (not just "any row") — the
    // listing re-renders as the directory read streams in, so counting rows
    // right after the first one appears can catch it mid-transition.
    await app.locator(`tr[data-path="${FIXDIR}/e.avi"]`).waitFor({ timeout: 10000 });
    // tbody also always contains a (usually x-show-hidden) "this folder is
    // empty" <tr> with no data-path — [data-path] excludes it.
    const rowCount = await app.locator('.file-list tbody tr[data-path]').count();
    if (rowCount !== 5) {
        const names = await app.locator('.file-list tbody tr[data-path] .file-name').allInnerTexts();
        fail(`expected 5 fixture rows, got ${rowCount}: ${JSON.stringify(names)}`);
    }
    console.log('OK fixtures: 5 previewable files created and listed (incl. e.avi)');

    // ── (a) Open a.md via double-click; nav present, disabled at start ──
    await app.locator(`tr[data-path="${FIXDIR}/a.md"]`).dblclick();
    await app.locator('#windowHost.show').waitFor({ timeout: 10000 });
    const prevBtn = app.locator('.win-nav-btn[aria-label="Previous file"]');
    const nextBtn = app.locator('.win-nav-btn[aria-label="Next file"]');
    await nextBtn.waitFor({ timeout: 10000 });
    if (!(await prevBtn.isDisabled())) fail('◀ should be disabled at the first file');
    if (await nextBtn.isDisabled()) fail('▶ should be enabled (not at the last file)');
    let counter = (await app.locator('.win-controls .text-muted').first().innerText()).trim();
    if (counter !== '1 / 5') fail(`expected counter "1 / 5", got "${counter}"`);
    console.log('OK nav: ◀/▶ present, ◀ disabled at start, counter "1 / 5"');

    // ── (b) Markdown renders; Source toggle switches to raw text ──
    const docFrame = app.locator('iframe.preview-doc');
    await docFrame.waitFor({ timeout: 10000 });
    const srcdoc = await docFrame.getAttribute('srcdoc');
    if (!srcdoc || !/<h1/i.test(srcdoc)) fail('markdown srcdoc missing rendered <h1>: ' + String(srcdoc).slice(0, 200));
    console.log('OK markdown: [sandbox] iframe srcdoc contains rendered <h1>');

    const toggleBtn = app.locator('.win-controls button', { hasText: /^(Source|Rendered)$/ });
    await toggleBtn.waitFor({ timeout: 5000 });
    if ((await toggleBtn.innerText()).trim() !== 'Source') fail('expected the toggle to read "Source" while rendered');
    await toggleBtn.click();
    await app.locator('.win-controls button', { hasText: 'Rendered' }).waitFor({ timeout: 5000 });
    const rawText = await app.locator('.preview-code-wrap .preview-code').innerText();
    if (!rawText.includes('# Heading')) fail('Source toggle did not reveal raw markdown text: ' + rawText.slice(0, 200));
    console.log('OK markdown: Source toggle switches to raw text ("# Heading" visible)');
    await toggleBtn.click(); // back to rendered, tidy state for what follows

    // ── (c) Native .mp4 fixture — optional; brief's fixture set has none ──
    console.log('SKIP native-mp4: no .mp4 fixture in this suite (optional per brief)');

    // ── Walk ▶ to the end (b.txt -> c.png -> d.mkv -> e.avi); path advances, disables ──
    for (let i = 0; i < 4; i++) {
        await nextBtn.click();
        await app.locator('.loading-overlay').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    }
    const endPath = await app.evaluate(() => window.Alpine.$data(document.body).activeWin().path);
    if (endPath !== FIXDIR + '/e.avi') fail('expected to land on e.avi after 4x ▶, got ' + endPath);
    if (!(await nextBtn.isDisabled())) fail('▶ should be disabled at the last file (e.avi)');
    if (await prevBtn.isDisabled()) fail('◀ should be enabled (not at the first file)');
    counter = (await app.locator('.win-controls .text-muted').first().innerText()).trim();
    if (counter !== '5 / 5') fail(`expected counter "5 / 5" at the end, got "${counter}"`);
    console.log('OK nav: ▶ advances activeWin().path through the folder and disables at the end (5 / 5)');

    // ── (d) ffmpeg-missing panel — .avi (fix-round-1 regression guard) ──
    // Before the fix, Util.isVideo() didn't include 'avi', so .avi fell
    // through to the text-like branch and rendered the "This looks like a
    // binary file…" fallback instead of ever reaching the video/ffmpeg path.
    // Asserting the SAME ffmpeg-missing panel (not the binary fallback) here
    // proves the routing fix, not just the pure-function unit test.
    const binaryFallback = app.locator('.preview-fallback', { hasText: 'This file cannot be previewed inline' });
    if (await binaryFallback.count()) fail('.avi fell through to the binary fallback — isVideo() routing regression');
    const missingPanel = app.locator('.preview-fallback', { hasText: 'ffmpeg is required' });
    await missingPanel.waitFor({ timeout: 10000 });
    const installBtn = app.locator('button', { hasText: 'Install ffmpeg' });
    if (!(await installBtn.count())) fail('Install ffmpeg button not shown in the ffmpeg-missing panel for .avi');
    let cmdText = (await app.locator('.preview-fallback pre code').innerText()).trim();
    if (!cmdText) fail('ffmpeg-missing panel is missing the install command text for .avi');
    console.log(`OK ffmpeg-missing (.avi): routes to the video panel, not binary fallback — install command ("${cmdText}"), Install ffmpeg button present (not clicked)`);

    // ── Same panel still shows for .mkv (step back one file) ──
    await prevBtn.click();
    await app.locator('.loading-overlay').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    await missingPanel.waitFor({ timeout: 10000 });
    cmdText = (await app.locator('.preview-fallback pre code').innerText()).trim();
    if (!cmdText) fail('ffmpeg-missing panel is missing the install command text for .mkv');
    console.log(`OK ffmpeg-missing (.mkv): panel shown with install command ("${cmdText}") and Install ffmpeg button (not clicked)`);

    await app.locator('.win-btn-close').click();

    // ── Restore tab state to homePath, then remove fixtures (page + local) ──
    await restoreTabState();
    await app.evaluate(async (dir) => { try { await FS.remove([dir]); } catch (e) {} }, FIXDIR);
    cleanupHostFixtures();

    const risky = errors.filter(e => e.kind === 'pageerror' || e.kind === 'console');
    if (risky.length) fail(`${risky.length} unexpected browser error(s) during the run`);

    console.log('preview-e2e: OK');
    await browser.close();
    process.exit(0);
} catch (e) {
    console.log('FAIL: ' + (e && e.message ? e.message : String(e)));
    if (errors.length) { console.log(`${errors.length} browser error(s):`); for (const er of errors) console.log(`  [${er.kind}] ${er.text}`); }
    await page.screenshot({ path: SHOT }).catch(() => {});
    await restoreTabState();
    if (app) await app.evaluate(async (dir) => { try { await FS.remove([dir]); } catch (e) {} }, FIXDIR).catch(() => {});
    cleanupHostFixtures();
    await browser.close();
    process.exit(1);
}
