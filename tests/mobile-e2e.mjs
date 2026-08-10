// Consolidated mobile-friendliness e2e (Task 5 of the mobile-friendly SDD plan).
// Folds in, on a single iPhone 13 emulation profile, the checks proven
// individually across Tasks 1-4: ui.phone flag + no page overflow, the ⋯
// More menu (with ▶ Run staying inline / pinned), the global-actions modal,
// and the Plugin Manager opened via ⋯. Finishes with a desktop regression
// pass (.toolbar-more hidden, inline ⚙ Actions visible) at 1280x800.
//
// Boot boilerplate (login → find iframe[src*="explorer"] → contentFrame() →
// wait for the tab bar) is modeled on tests/plugins-e2e.mjs.
import { chromium, devices } from 'playwright';
import os from 'os';

const URL = process.env.COCKPIT_URL || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';

let failed = false;
const assert = (cond, msg) => {
  if (cond) { console.log('OK: ' + msg); }
  else { failed = true; console.log('FAIL: ' + msg); }
};

// Login → navigate to the plugin → find its iframe → return the content frame,
// after waiting for the tab bar to have booted.
async function bootApp(context) {
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (/401|handshake failed/.test(t)) return; // benign, documented
  });
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
    const fr = await page.waitForSelector('iframe[src*="explorer"], iframe[name*="explorer"]', { timeout: 8000 }).catch(() => null);
    if (fr) { app = await fr.contentFrame(); if (app) break; }
  }
  if (!app) throw new Error('no plugin frame found');
  await app.locator('.tab-bar').filter({ visible: true }).first().waitFor({ timeout: 20000 });
  return { page, app };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });

try {
  // ===================== Phone pass (iPhone 13) =====================
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true });
  const { app } = await bootApp(phoneCtx);
  const innerWidth = await app.evaluate(() => window.innerWidth);

  // (a) ui.phone===true and no horizontal overflow on the main view.
  const uiPhone = await app.evaluate(() => Alpine.$data(document.querySelector('[x-data]')).ui.phone);
  assert(uiPhone === true, 'ui.phone === true at iPhone 13 width');

  const noOverflow = await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert(noOverflow, 'no horizontal page overflow on the main view');

  // (b) ⋯ More menu visible + exposes Mounts/Actions/Plugins/Settings, while
  // ▶ Run stays inline. Also: regression check from the tab-bar pin fix —
  // both ▶ Run and ⋯ bounding boxes stay within the viewport.
  const runBtn = app.locator('.tab-bar-btn[title="Run a global action (not tied to a file)"]');
  assert(await runBtn.isVisible(), '▶ Run button stays inline/visible on phone');
  let box = await runBtn.boundingBox();
  assert(!!box && box.x >= 0 && box.x + box.width <= innerWidth + 1, '▶ Run bounding box within viewport (not covered by the tab list)');

  const moreBtn = app.locator('.toolbar-more .tab-bar-btn[title="More"]');
  assert(await moreBtn.isVisible(), '⋯ More trigger visible on phone');
  box = await moreBtn.boundingBox();
  assert(!!box && box.x >= 0 && box.x + box.width <= innerWidth + 1, '⋯ More bounding box within viewport (not covered by the tab list)');

  await moreBtn.click();
  await app.locator('.toolbar-more-panel').waitFor({ state: 'visible', timeout: 5000 });
  for (const label of ['Mounts', 'Actions', 'Plugins', 'Settings']) {
    const n = await app.locator('.toolbar-more-item', { hasText: label }).count();
    assert(n >= 1, `⋯ menu exposes "${label}"`);
  }
  // Close the panel before interacting elsewhere.
  await moreBtn.click();
  await app.locator('.toolbar-more-panel').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

  // (c) Global actions (▶ Run) modal: body fits, any Run button within innerWidth.
  await runBtn.click();
  await app.locator('#globalActionsModal.show').waitFor({ timeout: 5000 });
  const gaBodyFits = await app.evaluate(() => {
    const b = document.querySelector('#globalActionsModal .modal-body');
    return b.scrollWidth <= b.clientWidth + 1;
  });
  assert(gaBodyFits, 'global-actions modal body fits (no horizontal overflow)');
  const gaRunBtns = app.locator('#globalActionsModal button', { hasText: /^Run$/ });
  const gaCount = await gaRunBtns.count();
  if (gaCount > 0) {
    box = await gaRunBtns.first().boundingBox();
    assert(!!box && box.x >= 0 && box.x + box.width <= innerWidth + 1, 'global-actions Run button within innerWidth');
  } else {
    console.log('NOTE: no global actions configured on this account; Run-button-on-screen check skipped (empty state)');
  }
  await app.locator('#globalActionsModal .btn-close').click();
  await app.locator('#globalActionsModal.show').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

  // (d) Plugin Manager opened via ⋯ → Plugins: body fits, first row button on-screen.
  await moreBtn.click();
  await app.locator('.toolbar-more-panel').waitFor({ state: 'visible', timeout: 5000 });
  await app.locator('.toolbar-more-item', { hasText: 'Plugins' }).click();
  await app.locator('#pluginsModal.show').waitFor({ timeout: 5000 });
  const pmBodyFits = await app.evaluate(() => {
    const b = document.querySelector('#pluginsModal .modal-body');
    return b.scrollWidth <= b.clientWidth + 1;
  });
  assert(pmBodyFits, 'Plugin Manager modal body fits (no horizontal overflow)');
  const firstRowBtn = app.locator('#pluginsModal tbody tr').first().locator('button');
  await firstRowBtn.first().waitFor({ state: 'visible', timeout: 20000 });
  box = await firstRowBtn.first().boundingBox();
  assert(!!box && box.x >= 0 && box.x + box.width <= innerWidth + 1, 'Plugin Manager first row button on-screen');
  await app.locator('#pluginsModal .modal-footer button', { hasText: /^Close$/ }).click();
  await app.locator('#pluginsModal.show').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

  await phoneCtx.close();

  // ===================== Desktop regression pass (1280x800) =====================
  const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  const { app: deskApp } = await bootApp(deskCtx);
  assert(await deskApp.locator('.toolbar-more').isHidden(), 'desktop (1280x800): .toolbar-more is hidden');
  assert(await deskApp.locator('.tab-bar-btn[title="Manage custom actions"]').isVisible(), 'desktop (1280x800): inline ⚙ Actions button is visible');
  await deskCtx.close();

  await browser.close();
  if (failed) { console.log('mobile-e2e: FAILED'); process.exit(1); }
  console.log('mobile-e2e: OK');
  process.exit(0);
} catch (e) {
  console.log('FAIL: exception: ' + e.message);
  await browser.close().catch(() => {});
  process.exit(1);
}
