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

    // Stub the CLI so no real interactive TUI launches in the terminal, and force
    // shell launch so the test is deterministic regardless of the user's persisted
    // aiLaunch preference (tmux launch would block on the session-name prompt).
    await app.evaluate(() => { const d = window.Alpine.$data(document.body); d._aiCliCommand = () => 'echo AGENT_E2E_STUB'; d.settings.aiLaunch = 'shell'; });

    // Open a Claude agent tab THROUGH the folder picker (browse / search / choose)
    // rooted at the repo — the pre-start folder selection.
    // Fire-and-forget: aiPickAndOpen's promise only resolves after we choose a
    // folder below, so we must NOT await it here (that would deadlock the step).
    await app.evaluate((d) => { window.Alpine.$data(document.body).aiPickAndOpen('claude', d); }, REPO);
    await app.locator('#dirPickerModal.show').waitFor({ timeout: 8000 });
    // The search box narrows the current folder's subfolders.
    await app.evaluate(() => { window.Alpine.$data(document.body).dirPicker.filter = 'zzz_nomatch_xyz'; });
    const fEmpty = await app.evaluate(() => window.Alpine.$data(document.body)._dpFilteredEntries().length);
    await app.evaluate(() => { window.Alpine.$data(document.body).dirPicker.filter = ''; });
    const fFull = await app.evaluate(() => window.Alpine.$data(document.body)._dpFilteredEntries().length);
    if (!(fEmpty === 0 && fFull > 0)) fail(`dir picker search filter broken (empty=${fEmpty} full=${fFull})`);
    // Choose the started folder (the repo) → opens the agent tab.
    await app.evaluate(() => window.Alpine.$data(document.body)._dpChoose());
    await app.locator('#dirPickerModal.show').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    console.log('OK folder picker: opened, search filter narrows, chose folder');
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

    // Colored diff + per-file selection + open-in-editor.
    const diffUi = await app.evaluate(() => {
        const a = window.Alpine.$data(document.body); const s = a.aiActiveSession(a.activeTab());
        const html = a.aiDiffHtml(s);
        const full = a._aiVisibleDiffText(s);
        const files = s.diff.files.map(f => f.file);
        a.aiDiffToggleFile(s, files[0]);
        const one = a._aiVisibleDiffText(s);
        const selected = a.aiDiffFileSelected(s, files[0]);
        a.aiDiffClearSelection(s);
        return { colored: /adl (add|del|hunk)/.test(html), selected, nfiles: files.length,
                 filtered: one.indexOf(files[0]) !== -1 && one.length <= full.length };
    });
    if (!diffUi.colored) fail('diff pane is not colored (aiDiffHtml)');
    if (!diffUi.selected) fail('changed-file selection did not register');
    if (!diffUi.filtered) fail('selecting a file did not filter the visible diff');
    console.log(`OK diff pane: colored lines + per-file selection filters (files=${diffUi.nfiles})`);

    // Collapse the diff pane (terminal widens), then reveal it again.
    await app.evaluate(() => { const a = window.Alpine.$data(document.body); a.aiToggleDiff(a.activeTab()); });
    const collapsed = await app.waitForFunction(() => { const d = document.querySelector('.agent-diff'); const r = document.querySelector('.agent-diff-reveal'); return d && d.offsetParent === null && r && r.offsetParent !== null; }, null, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!collapsed) fail('diff pane did not collapse');
    await app.evaluate(() => { const a = window.Alpine.$data(document.body); a.aiToggleDiff(a.activeTab()); });
    const reexpanded = await app.waitForFunction(() => { const d = document.querySelector('.agent-diff'); return d && d.offsetParent !== null; }, null, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!reexpanded) fail('diff pane did not re-expand');
    console.log('OK diff pane: collapse + reveal');
    // Open a changed file in the Monaco editor (a plain-text one — our untracked
    // marker — to keep the check independent of preview widgets).
    await app.evaluate(() => {
        const a = window.Alpine.$data(document.body); const s = a.aiActiveSession(a.activeTab());
        const f = (s.diff.files.find(x => /_agent_e2e_untracked\.txt$/.test(x.file)) || s.diff.files[0]).file;
        a.aiOpenDiffFile(s, f);
    });
    const edOpened = await app.waitForFunction(() => window.Alpine.$data(document.body).windows.some(w => w.kind === 'editor'), null, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!edOpened) fail('open-in-editor from the diff strip did not open a Monaco editor');
    // Let Monaco finish mounting, then close cleanly (closing mid-init races the editor's own async setup).
    await app.locator('.monaco-editor').first().waitFor({ timeout: 8000 }).catch(() => {});
    await app.evaluate(() => { const a = window.Alpine.$data(document.body); const w = a.windows.find(x => x.kind === 'editor'); if (w) a.closeWindow(w.id); });
    await app.waitForFunction(() => !window.Alpine.$data(document.body).windows.some(w => w.kind === 'editor'), null, { timeout: 5000 }).catch(() => {});
    console.log('OK diff→editor: opened a changed file in Monaco');

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
    const rb = await app.evaluate(() => {
        const d = window.Alpine.$data(document.body); const b = d.agentBrowser;
        return { total: b.rows.length, withCwd: b.rows.filter(r => r.cwd).length, groups: d.aiGroupedSessions().length };
    });
    if (rb.total === 0) fail('resume browser found no sessions');
    // The registry scan must surface EVERY project, not a truncated slice — so we
    // expect several distinct project groups (this box has many) rather than a cap.
    if (rb.groups < 2) fail('resume browser did not group sessions across multiple projects');
    console.log(`OK resume browser: ${rb.total} sessions across ${rb.groups} project group(s), ${rb.withCwd} with a parsed cwd`);
    await app.locator('#agentSessionsModal .btn-close').click().catch(() => {});
    await app.locator('#agentSessionsModal.show').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

    // Close the agent tab via the user-facing handler. These are SHELL sessions
    // (no tmux), so closeTabAsk closes immediately with no terminate prompt.
    await app.evaluate(() => { const a = window.Alpine.$data(document.body); a.closeTabAsk(a.activeTab()); });
    const closed = await app.waitForFunction(() => !window.Alpine.$data(document.body).tabs.some(t => t.kind === 'agent'), null, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!closed) fail('agent tab was not closed');
    console.log('OK closed the agent tab and all its sessions (no tmux → no prompt)');

    // Move a running PLAIN terminal into AI view: keeps its live PTY (same term
    // instance) and gains the live git-diff pane.
    await app.evaluate((d) => window.Alpine.$data(document.body).newTerminalTab(d), REPO);
    await app.waitForFunction(() => { const t = window.Alpine.$data(document.body).activeTab(); return t && t.kind === 'terminal' && t.terminals && t.terminals.length === 1; }, null, { timeout: 10000 });
    await app.waitForFunction(() => document.querySelector('.term-container .xterm') !== null, null, { timeout: 10000 }).catch(() => {});
    const tId = await app.evaluate(() => window.Alpine.$data(document.body).activeTab().terminals[0].id);
    await app.evaluate((id) => { const a = window.Alpine.$data(document.body); a.moveTerminalToAiView(a.activeTab(), id); }, tId);
    await app.locator('.agent-tab-body').waitFor({ timeout: 8000 });
    const moved = await app.waitForFunction((id) => {
        const a = window.Alpine.$data(document.body); const t = a.activeTab();
        return t.kind === 'agent' && t.terminals.some(x => x.id === id) && !!window.ExRT.term.get(id)
            && document.querySelector('.agent-term #term-container-' + id + ' .xterm') !== null;
    }, tId, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!moved) fail('move-to-AI-view did not relocate the running terminal (same PTY) into an agent tab');
    const movedDiff = await app.waitForFunction(() => { const a = window.Alpine.$data(document.body); const s = a.aiActiveSession(a.activeTab()); return s && s.diff.repo && s.diff.files.length > 0; }, null, { timeout: 10000 }).then(() => true).catch(() => false);
    if (!movedDiff) fail('moved session did not get a live diff');
    console.log('OK move-to-AI-view: running terminal relocated (same PTY) + live diff');
    await app.evaluate(() => { const a = window.Alpine.$data(document.body); a.closeTabAsk(a.activeTab()); });

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
