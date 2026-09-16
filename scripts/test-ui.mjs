// Real Electron/preload/service/vault UI smoke test. RPC uses an empty local
// fixture; no remote servers, user wallets, clipboard, or live coins are touched.
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GENESIS } from '../src/core/config.mjs';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'beauty-wallet-ui-test-'));
const screenshots = await mkdtemp(path.join(tmpdir(), 'beauty-wallet-ui-screens-'));
const tip = { chain: 'testnet4', height: 0, hash: GENESIS.testnet4, genesis_hash: GENESIS.testnet4, mediantime: 1780000000 };
const requests = [];
const sockets = new Set();
const fixture = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy());
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const { method, id, params = {} } = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      requests.push(method);
      let result;
      if (method === 'getchaintip') result = tip;
      else if (method === 'getaddressbalance') result = { tip, address: params.address, unit: 'connects', confirmed: '0', available_confirmed: '0', pending_delta: '0', immature: '0' };
      else if (['getaddresshistory', 'getaddressutxos'].includes(method)) result = { tip, address: params.address, unit: 'connects', items: [], next_cursor: null };
      else { socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported fixture method' } })}\n`); continue; }
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    }
  });
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 1, network: 'testnet4', rpc: { host: '127.0.0.1', port: fixture.address().port }, autoLockMinutes: 15 }));
let application;
let stage = 'launch';
let passed = false;
let seed = [];
const password = 'UI-test-only-long-password';
const env = { ...process.env, BEAUTY_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;

try {
  // Electron 44 may download its runtime lazily. Resolve it before starting
  // Playwright's launch deadline, so a cold install is not a false UI timeout.
  const executablePath = createRequire(import.meta.url)('electron');
  application = await electron.launch({ executablePath, args: [root], env, timeout: 30000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.name));
  // Screenshots are deliberately limited to screens with no recovery words.
  await page.getByRole('heading', { name: 'Hello, connection.' }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'welcome.png') });
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process, Object.isFrozen(window.beauty)]), ['undefined', 'undefined', true]);
  assert.equal(await page.evaluate(() => window.beauty.invoke('getblocktemplate').then(() => false, () => true)), true);

  stage = 'create and backup';
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  assert.equal(await page.locator('input[name="wordCount"]:checked').inputValue(), '24');
  await page.locator('input[name="wordCount"][value="12"]').check();
  await page.locator('#setup-name').fill('UI smoke test');
  await page.locator('#setup-password').fill(password);
  await page.locator('#setup-confirm').fill(password);
  assert.equal(await page.locator('#setup-password').getAttribute('minlength'), '12');
  await page.getByRole('button', { name: 'Create recovery phrase' }).click();
  await page.getByRole('heading', { name: 'These words are your wallet.' }).waitFor();
  assert.equal(await page.locator('.seed-word').count(), 12);
  // OS lock/setup expiry may retain phase='welcome'. A security epoch change
  // must still clear the in-progress phrase and every setup/password field.
  await page.evaluate(() => window.beauty.invoke('lock'));
  await page.getByRole('heading', { name: 'Hello, connection.' }).waitFor();
  assert.equal(await page.locator('.seed-word').count(), 0);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  await page.locator('input[name="wordCount"][value="12"]').check();
  await page.locator('#setup-name').fill('UI smoke test');
  await page.locator('#setup-password').fill(password);
  await page.locator('#setup-confirm').fill(password);
  await page.getByRole('button', { name: 'Create recovery phrase' }).click();
  await page.getByRole('heading', { name: 'These words are your wallet.' }).waitFor();
  seed = await page.locator('.seed-word').evaluateAll(nodes => nodes.map(node => node.lastChild.textContent.trim()));
  assert.equal(await page.locator('[data-action="copy-seed"]').count(), 0);
  await page.locator('#backup-ack').check();
  await page.getByRole('button', { name: 'Verify my backup' }).click();
  const indexes = await page.locator('#verify-form input').evaluateAll(nodes => nodes.map(node => Number(node.name.slice(5))));
  assert.equal(indexes.length, 3);
  assert.equal(new Set(indexes).size, 3);
  for (const index of indexes) await page.locator(`#check-${index}`).fill(seed[index]);
  await page.getByRole('button', { name: 'Open my wallet' }).click();
  await page.getByRole('heading', { name: 'A little more connected.' }).waitFor();
  await page.waitForFunction(async () => (await window.beauty.invoke('getState')).wallet?.balance?.available === '0');
  assert.equal(await page.locator('.seed-word').count(), 0);
  await page.screenshot({ path: path.join(screenshots, 'overview.png') });

  stage = 'receiving and bounty form';
  await page.locator('[data-view="receive"]').first().click();
  const address = await page.locator('.address-box').textContent();
  assert.match(address, /^tcc1p[a-z0-9]+$/);
  assert.match(await page.locator('img.qr').getAttribute('src'), /^data:image\/png;base64,/);
  await page.locator('[data-view="send"]').first().click();
  await page.getByRole('button', { name: 'Create a bounty', exact: true }).click();
  await page.locator('#send-domain').fill('example.com');
  await page.locator('#send-amount').fill('1');
  await page.locator('#send-expected').fill('1000');
  assert.equal(await page.getByRole('button', { name: 'Review bounty' }).isVisible(), true);
  // No funds, no broadcast: verify the form only and do not create a preview.
  await page.locator('[data-view="claims"]').first().click();
  await page.locator('#claims-rate').fill('101');
  assert.equal(await page.locator('#claims-warning').isVisible(), true);
  assert.equal(await page.locator('[role="switch"]').getAttribute('aria-checked'), 'false');

  stage = 'lock and unlock';
  await page.getByRole('button', { name: 'Lock wallet', exact: true }).click();
  await page.locator('#unlock-password').waitFor();
  assert.equal(await page.locator('.address-box').count(), 0);
  assert.equal(await page.locator('.seed-word').count(), 0);
  await page.locator('#unlock-password').fill(password);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await page.locator('[data-view="settings"]').first().waitFor();
  await page.locator('[data-view="settings"]').first().click();
  await page.getByRole('button', { name: 'View recovery phrase' }).click();
  await page.locator('#recovery-password').fill(password);
  await page.getByRole('button', { name: 'Reveal words' }).click();
  await page.getByRole('heading', { name: 'For your eyes only.' }).waitFor();
  assert.equal(await page.locator('.modal-seed-grid .seed-word').count(), 12);
  // Lock from the real main-process bridge while a phrase is visible. It must
  // disappear immediately without requiring any renderer close-button action.
  await page.evaluate(() => window.beauty.invoke('lock'));
  await page.locator('#unlock-password').waitFor();
  assert.equal(await page.locator('.seed-word').count(), 0);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  const encrypted = await readFile(path.join(profile, 'wallet.beauty.json'), 'utf8');
  assert.ok(!encrypted.includes(seed.join(' ')));
  assert.ok(!encrypted.includes(password));
  assert.ok(requests.includes('getaddressbalance'));
  assert.ok(!requests.includes('sendrawtransaction'));
  assert.deepEqual(errors, []);
  passed = true;
  console.log(`PASS: real Electron isolation, BIP39 backup, encrypted wallet, zero-balance RPC fixture, receive QR, bounty form, >100 warning, lock/unlock, recovery erasure. Screenshots: ${screenshots}`);
} catch (error) {
  // Avoid Playwright action dumps: they could contain a generated backup word.
  console.error(`UI smoke test failed during ${stage} (${error.name ?? 'Error'}). No recovery words were logged. Temporary profile preserved: ${profile}`);
  process.exitCode = 1;
} finally {
  seed.fill(''); seed = [];
  await application?.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => fixture.close(resolve));
  if (passed) {
    const absolute = path.resolve(profile);
    assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
    assert.ok(path.basename(absolute).startsWith('beauty-wallet-ui-test-'));
    await rm(absolute, { recursive: true, force: true });
  }
}
