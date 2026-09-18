import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVault, decryptVault, encryptVault, unlockVault, updateVault, validatePassword } from '../src/core/vault.mjs';

const password = 'Correct horse battery staple 55';
const payload = { mnemonic: `${'abandon '.repeat(11)}about`, network: 'testnet4', name: 'Test wallet', passphrase: '' };
test('wallet password is mandatory and unrelated to mnemonic seed passphrase', () => {
  for (const value of ['', 'short', null, 'x'.repeat(1025)]) assert.throws(() => validatePassword(value));
  assert.equal(validatePassword(password), password);
});
test('scrypt/AES-GCM roundtrip and authenticated corruption/wrong password fail closed', async () => {
  const envelope = await encryptVault(payload, password);
  assert.equal(envelope.kdf.N, 131072);
  assert.equal(envelope.cipher, 'aes-256-gcm');
  assert.equal(JSON.stringify(envelope).includes('abandon'), false);
  assert.deepEqual(await decryptVault(envelope, password), payload);
  await assert.rejects(decryptVault(envelope, 'Incorrect password 123'), /Cannot unlock/);
  const changed = { ...envelope, tag: `${envelope.tag[0] === '0' ? '1' : '0'}${envelope.tag.slice(1)}` };
  await assert.rejects(decryptVault(changed, password), /Cannot unlock/);
  await assert.rejects(decryptVault({ ...envelope, version: 2 }, password), /Unsupported/);
  await assert.rejects(decryptVault({ ...envelope, kdf: { ...envelope.kdf, N: 2 ** 30 } }, password), /Unsupported/);
  await assert.rejects(decryptVault({ ...envelope, salt: '00' }, password), /Invalid/);
});
test('exclusive atomic encrypted files, fresh nonce/salt, safe updates, no plaintext leftovers', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'connectwallet-vault-test-'));
  const file = path.join(directory, 'wallet.connectwallet.json');
  try {
    await createVault(file, payload, password);
    const first = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(await unlockVault(file, password), payload);
    await assert.rejects(createVault(file, payload, password), /already exists/);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), first);
    await updateVault(file, { ...payload, name: 'Updated' }, password);
    const second = JSON.parse(await readFile(file, 'utf8'));
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.nonce, second.nonce);
    assert.equal((await unlockVault(file, password)).name, 'Updated');
    assert.deepEqual(await readdir(directory), ['wallet.connectwallet.json']);
    assert.equal((await readFile(file, 'utf8')).includes('abandon'), false);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    assert.ok(path.basename(directory).startsWith('connectwallet-vault-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
