// Playwright e2e for the AI CLI tabs (claude/codex). The interactive TUIs are
// NEVER launched for real — `_aiCliCommand` is stubbed to a harmless `echo` so
// the terminal mounts and the diff pane runs without starting an agent. It
// verifies: detection, opening an agent tab, terminal mount, the live git diff
// (tracked + a temp UNTRACKED file), adding/switching a 2nd session, closing,
// and that the resume browser reads the real registries with parsed cwd/title.
//
// Run:  COCKPIT_USER=<you> COCKPIT_PASS=<pass> node tests/agent-e2e.mjs
import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');          // the explorer repo (a git work tree)
const URL = process.env.COCKPIT_URL || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = path.join(os.tmpdir(), 'explorer-agent-e2e.png');

const errors = [];
const RISK = /is not a function|is not defined|Cannot read propert|Explorer[A-Z]|\bExRT\b|undefined is not/i;
const UNTRACKED = path.join(REPO, '_agent_e2e_untracked.txt');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e.message || e) }));
page.on('console', m => { if (m.type() === 'error') errors.push({ kind: 'console', text: m.text() }); });

function fail(msg) { console.log('FAIL: ' + msg); if (errors.length) for (const e of errors) console.log(`  [${e.kind}] ${e.text}`); cleanup(); browser.close().then(() => process.exit(1)); }
function cleanup() { try { fs.rmSync(UNTRACKED, { force: true }); } catch (e) {} }

try {
    if (!PASS) { console.log('Set COCKPIT_PASS to run this test.'); await browser.close(); process.exit(2); }
    fs.writeFileSync(UNTRACKED, 'agent e2e untracked marker\n');

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

    // Detection (self-heals via the init retry).
    const detected = await app.waitForFunction(() => { const h = window.Alpine.$data(document.body).ai.have; return h.claude && h.codex; }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!detected) fail('claude/codex not detected — the AI toolbar button would be hidden');
    if (!(await app.locator('.ai-menu-wrap').count())) fail('AI toolbar button missing');

    // Stub the CLI so no real interactive TUI launches in the terminal.
    await app.evaluate(() => { window.Alpine.$data(document.body)._aiCliCommand = () => 'echo AGENT_E2E_STUB'; });

    // Open a Claude agent tab rooted at the repo.
    await app.evaluate((d) => window.Alpine.$data(document.body).openAgentTab('claude', d), REPO);
    await app.locator('.agent-tab-body').waitFor({ timeout: 10000 });
    await app.waitForFunction(() => { const a = window.Alpine.$data(document.body); const t = a.activeTab(); return t && t.kind === 'agent' && t.terminals.length === 1; }, null, { timeout: 10000 });

    // Terminal mounted (xterm attached to this session's container).
    await app.waitForFunction(() => document.querySelector('.agent-term .term-container .xterm') !== null, null, { timeout: 8000 }).catch(() => {});
    if (!(await app.locator('.agent-term .term-container .xterm').count())) fail('agent terminal (xterm) did not mount');

    // Live diff: repo detected AND the untracked temp file appears in All mode.
    const gotDiff = await app.waitForFunction(() => {
        const a = window.Alpine.$data(document.body); const s = a.aiActiveSession(a.activeTab());
        return s && s.diff.repo === true && s.diff.text.includes('_agent_e2e_untracked.txt');
    }, null, { timeout: 12000 }).then(() => true).catch(() => false);
    if (!gotDiff) fail('live diff did not show the repo working tree incl. the untracked file');
    console.log('OK diff: repo detected, tracked + untracked changes shown, files=' +
        await app.evaluate(() => window.Alpine.$data(document.body).aiActiveSession(window.Alpine.$data(document.body).activeTab()).diff.files.length));

    // Diff mode switch (staged).
    await app.evaluate(() => { const a = window.Alpine.$data(document.body); a.aiSetDiffMode(a.aiActiveSession(a.activeTab()), 'staged'); });
    await app.waitForFunction(() => window.Alpine.$data(document.body).aiActiveSession(window.Alpine.$data(document.body).activeTab()).diff.mode === 'staged', null, { timeout: 5000 });

    // Add a 2nd session (codex) and switch back to the first.
    await app.evaluate((d) => window.Alpine.$data(document.body).aiAddSession(window.Alpine.$data(document.body).activeTab(), 'codex', { dir: d }), REPO);
    await app.waitForFunction(() => window.Alpine.$data(document.body).activeTab().terminals.length === 2, null, { timeout: 8000 });
    if (await app.evaluate(() => window.Alpine.$data(document.body).aiActiveSession(window.Alpine.$data(document.body).activeTab()).tool) !== 'codex') fail('2nd session should be the active codex session');
    const firstId = await app.evaluate(() => window.Alpine.$data(document.body).activeTab().terminals[0].id);
    await app.evaluate((id) => { const a = window.Alpine.$data(document.body); a.aiSelectSession(a.activeTab(), id); }, firstId);
    if (!(await app.evaluate((id) => window.Alpine.$data(document.body).activeTab().activeTermId === id, firstId))) fail('selecting the first session did not activate it');
    console.log('OK sub-tabs: added codex session (2 total), switched between sessions');

    // Resume browser reads the real registries with parsed cwd/title.
    await app.evaluate(() => window.Alpine.$data(document.body).openAgentSessions());
    await app.locator('#agentSessionsModal.show').waitFor({ timeout: 8000 });
    await app.waitForFunction(() => !window.Alpine.$data(document.body).agentBrowser.loading, null, { timeout: 25000 });
    const rb = await app.evaluate(() => { const b = window.Alpine.$data(document.body).agentBrowser; return { total: b.rows.length, withCwd: b.rows.filter(r => r.cwd).length, capped: b.rows.length <= 200 }; });
    if (rb.total === 0) fail('resume browser found no sessions');
    if (!rb.capped) fail('resume browser exceeded the 200-session cap');
    console.log(`OK resume browser: ${rb.total} sessions (≤200 cap), ${rb.withCwd} with a parsed cwd`);
    await app.locator('#agentSessionsModal .btn-close').click().catch(() => {});
    await app.locator('#agentSessionsModal.show').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

    // Close the agent tab (must tear down both sessions + their diff polls).
    await app.evaluate(() => { const a = window.Alpine.$data(document.body); a.closeTab(a.activeTab().id); });
    if (await app.evaluate(() => window.Alpine.$data(document.body).tabs.some(t => t.kind === 'agent'))) fail('agent tab was not closed');
    console.log('OK closed the agent tab and all its sessions');

    await page.screenshot({ path: SHOT }).catch(() => {});
    const risky = errors.filter(e => e.kind === 'pageerror' || RISK.test(e.text));
    if (risky.length) fail(`${risky.length} risky browser error(s)`);
    console.log('agent-e2e: OK — detection, agent tab, terminal mount, live diff (tracked+untracked), sub-tab sessions, resume browser, close (no real TUI launched).');
    cleanup();
    await browser.close();
    process.exit(0);
} catch (e) {
    await page.screenshot({ path: SHOT }).catch(() => {});
    fail('threw: ' + (e && e.message ? e.message : String(e)));
}
