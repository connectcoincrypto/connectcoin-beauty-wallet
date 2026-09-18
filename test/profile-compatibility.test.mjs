import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PROFILE_NAME, VAULT_NAME, LEGACY_PROFILE_NAME, LEGACY_VAULT_NAME, selectProfileDirectory, selectVaultFile } from '../src/core/profile-paths.mjs';
import { decryptVault, updateVault, unlockVault } from '../src/core/vault.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';

// Immutable synthetic backup produced by the pre-rebrand implementation.
// Re-encrypting this fixture with the code under test would hide format regressions.
const LEGACY_ENVELOPE = {
  format: 'connectcoin-beauty-wallet', version: 1,
  kdf: { name: 'scrypt', N: 131072, r: 8, p: 1, keyLength: 32 },
  cipher: 'aes-256-gcm',
  salt: 'd1bd410f2c49db9b445567ed009a65987af5c1dccd1861e3826a3345847c0ccf',
  nonce: '4c4e9c598cd6a9ee23ceb179',
  ciphertext: 'cd54c9557b97cb10e9c49ef7e2e8c3db9b4d98193393f0a5594f16168902b4d2e98d150e6258d491aefc1118dc911e16b7a18bfbc9874dc5c059ef52d5175ade6fa0641332309644b0924fab0d71f43984a141b12c13f7c1382f63bce9de0f319abe24d2d8eafe329cb74e48024939af1e5f04f09428608fe939b3af46edef72d57e58cab1ac12782742acadea9948f4f4563e4c85f9d6ea8649df30d340b113d4dfd0dcaaaa35161b5efcd5474c635d369b4043493a6cc06dcb4c6cacc0fa7df37aaac462a71020a0ce308d1f2c9996334f65c35456cd6424a873e36ed3d310818afc9c100a472b1ee773b7c231f548de77b7e3efd4b7856fbe9ef4bf7d03fb94',
  tag: '5667c4b9621abb467aaf844598ea37cf',
};
const PASSWORD = 'Legacy fixture password 2026';
const DATA = { mnemonic: `${'abandon '.repeat(11)}about`, network: 'testnet4', name: 'Legacy compatibility fixture', passphrase: '', receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1 };
const BYTES = `${JSON.stringify(LEGACY_ENVELOPE)}\n`;
class OfflineBackend extends EventEmitter { close() {} request() { throw new Error('Compatibility tests must not use the network.'); } }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-profile-'));
  t.after(async () => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('connectwallet-profile-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function install(directory, filename = VAULT_NAME) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), BYTES);
}

test('fresh profiles use ConnectWallet and selection does not create files or folders', async t => {
  const directory = await fixture(t);
  const profile = selectProfileDirectory(directory);
  assert.equal(profile, join(directory, PROFILE_NAME));
  assert.equal(selectVaultFile(profile), join(profile, VAULT_NAME));
  assert.deepEqual(await readdir(directory), []);
});

test('an installed legacy wallet and configuration are reused in place without copying', async t => {
  const directory = await fixture(t), legacy = join(directory, LEGACY_PROFILE_NAME);
  await install(legacy, LEGACY_VAULT_NAME);
  await writeFile(join(legacy, 'config.json'), '{"theme":"dark"}\n');
  // Even if an empty new profile was created by an interrupted launch, the old
  // encrypted wallet remains authoritative and must not be shadowed.
  await mkdir(join(directory, PROFILE_NAME));
  assert.equal(selectProfileDirectory(directory), legacy);
  assert.equal(selectVaultFile(legacy), join(legacy, LEGACY_VAULT_NAME));
  assert.equal(await readFile(join(legacy, LEGACY_VAULT_NAME), 'utf8'), BYTES);
  assert.equal(await readFile(join(legacy, 'config.json'), 'utf8'), '{"theme":"dark"}\n');
  assert.deepEqual(await readdir(join(directory, PROFILE_NAME)), []);
});

test('a legacy configuration-only profile is reused, but a current wallet takes precedence', async t => {
  const directory = await fixture(t), legacy = join(directory, LEGACY_PROFILE_NAME);
  await mkdir(legacy);
  assert.equal(selectProfileDirectory(directory), legacy);
  assert.equal(selectVaultFile(legacy), join(legacy, VAULT_NAME));
  const current = join(directory, PROFILE_NAME);
  await install(current);
  assert.equal(selectProfileDirectory(directory), current);
});

test('two wallet-bearing profile folders fail closed even when the encrypted bytes match', async t => {
  const directory = await fixture(t);
  const current = join(directory, PROFILE_NAME), legacy = join(directory, LEGACY_PROFILE_NAME);
  await install(current); await install(legacy, LEGACY_VAULT_NAME);
  assert.throws(() => selectProfileDirectory(directory), { code: 'WALLET_PROFILE_CONFLICT' });
  assert.equal(await readFile(join(current, VAULT_NAME), 'utf8'), BYTES);
  assert.equal(await readFile(join(legacy, LEGACY_VAULT_NAME), 'utf8'), BYTES);
});

test('two vault filenames in one profile fail closed before service initialization writes config', async t => {
  const directory = await fixture(t);
  await install(directory); await install(directory, LEGACY_VAULT_NAME);
  const before = (await readdir(directory)).sort();
  assert.throws(() => selectVaultFile(directory), { code: 'WALLET_PROFILE_CONFLICT' });
  const service = new WalletService({ directory, clientFactory: () => new OfflineBackend() });
  await assert.rejects(service.initialize(), { code: 'WALLET_PROFILE_CONFLICT' });
  assert.deepEqual((await readdir(directory)).sort(), before);
});

test('unexpected filesystem objects cannot be mistaken for an absent wallet', async t => {
  const directory = await fixture(t), profile = join(directory, PROFILE_NAME);
  await mkdir(join(profile, VAULT_NAME), { recursive: true });
  assert.throws(() => selectProfileDirectory(directory), /not a regular file/);
  assert.throws(() => selectVaultFile(profile), /not a regular file/);
});

test('a pre-rebrand encrypted backup remains authenticated and unlockable', async () => {
  assert.deepEqual(await decryptVault(LEGACY_ENVELOPE, PASSWORD), DATA);
  await assert.rejects(decryptVault({ ...LEGACY_ENVELOPE, format: 'connectwallet' }, PASSWORD), /Unsupported/);
});

test('ConnectWallet opens and updates a real legacy filename without creating a second vault', async t => {
  const directory = await fixture(t);
  await install(directory, LEGACY_VAULT_NAME);
  const service = new WalletService({ directory, clientFactory: () => new OfflineBackend() });
  try {
    await service.initialize();
    service.refresh = async () => service.getState();
    assert.equal(service.vaultFile, join(directory, LEGACY_VAULT_NAME));
    assert.equal(service.walletExists, true);
    await service.unlock({ password: PASSWORD });
    assert.equal(service.session.data.mnemonic, DATA.mnemonic);
    await service.lock();
    await updateVault(service.vaultFile, { ...DATA, name: 'ConnectWallet legacy profile' }, PASSWORD);
    assert.equal((await unlockVault(service.vaultFile, PASSWORD)).name, 'ConnectWallet legacy profile');
    assert.equal(JSON.parse(await readFile(service.vaultFile, 'utf8')).format, LEGACY_ENVELOPE.format);
    assert.equal((await readdir(directory)).includes(VAULT_NAME), false);
  } finally { await service.close(); }
});
