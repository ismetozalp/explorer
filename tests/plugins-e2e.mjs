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
  await browser.close(); process.exit(0);
} catch (e) { await page.screenshot({ path: SHOT }).catch(() => {}); fail('exception: ' + e.message); }
