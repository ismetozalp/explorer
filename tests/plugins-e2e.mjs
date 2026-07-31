import { chromium } from 'playwright';
import os from 'os';
const URL = process.env.COCKPIT_URL || 'https://localhost:9090';
const USER = process.env.COCKPIT_USER || os.userInfo().username;
const PASS = process.env.COCKPIT_PASS || '';
const SHOT = process.env.SMOKE_SHOT || '/tmp/plugins-e2e.png';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-certificate-errors'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
const fail = (m) => { console.log('FAIL: ' + m); browser.close().then(() => process.exit(1)); };
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#login-user-input, #content', { timeout: 15000 });
  if (await page.$('#login-user-input')) {
    await page.fill('#login-user-input', USER); await page.fill('#login-password-input', PASS);
    await page.click('#login-button'); await page.waitForSelector('#content, iframe', { timeout: 20000 });
  }
  let app = null;
  for (const u of [`${URL}/explorer`, `${URL}/explorer/index`]) {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    const fr = await page.waitForSelector('iframe[src*="explorer"], iframe[name*="explorer"]', { timeout: 8000 }).catch(() => null);
    if (fr) { app = await fr.contentFrame(); if (app) break; }
  }
  if (!app) fail('no plugin frame');
  await app.locator('.toolbar').filter({ visible: true }).first().waitFor({ timeout: 20000 });
  await app.locator('button', { hasText: 'Plugins' }).first().click();
  await app.locator('#pluginsModal.show').waitFor({ timeout: 5000 });
  // Title + controls present
  if (!(await app.locator('#pluginsModal .modal-title', { hasText: 'Plugin Manager' }).count())) fail('modal title should be "Plugin Manager"');
  if (!(await app.locator('#pluginsModal label:has-text("Force reinstall") input').count())) fail('missing Force reinstall toggle');
  if (!(await app.locator('#pluginsModal button', { hasText: 'Check for updates' }).count())) fail('missing Check for updates button');
  if (!(await app.locator('#pluginsModal button', { hasText: 'Update all' }).count())) fail('missing Update all button');
  if (!(await app.locator('#pluginsModal .modal-footer button', { hasText: /^Close$/ }).count())) fail('missing Close button');
  const rows = app.locator('#pluginsModal tbody tr');
  await rows.first().waitFor({ timeout: 5000 });
  const n = await rows.count();
  if (n !== 4) fail(`expected 4 plugin rows, got ${n}`);
  for (const label of ['Explorer', 'Cockpit Top', 'IF TV', 'Manifest'])
    if (!(await app.locator('#pluginsModal tbody tr', { hasText: label }).count())) fail(`missing row: ${label}`);
  if ((await app.locator('#pluginsModal tbody tr .badge').count()) !== 4) fail('each row should show a status badge');
  console.log('OK shell: Plugin Manager modal — title, controls, 4 rows + badges');
  // Check for updates → real versions populate for installed plugins.
  await app.locator('#pluginsModal button', { hasText: 'Check for updates' }).click();
  // Explorer is installed; wait until its row shows a version (not the checking dash).
  const expRow = app.locator('#pluginsModal tbody tr', { hasText: 'Explorer' });
  await expRow.locator('.badge', { hasText: /Up to date|Update|Unknown/ }).first().waitFor({ timeout: 20000 });
  const expText = await expRow.innerText();
  if (!/\d+\.\d+\.\d+/.test(expText)) fail('Explorer row has no version after check: ' + expText);
  // Every row resolved a repo of the form owner/name.
  for (const label of ['Explorer', 'Cockpit Top', 'IF TV', 'Manifest']) {
    const t = await app.locator('#pluginsModal tbody tr', { hasText: label }).innerText();
    if (!/ismetozalp\/(explorer|ctop|iftv|manifest)/.test(t)) fail(`row ${label} missing resolved repo: ${t}`);
  }
  console.log('OK check: versions + repos populated for all four plugins');
  // Force reinstall enables the Update button even on an up-to-date row.
  const expUpdate = expRow.locator('button', { hasText: 'Update' });
  if (await expUpdate.count()) {
    const before = await expUpdate.first().isEnabled();
    await app.locator('#pluginsModal label:has-text("Force reinstall") input').check();
    await app.locator('#pluginsModal').waitFor();
    const after = await expUpdate.first().isEnabled();
    if (!after) fail('Force reinstall should enable the Update button on an up-to-date row');
    await app.locator('#pluginsModal label:has-text("Force reinstall") input').uncheck();
    console.log(`OK force: Update button enabled by Force reinstall (was ${before ? 'enabled' : 'disabled'} → enabled)`);
  }
  if (process.env.RUN_INSTALL === '1') {
    // The install runs privileged (superuser:'require'); the shell session
    // starts in "Limited access" and the channel gets access-denied unless we
    // switch to administrative access first (same password as login, no TTY).
    if (await page.locator('text=Limited access').count()) {
      await page.locator('text=Limited access').first().click();
      await page.locator('#switch-to-admin-access-password').fill(PASS);
      await page.locator('button', { hasText: 'Authenticate' }).click();
      await page.locator('text=Administrative access').first().waitFor({ timeout: 10000 });
    }
    await app.locator('#pluginsModal label:has-text("Force reinstall") input').check();
    const exp = app.locator('#pluginsModal tbody tr', { hasText: 'Explorer' });
    await exp.locator('button', { hasText: 'Update' }).click();
    await app.locator('#pluginLog').filter({ hasText: /install done|installed\/updated/ }).waitFor({ timeout: 60000 });
    await app.locator('#pluginsModal button', { hasText: 'Restart Cockpit' }).waitFor({ timeout: 10000 });
    console.log('OK install: Explorer force-reinstall streamed logs and finished');
  }
  await browser.close(); process.exit(0);
} catch (e) { await page.screenshot({ path: SHOT }).catch(() => {}); fail('exception: ' + e.message); }
