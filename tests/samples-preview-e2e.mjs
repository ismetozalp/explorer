// E2E for the file-preview system, exercised against the committed
// tests/samples/ fixtures (see samples-manifest-unit.mjs for what's there).
// Boot boilerplate follows tests/plugins-e2e.mjs / tests/preview-e2e.mjs.
// Desktop viewport, real Chrome, real ffmpeg on this host (no stubbing).
//
// Unlike preview-e2e.mjs (which creates/removes throwaway fixtures under
// ~/.cache), this test browses the plugin's OWN working tree at
// tests/samples/ — reachable directly by absolute path once the
// ~/.local/share/cockpit/explorer symlink (set up by the caller, not this
// script — see the repo's testing notes) makes Cockpit serve this checkout
// as the "explorer" plugin at all. No fixtures are created or deleted here.
//
// One preview kind at a time; every window is closed (and, for ffmpeg
// videos, its session torn down) before the next opens, so ffmpeg sessions
// never accumulate — verified against the real host at the end.
//
// Run:  COCKPIT_USER=<you> COCKPIT_PASS=<pass> node tests/samples-preview-e2e.mjs
import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(__dirname);
const SAMPLES = path.join(REPO, 'tests', 'samples');
const VIDEO_DIR = path.join(SAMPLES, 'video');
const AUDIO_DIR = path.join(SAMPLES, 'audio');

const URL  = process.env.COCKPIT_URL  || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = process.env.SMOKE_SHOT   || '/tmp/samples-preview-e2e.png';

const errors = [];
const BENIGN = /\b401\b|handshake failed/i;

class TestFailure extends Error {}
function fail(msg) { throw new TestFailure(msg); }
function ok(msg) { console.log('OK ' + msg); }

// ── tabs.yml: snapshot now, force-restore the exact bytes at the end. The
// persisted state can (and here, does) already point a real tab at
// tests/samples/ — navigating "back to homePath" like other e2e tests do
// would NOT reproduce that, so this test restores the literal bytes instead
// of relying on the app's own writer to reconstruct them. ──
const TABS_YML = path.join(os.homedir(), '.config', 'cockpit', 'explorer', 'tabs.yml');
let tabsSnapshot = null;
try { tabsSnapshot = fs.readFileSync(TABS_YML); } catch (e) { /* no persisted tabs yet — fine */ }
function restoreTabsFile() {
    if (tabsSnapshot == null) return;
    try { fs.writeFileSync(TABS_YML, tabsSnapshot); } catch (e) {}
}

const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
});
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

async function navTo(dir) {
    await app.evaluate(async (d) => {
        const a = window.Alpine.$data(document.body);
        await a.navigate(a.currentPane(), d);
    }, dir);
    await app.locator('.file-list tbody tr[data-path]').first().waitFor({ timeout: 10000 });
}

async function openRow(dir, name) {
    const sel = `tr[data-path="${dir}/${name}"]`;
    await app.locator(sel).waitFor({ timeout: 10000 });
    await app.locator(sel).dblclick();
    await app.locator('#windowHost.show').waitFor({ timeout: 10000 });
    await app.locator('.loading-overlay').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
}

async function closePreview() {
    if (!(await app.locator('#windowHost.show').count())) return;
    await app.locator('.win-btn-close').click();
    await app.locator('#windowHost.show').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}

async function pvField(field) {
    return app.evaluate((f) => {
        const w = window.Alpine.$data(document.body).activeWin();
        return w && w.pv ? w.pv[f] : undefined;
    }, field);
}

async function waitSrcdocContains(text, timeout = 8000) {
    await app.waitForFunction((t) => {
        const f = document.querySelector('iframe.preview-doc');
        const s = f && f.getAttribute('srcdoc');
        return !!(s && s.includes(t));
    }, text, { timeout });
}

// ── Leftover-ffmpeg / session-dir check (runs against the real host after
// the browser is closed) ──
function listLeftovers() {
    const cacheDir = path.join(os.homedir(), '.cache', 'cockpit-explorer', 'preview');
    let dirs = [];
    try { dirs = fs.readdirSync(cacheDir); } catch (e) {}
    // -x (exact executable-name match) rather than -af (full command-line
    // substring match): -af would also match this very shell/test-runner
    // invocation, since its own argv can legitimately contain the text
    // "ffmpeg" (e.g. inside this file's source when run via a wrapper) —
    // false-positive, observed live. -x only matches real ffmpeg processes.
    let procs = [];
    try {
        procs = execSync('pgrep -x ffmpeg 2>/dev/null || true').toString()
            .split('\n').map(s => s.trim()).filter(Boolean);
    } catch (e) {}
    return { dirs, procs };
}
async function waitNoLeftovers(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let last = listLeftovers();
    while ((last.dirs.length || last.procs.length) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
        last = listLeftovers();
    }
    return last;
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

    // Capture the MIME type each preview blob is actually created with (this
    // is the exact thing the 3.0.1 fix changed — previewed binaries used to
    // get an untyped blob, so the browser offered a download instead of
    // rendering). The app's CSP (connect-src 'self', no blob:) blocks
    // fetch()/XHR against a blob: URL from the test, so intercepting
    // URL.createObjectURL at the source is the only way to observe it.
    await app.evaluate(() => {
        window.__blobTypes = {};
        const orig = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            const u = orig(blob);
            window.__blobTypes[u] = blob && blob.type;
            return u;
        };
    });

    // ── Navigate to tests/samples/ and sanity-check the listing ──
    await navTo(SAMPLES);
    const rowCount = await app.locator('.file-list tbody tr[data-path]').count();
    if (rowCount !== 36) fail(`expected 36 rows (34 files + 2 subfolders) in tests/samples, got ${rowCount}`);
    const statusText = (await app.locator('.status-bar span').first().innerText()).trim();
    if (statusText !== '36 item(s) · 2 folder(s) · 34 file(s)') fail('unexpected status bar text: ' + statusText);
    ok(`selection-count sanity: ${rowCount} rows listed, status bar reads "${statusText}"`);

    // ── image ──
    await openRow(SAMPLES, 'sample.png');
    {
        const img = app.locator('img.preview-img');
        await img.waitFor({ timeout: 10000 });
        const [w, h] = await img.evaluate(el => [el.naturalWidth, el.naturalHeight]);
        if (!(w > 0 && h > 0)) fail(`image: expected non-zero natural size, got ${w}x${h}`);
        ok(`image (sample.png): <img class="preview-img"> renders, natural size ${w}x${h}`);
    }
    await closePreview();

    // ── svg ──
    await openRow(SAMPLES, 'sample.svg');
    {
        const img = app.locator('img.preview-img');
        await img.waitFor({ timeout: 10000 });
        const [w, h] = await img.evaluate(el => [el.naturalWidth, el.naturalHeight]);
        if (!(w > 0 && h > 0)) fail(`svg: expected non-zero natural size, got ${w}x${h}`);
        ok(`svg (sample.svg): renders via the same image path, natural size ${w}x${h}`);
    }
    await closePreview();

    // ── pdf (reuse the 3.0.1 content-type check) ──
    await openRow(SAMPLES, 'sample.pdf');
    {
        const frame = app.locator('iframe.preview-iframe');
        await frame.waitFor({ timeout: 10000 });
        const src = await frame.getAttribute('src');
        if (!src || !src.startsWith('blob:')) fail('pdf: iframe.preview-iframe src is not a blob: URL: ' + src);
        const type = await app.evaluate((u) => window.__blobTypes[u] || '', src);
        if (!/application\/pdf/.test(type)) fail('pdf: blob content-type is not application/pdf: ' + type);
        ok(`pdf (sample.pdf): <iframe class="preview-iframe"> blob: src, content-type "${type}"`);
    }
    await closePreview();

    // ── markdown: rendered <h1>, Source/Rendered toggle ──
    await openRow(SAMPLES, 'sample.md');
    {
        const docFrame = app.locator('iframe.preview-doc');
        await docFrame.waitFor({ timeout: 10000 });
        const srcdoc = await docFrame.getAttribute('srcdoc');
        if (!srcdoc || !/<h1/i.test(srcdoc)) fail('markdown: srcdoc missing rendered <h1>: ' + String(srcdoc).slice(0, 200));
        const toggleBtn = app.locator('.win-controls button', { hasText: /^(Source|Rendered)$/ });
        await toggleBtn.waitFor({ timeout: 5000 });
        if ((await toggleBtn.innerText()).trim() !== 'Source') fail('markdown: expected the toggle to read "Source" while rendered');
        await toggleBtn.click();
        await app.locator('.win-controls button', { hasText: 'Rendered' }).waitFor({ timeout: 5000 });
        const rawText = await app.locator('.preview-code-wrap .preview-code').innerText();
        if (!rawText.includes('# Explorer Markdown Preview Sample')) fail('markdown: Source toggle did not reveal raw markdown text: ' + rawText.slice(0, 200));
        await toggleBtn.click(); // back to rendered
        ok('markdown (sample.md): sandboxed iframe renders <h1>, Source/Rendered toggle works');
    }
    await closePreview();

    // ── docx: doc iframe renders visible document text (mammoth) ──
    await openRow(SAMPLES, 'sample.docx');
    {
        const docFrame = app.locator('iframe.preview-doc');
        await docFrame.waitFor({ timeout: 10000 });
        await waitSrcdocContains('Explorer DOCX Preview Sample');
        ok('docx (sample.docx): doc iframe renders the document\'s visible text');
    }
    await closePreview();

    // ── xlsx: table renders, multi-sheet picker, switching sheets works ──
    await openRow(SAMPLES, 'sample.xlsx');
    {
        const docFrame = app.locator('iframe.preview-doc');
        await docFrame.waitFor({ timeout: 10000 });
        await waitSrcdocContains('Fruit');
        let srcdoc = await docFrame.getAttribute('srcdoc');
        if (!/<table/i.test(srcdoc || '')) fail('xlsx: first sheet did not render as a <table>: ' + String(srcdoc).slice(0, 200));
        const picker = app.locator('.win-controls select');
        await picker.waitFor({ timeout: 5000 });
        const opts = await picker.locator('option').allInnerTexts();
        if (opts.join(',') !== 'Fruit,Numbers') fail('xlsx: unexpected sheet picker options: ' + opts.join(','));
        await picker.selectOption('1');
        await waitSrcdocContains('Explorer XLSX preview sample');
        ok('xlsx (sample.xlsx): table renders, sheet picker shows Fruit/Numbers, switching sheets updates the table');
    }
    await closePreview();

    // ── ods: same, second multi-sheet workbook (regression: sheet-picker reuse) ──
    await openRow(SAMPLES, 'sample.ods');
    {
        const docFrame = app.locator('iframe.preview-doc');
        await docFrame.waitFor({ timeout: 10000 });
        await waitSrcdocContains('Item');
        let srcdoc = await docFrame.getAttribute('srcdoc');
        if (!/<table/i.test(srcdoc || '')) fail('ods: first sheet did not render as a <table>: ' + String(srcdoc).slice(0, 200));
        const picker = app.locator('.win-controls select');
        await picker.waitFor({ timeout: 5000 });
        const opts = await picker.locator('option').allInnerTexts();
        if (opts.join(',') !== 'Sheet1,Sheet2') fail('ods: unexpected sheet picker options: ' + opts.join(','));
        await picker.selectOption('1');
        await waitSrcdocContains('Explorer ODS preview sample');
        ok('ods (sample.ods): table renders, sheet picker shows Sheet1/Sheet2, switching sheets updates the table');
    }
    await closePreview();

    // ── csv: must route to the spreadsheet renderer, not plain text ──
    await openRow(SAMPLES, 'sample.csv');
    {
        const kind = await pvField('kind');
        if (kind !== 'sheet') fail('csv: expected pv.kind === "sheet" (spreadsheet renderer), got ' + kind);
        const docFrame = app.locator('iframe.preview-doc');
        await docFrame.waitFor({ timeout: 10000 });
        await waitSrcdocContains('Apple');
        ok('csv (sample.csv): routes to the spreadsheet renderer (pv.kind==="sheet"), table renders');
    }
    await closePreview();

    // ── text: syntax-highlighted view shows file content ──
    await openRow(SAMPLES, 'sample.js');
    {
        const content = await app.locator('.preview-code-wrap .preview-code').innerText();
        if (!content.includes('function greet(name)')) fail('text: js preview missing expected content: ' + content.slice(0, 200));
        const cls = await app.locator('.preview-code-wrap .preview-code code').getAttribute('class');
        if (!/language-javascript/.test(cls || '')) fail('text: expected a language-javascript code class, got ' + cls);
        ok('text (sample.js): syntax-highlighted preview shows file content (language-javascript)');
    }
    await closePreview();

    // ── video/ subfolder ──
    await navTo(VIDEO_DIR);

    // native mp4: blob <video>, plays, currentTime advances, real dimensions
    await openRow(VIDEO_DIR, 'sample.mp4');
    {
        const video = app.locator('video.preview-media');
        await video.waitFor({ timeout: 10000 });
        const src = await video.getAttribute('src');
        if (!src || !src.startsWith('blob:')) fail('mp4: video src is not a blob: URL: ' + src);
        await video.evaluate(el => el.play().catch(() => {}));
        await app.waitForFunction(() => {
            const v = document.querySelector('video.preview-media');
            return v && v.readyState >= 2 && v.videoWidth > 0;
        }, { timeout: 10000 });
        await app.waitForTimeout(400);
        const [vw, vh, ct] = await video.evaluate(el => [el.videoWidth, el.videoHeight, el.currentTime]);
        if (!(vw > 0 && vh > 0)) fail(`mp4: expected non-zero videoWidth/Height, got ${vw}x${vh}`);
        if (!(ct > 0)) fail('mp4: currentTime did not advance from 0: ' + ct);
        ok(`native video (sample.mp4): blob <video> plays, ${vw}x${vh}, currentTime=${ct.toFixed(2)}s`);
    }
    await closePreview();

    // ffmpeg-path videos: mkv (h264/aac -> remux), avi (mpeg4/mp3 -> transcode),
    // ogv (theora/vorbis -> transcode; the 3.1.6 black-picture regression guard).
    const ffmpegCases = [
        { name: 'sample.mkv', label: 'mkv (remux path, h264/aac copy)' },
        { name: 'sample.avi', label: 'avi (transcode path, mpeg4/mp3 -> x264/aac)' },
        { name: 'sample.ogv', label: 'ogv (transcode path, theora/vorbis -> x264/aac — 3.1.6 black-picture regression)' },
    ];
    for (const c of ffmpegCases) {
        await openRow(VIDEO_DIR, c.name);
        const mode = await pvField('mode');
        if (mode !== 'hls') fail(`${c.name}: expected pv.mode === "hls" (ffmpeg/HLS path), got ${mode}`);

        // Poll for the transcode/remux badge state — these fixtures are only
        // ~4s long, so ffmpeg can finish before a fixed wait would catch it;
        // a tight poll loop is the only reliable way to observe the
        // transient 'transcoding'/'remuxing' state on a fast local host.
        let sawBadge = false;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            const state = await pvField('transcodeState');
            if (state === 'transcoding' || state === 'remuxing') { sawBadge = true; break; }
            if (state === 'error') fail(`${c.name}: transcodeState went to "error": ` + (await pvField('reason')));
            if (state === 'done') break; // finished before we caught the transient badge state
            await app.waitForTimeout(20);
        }

        await app.waitForFunction(() => {
            const v = document.getElementById('previewVideo');
            return v && v.videoWidth > 0;
        }, { timeout: 20000 });
        const video = app.locator('#previewVideo');
        await video.evaluate(el => el.play().catch(() => {}));
        await app.waitForTimeout(500);
        const [vw, vh, ct] = await video.evaluate(el => [el.videoWidth, el.videoHeight, el.currentTime]);
        if (!(vw > 0 && vh > 0)) fail(`${c.name}: expected non-zero videoWidth/Height, got ${vw}x${vh}`);
        if (!(ct > 0)) fail(`${c.name}: currentTime did not advance from 0: ${ct}`);

        // Decoded-frame luminance variance: catches the exact 3.1.6 bug
        // (controls/audio worked, picture was permanently black) that a
        // dimensions-only check would miss entirely.
        const variance = await video.evaluate((el) => {
            const canvas = document.createElement('canvas');
            canvas.width = el.videoWidth; canvas.height = el.videoHeight;
            const cx = canvas.getContext('2d');
            cx.drawImage(el, 0, 0, canvas.width, canvas.height);
            const data = cx.getImageData(0, 0, canvas.width, canvas.height).data;
            let sum = 0, sumSq = 0, n = 0;
            for (let i = 0; i < data.length; i += 4) {
                const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                sum += lum; sumSq += lum * lum; n++;
            }
            const mean = sum / n;
            return sumSq / n - mean * mean;
        });
        if (!(variance > 5)) fail(`${c.name}: decoded frame looks uniformly black/flat (luminance variance ${variance}) — black-picture regression`);
        ok(`ffmpeg video ${c.label}: mode="hls", badge seen=${sawBadge}, ${vw}x${vh}, currentTime=${ct.toFixed(2)}s, luminance variance=${variance.toFixed(1)} (not black)`);

        await closePreview();
        // Let the (fire-and-forget) session teardown — proc.close() + `rm -rf`
        // the session dir — actually land before starting the next session.
        await app.waitForTimeout(400);
    }

    // ── audio/ subfolder ──
    await navTo(AUDIO_DIR);
    await openRow(AUDIO_DIR, 'sample.mp3');
    {
        const audio = app.locator('audio.preview-media');
        await audio.waitFor({ timeout: 10000 });
        const src = await audio.getAttribute('src');
        if (!src || !src.startsWith('blob:')) fail('audio: src is not a blob: URL: ' + src);
        await audio.evaluate(el => el.play().catch(() => {}));
        await app.waitForFunction(() => {
            const a = document.querySelector('audio.preview-media');
            return a && a.readyState >= 2;
        }, { timeout: 10000 });
        await app.waitForTimeout(400);
        const [ct, dur, paused] = await audio.evaluate(el => [el.currentTime, el.duration, el.paused]);
        if (!(ct > 0)) fail('audio: currentTime did not advance from 0: ' + ct);
        if (!(dur > 0)) fail('audio: duration is not > 0: ' + dur);
        await audio.evaluate(el => el.pause());
        ok(`audio (sample.mp3): blob <audio> plays, currentTime=${ct.toFixed(2)}s, duration=${dur.toFixed(2)}s, paused=${paused}`);
    }
    await closePreview();

    // ── Restore tab state, then force-restore the exact tabs.yml bytes ──
    await restoreTabState();
    restoreTabsFile();
    const finalTabsBuf = tabsSnapshot != null ? fs.readFileSync(TABS_YML) : null;
    if (tabsSnapshot != null && (!finalTabsBuf || !finalTabsBuf.equals(tabsSnapshot))) fail('tabs.yml is not byte-identical to the pre-test snapshot after restore');
    if (tabsSnapshot != null) ok('tabs.yml restored byte-identical to the pre-test snapshot');

    const leftover = await waitNoLeftovers();
    if (leftover.dirs.length || leftover.procs.length) {
        fail(`leftover ffmpeg session(s) after teardown — dirs: ${JSON.stringify(leftover.dirs)}, procs: ${JSON.stringify(leftover.procs)}`);
    }
    ok('no leftover ffmpeg processes or ~/.cache/cockpit-explorer/preview session dirs');

    const risky = errors.filter(e => e.kind === 'pageerror' || e.kind === 'console');
    if (risky.length) fail(`${risky.length} unexpected browser error(s) during the run`);

    console.log('samples-preview-e2e: OK');
    await browser.close();
    process.exit(0);
} catch (e) {
    console.log('FAIL: ' + (e && e.message ? e.message : String(e)));
    if (errors.length) { console.log(`${errors.length} browser error(s):`); for (const er of errors) console.log(`  [${er.kind}] ${er.text}`); }
    await page.screenshot({ path: SHOT }).catch(() => {});
    await restoreTabState();
    restoreTabsFile();
    await browser.close();
    process.exit(1);
}
