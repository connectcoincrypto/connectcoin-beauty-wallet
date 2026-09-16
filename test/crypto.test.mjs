import assert from 'node:assert/strict';
import test from 'node:test';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { decodeAddress, deriveAccount, encodeAddress, generateMnemonic, normalizeMnemonic, publicKeyFromPrivate, signSchnorr, validateMnemonic, verifySchnorr } from '../src/core/crypto.mjs';

const words12 = `${'abandon '.repeat(11)}about`;
test('BIP39 official zero-entropy vector and TREZOR seed passphrase', () => {
  assert.equal(entropyToMnemonic(Buffer.alloc(16), wordlist), words12);
  assert.equal(Buffer.from(mnemonicToSeedSync(words12, 'TREZOR')).toString('hex'), 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04');
  assert.equal(entropyToMnemonic(Buffer.alloc(24), wordlist), `${'abandon '.repeat(17)}agent`);
  assert.equal(entropyToMnemonic(Buffer.alloc(32), wordlist), `${'abandon '.repeat(23)}art`);
});
test('OS CSPRNG generates valid, distinct 12/18/24-word phrases with frozen clocks', () => {
  const original = Date.now;
  Date.now = () => 0;
  try {
    const seen = new Set();
    for (const count of [12, 18, 24]) for (let index = 0; index < 12; index++) {
      const mnemonic = generateMnemonic(count);
      assert.equal(mnemonic.split(' ').length, count);
      assert.equal(validateMnemonic(mnemonic), true);
      assert.equal(seen.has(mnemonic), false);
      seen.add(mnemonic);
    }
  } finally { Date.now = original; }
  assert.throws(() => generateMnemonic(15));
  assert.equal(validateMnemonic('abandon '.repeat(12)), false);
  assert.equal(validateMnemonic(entropyToMnemonic(Buffer.alloc(20), wordlist)), false);
  assert.equal(validateMnemonic(null), false);
  assert.equal(normalizeMnemonic(`  ${words12.toUpperCase()} \n`), words12);
});
test('BIP32 native x-only P2PK derives recoverably without Bitcoin Taproot tweak', () => {
  const first = deriveAccount(words12);
  const recovered = deriveAccount(words12);
  const next = deriveAccount(words12, { index: 1 });
  const change = deriveAccount(words12, { change: 1 });
  const protectedSeed = deriveAccount(words12, { passphrase: 'secret seed passphrase' });
  try {
    assert.equal(first.path, "m/44'/1'/0'/0/0");
    assert.equal(first.address, recovered.address);
    assert.notEqual(first.address, next.address);
    assert.notEqual(first.address, change.address);
    assert.notEqual(first.address, protectedSeed.address);
    assert.equal(decodeAddress(first.address).toString('hex'), first.publicKey);
    assert.equal(first.publicKey, publicKeyFromPrivate(first.privateKey).toString('hex'));
    assert.throws(() => decodeAddress(first.address, 'regtest'));
    assert.throws(() => decodeAddress(first.address.slice(0, -1) + (first.address.endsWith('q') ? 'p' : 'q')));
    assert.throws(() => encodeAddress('ff'.repeat(32)));
    assert.throws(() => deriveAccount(words12, { index: -1 }));
    assert.throws(() => deriveAccount(words12, { index: 2 ** 31 }));
    assert.throws(() => deriveAccount(words12, { change: 2 }));
  } finally { for (const account of [first, recovered, next, change, protectedSeed]) account.privateKey.fill(0); }
});
test('BIP340 public key vector and randomized Schnorr signing', () => {
  const key = Buffer.alloc(32); key[31] = 3;
  const pubkey = publicKeyFromPrivate(key);
  assert.equal(pubkey.toString('hex'), 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  const digest = Buffer.alloc(32);
  const first = signSchnorr(digest, key);
  const second = signSchnorr(digest, key);
  assert.notDeepEqual(first, second);
  assert.equal(verifySchnorr(first, digest, pubkey), true);
  assert.equal(verifySchnorr(second, digest, pubkey), true);
  digest[0] = 1;
  assert.equal(verifySchnorr(first, digest, pubkey), false);
  key.fill(0);
});
