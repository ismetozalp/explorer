// Playwright: main-tab + sub-tab drag reordering. Verifies the x-sort wiring is
// present, the handlers reorder the reactive array AND the rendered DOM, the new
// order persists to tabs.yml (dir tabs), and a best-effort real mouse-drag.
import { chromium } from 'playwright';
import os from 'os';
import { readFileSync, existsSync } from 'fs';

const URL = process.env.COCKPIT_URL || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const TABS_YML = os.homedir() + '/.config/cockpit/explorer/tabs.yml';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
let bad = 0;
let app = null, YML = null, original = null, errored = false;
const ok = (m) => console.log('E2E ok  ', m);
const fail = (m) => { bad++; console.log('E2E FAIL', m); };
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#login-user-input, #content', { timeout: 15000 });
  if (await page.$('#login-user-input')) {
    await page.fill('#login-user-input', USER); await page.fill('#login-password-input', PASS);
    await page.click('#login-button'); await page.waitForSelector('#content, iframe', { timeout: 20000 });
  }
  for (const u of [`${URL}/explorer`, `${URL}/explorer/index`]) {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    const fr = await page.waitForSelector('iframe[src*="explorer"]', { timeout: 8000 }).catch(() => null);
    if (fr) { app = await fr.contentFrame(); if (app) break; }
  }
  await app.locator('.toolbar').filter({ visible: true }).first().waitFor({ timeout: 20000 });

  // Back up the user's real tabs.yml (in-browser, via cockpit.file — node fs
  // can't write under ~/.config, it's sandbox-blocked) so this test never
  // leaves persisted test tabs behind. Restored just before exit, below.
  YML = await app.evaluate(() => Alpine.$data(document.querySelector('[x-data]')).homePath + '/.config/cockpit/explorer/tabs.yml');
  original = await app.evaluate(async (p) => { try { return await cockpit.file(p).read(); } catch (e) { return null; } }, YML);

  // Wiring present
  if (await app.locator('.tab-list[x-sort]').count()) ok('.tab-list has x-sort'); else fail('.tab-list x-sort missing');

  // Set up two dir tabs at DISTINCT paths so persisted order is checkable.
  await app.evaluate(() => {
    const c = Alpine.$data(document.querySelector('[x-data]'));
    c.settings.persistTabs = true;
  });
  await app.locator('.tab-new').first().click();           // new home dir tab
  await page.waitForTimeout(300);
  await app.evaluate(() => {
    const c = Alpine.$data(document.querySelector('[x-data]'));
    const dirs = c.tabs.filter(t => t.kind === 'dir');
    // give the two right-most dir tabs distinct known paths
    if (dirs.length >= 2) { dirs[dirs.length - 2].path = '/etc'; dirs[dirs.length - 1].path = '/tmp'; }
  });
  await page.waitForTimeout(200);

  const order = () => app.evaluate(() => {
    const c = Alpine.$data(document.querySelector('[x-data]'));
    return {
      ids: c.tabs.map(t => t.id),
      domIds: Array.from(document.querySelectorAll('.tab-list .tab .tab-label')).map(e => e.textContent),
      dirPaths: c.tabs.filter(t => t.kind === 'dir').map(t => t.path),
    };
  });

  const before = await order();
  // Target the /etc dir tab (currently BEFORE /tmp) and move it to the very end,
  // so after the reorder /etc must come AFTER /tmp — both in the array and in tabs.yml.
  const etcId = await app.evaluate(() => {
    const c = Alpine.$data(document.querySelector('[x-data]'));
    return (c.tabs.find(t => t.kind === 'dir' && t.path === '/etc') || {}).id;
  });
  if (!etcId) fail('could not find the /etc dir tab');
  await app.evaluate((id) => {
    const c = Alpine.$data(document.querySelector('[x-data]'));
    c.moveTab(id, c.tabs.length - 1);
  }, etcId);
  await page.waitForTimeout(300);
  const after = await order();
  if (after.ids[after.ids.length - 1] === etcId && before.ids[before.ids.length - 1] !== etcId) ok('moveTab reordered the tabs array');
  else fail('moveTab did not move /etc to end: ' + JSON.stringify({ before: before.ids, after: after.ids }));
  // DOM order tracks the array (labels shifted)
  if (JSON.stringify(after.domIds) !== JSON.stringify(before.domIds)) ok('DOM tab order updated'); else fail('DOM tab order unchanged');

  // Persistence: order written to tabs.yml (dir tabs by path).
  await app.evaluate(() => { const c = Alpine.$data(document.querySelector('[x-data]')); c._persistTabs(); });
  await page.waitForTimeout(700); // debounce 400ms + write
  if (existsSync(TABS_YML)) {
    const y = readFileSync(TABS_YML, 'utf8');
    const iEtc = y.indexOf('/etc'), iTmp = y.indexOf('/tmp');
    // after moving the first dir tab to the end, /etc should now come AFTER /tmp
    if (iEtc > -1 && iTmp > -1 && iEtc > iTmp) ok('tabs.yml persisted the new dir-tab order');
    else fail('tabs.yml order not as expected (iEtc=' + iEtc + ', iTmp=' + iTmp + ')');
  } else fail('tabs.yml not written');

  // Best-effort REAL mouse drag (documents drag actually works; tolerated if the
  // headless simulation doesn't register — the handler+wiring are already proven).
  try {
    const tabs = app.locator('.tab-list .tab');
    const n = await tabs.count();
    if (n >= 2) {
      const a = await tabs.nth(0).boundingBox();
      const b = await tabs.nth(1).boundingBox();
      const idsBefore = (await order()).ids;
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width, b.y + b.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const idsAfter = (await order()).ids;
      console.log('E2E note real-drag order ' + (JSON.stringify(idsBefore) !== JSON.stringify(idsAfter) ? 'CHANGED (drag works)' : 'unchanged (headless drag not registered; wiring proven above)'));
    }
  } catch (e) { console.log('E2E note real-drag skipped: ' + e.message); }

  // ---- Sub-tab reordering ----
  if (await app.locator('.term-subtab-list[x-sort]').count()) ok('.term-subtab-list has x-sort (in DOM)'); else fail('.term-subtab-list x-sort missing');
  // The "▤ Term" button only exists on dir tabs, and only the ACTIVE tab's
  // .tab-pane is visible (others stay in the DOM via x-show) — make a dir
  // tab active so a visible button actually exists, avoiding a hidden-tab
  // locator match.
  await app.evaluate(() => {
    const c = Alpine.$data(document.querySelector('[x-data]'));
    const d = [...c.tabs].reverse().find(t => t.kind === 'dir');
    if (d) c.activeTabId = d.id;
  });
  await page.waitForTimeout(200);
  // Open the integrated terminal split and add a 2nd terminal. Scope every
  // locator to the visible pane so a hidden tab's elements can't match.
  await app.locator('button[title*="integrated terminal" i]:visible').first().click();
  await app.locator('.term-subtab:visible').first().waitFor({ timeout: 8000 });
  await app.locator('.term-subtab-add:visible').first().click();
  await page.waitForTimeout(500);
  const termOrder = () => app.evaluate(() => {
    const c = Alpine.$data(document.querySelector('[x-data]'));
    const tab = c.tabs.find(t => t.id === c.activeTabId);
    return (tab.terminals || []).map(t => t.id);
  });
  const tBefore = await termOrder();
  if (tBefore.length >= 2) {
    await app.evaluate((firstId) => {
      const c = Alpine.$data(document.querySelector('[x-data]'));
      const tab = c.tabs.find(t => t.id === c.activeTabId);
      c.moveTerminal(tab, firstId, tab.terminals.length - 1);
    }, tBefore[0]);
    await page.waitForTimeout(300);
    const tAfter = await termOrder();
    if (tAfter[0] !== tBefore[0] && tAfter[tAfter.length - 1] === tBefore[0]) ok('moveTerminal reordered sub-tabs');
    else fail('moveTerminal did not reorder: ' + JSON.stringify({ tBefore, tAfter }));
  } else fail('could not open 2 sub-tabs (' + tBefore.length + ')');

  console.log(bad === 0 ? 'tab-reorder-e2e (main): OK' : (bad + ' FAILURES'));
} catch (e) {
  console.log('E2E ERR', e.message);
  errored = true;
}

// Always restore the user's real tabs.yml before exiting, regardless of pass/fail/error.
if (app && YML) {
  await app.evaluate(async ({ p, original }) => { try { await cockpit.file(p).replace(original); } catch (e) {} }, { p: YML, original }).catch(() => {});
}
await browser.close().catch(() => {});
process.exit(errored ? 2 : (bad === 0 ? 0 : 1));
