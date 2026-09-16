import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, GENESIS, readConfig, validateConfig, validateRpcEndpoint, validateTip, writeConfig } from '../src/core/config.mjs';

test('config defaults use plaintext ConnectCoin4 TCP and strip unrelated/secret fields', () => {
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(validateConfig({ rpc: { host: 'CONNECTCOIN4.COM', password: 'secret' }, mnemonic: 'never save this' }), DEFAULT_CONFIG);
  assert.equal(validateConfig(JSON.parse('{"__proto__":{"network":"main"}}')).network, 'testnet4');
  assert.equal(Object.prototype.network, undefined);
  assert.throws(() => validateConfig(Object.create({ rpc: { host: 'evil' } })), /plain/);
  assert.throws(() => validateConfig({ get rpc() { throw new Error('executed'); } }), /plain/);
  assert.throws(() => validateConfig({ rpc: false }), /plain/);
  assert.throws(() => validateConfig({ rpc: null }), /plain/);
  assert.throws(() => validateConfig({ claims: [] }), /plain/);
  assert.throws(() => { DEFAULT_CONFIG.rpc.host = 'evil'; });
});
test('endpoint validation supports IPv4/IPv6 and rejects URLs, Unicode control text and bad ports', () => {
  for (const host of ['127.0.0.1', '::1', '2001:db8::1', 'node.example', 'localhost']) assert.equal(validateRpcEndpoint({ host, port: 48190 }).host, host);
  for (const host of ['https://node.example', 'node.example/path', 'node.example:48190', '[::1]', '999.2.3.4', 'example..com', 'example.com.', '-example.com', 'x'.repeat(64) + '.com', 'abc\n.com', 'bücher.example', 'abc\u202e.com', 'fe80::1%eth0', '']) assert.throws(() => validateRpcEndpoint({ host, port: 48190 }));
  for (const port of [0, 65536, -1, 1.5, '48190', Infinity, NaN]) assert.throws(() => validateRpcEndpoint({ host: 'localhost', port }));
});
test('network, claims, fee and lock bounds are explicit and testnet only by default', () => {
  assert.throws(() => validateConfig({ network: 'main' }), /testnet4/);
  assert.throws(() => validateConfig({ network: 'regtest' }), /testnet4/);
  assert.equal(validateConfig({ network: 'regtest' }, { allowRegtest: true }).network, 'regtest');
  for (const input of [{ version: 2 }, { autoLockMinutes: 0 }, { autoLockMinutes: 61 }, { feeRate: 1200 }, { feeRate: 100001 }, { claims: { maxConcurrent: 0 } }, { claims: { maxConnectionsPerSecond: 257 } }, { claims: { lookbackBlocks: 601 } }]) assert.throws(() => validateConfig(input));
});
test('chain tip validates network and pinned genesis, including height-zero consistency', () => {
  const tip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, height: 12, hash: 'a'.repeat(64), mediantime: 1789136800 };
  assert.deepEqual(validateTip(tip), tip);
  for (const changed of [{ chain: 'main' }, { genesis_hash: 'b'.repeat(64) }, { height: -1 }, { height: '12' }, { hash: 'q'.repeat(64) }, { mediantime: Infinity }, { height: 0 }]) assert.throws(() => validateTip({ ...tip, ...changed }));
  assert.throws(() => validateTip(tip, '__proto__'));
  assert.throws(() => validateTip(Object.create(tip)));
  assert.deepEqual(validateTip({ ...tip, height: 0, hash: GENESIS.testnet4 }).hash, GENESIS.testnet4);
});
test('config file creation is bounded, atomic, sanitized and rejects malformed UTF8', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beauty-config-test-'));
  try {
    assert.deepEqual(await readConfig(directory), DEFAULT_CONFIG);
    await writeConfig(directory, { rpc: { host: '127.0.0.1', port: 18000 }, mnemonic: 'must not persist' });
    assert.equal((await readConfig(directory)).rpc.port, 18000);
    assert.equal((await readFile(path.join(directory, 'config.json'), 'utf8')).includes('must not persist'), false);
    assert.deepEqual(await readdir(directory), ['config.json']);
    await writeFile(path.join(directory, 'config.json'), 'x'.repeat(16385));
    await assert.rejects(readConfig(directory), /too large/);
    await writeFile(path.join(directory, 'config.json'), Buffer.from([0xff]));
    await assert.rejects(readConfig(directory));
  } finally {
    assert.ok(path.basename(directory).startsWith('beauty-config-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
