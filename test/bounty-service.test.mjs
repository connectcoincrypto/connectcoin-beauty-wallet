import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverBounties, readBountyBlock } from '../src/core/bounty-discovery.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { serializeTransaction, transactionId } from '../src/core/transaction.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';

const hash = index => index.toString(16).padStart(64, '0');
const tip = height => ({ chain: 'testnet4', genesis_hash: GENESIS.testnet4, height, hash: hash(height + 1), mediantime: 1800000000 });
const window = height => ({ window: 600, tip: tip(height), blocks: Array.from({ length: Math.min(600, height + 1) }, (_, index) => ({ height: height - index, hash: hash(height - index + 1) })) });
const row = (height = 1, delta = {}) => ({ txid: hash(900), vout: 0, amount: '1000000000', domain: 'example.com', connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7, block_height: height, block_hash: hash(height + 1), coinbase: false, confirmations: 1, status: 'available', spending_txid: null, ...delta });
const page = (cursor, changes = [], has_more = false, height = 1) => ({ tip: tip(height), changes, next_cursor: cursor, has_more });

function fixture({ height = 1, changes = () => page('c0', [], false, height), windows = () => window(height), rows = new Map([[hash(2), [row()]]]) } = {}) {
  const calls = [], invalidated = [];
  let resets = 0, currentHeight = height;
  const rpc = { async request(method, params = {}, options = {}) {
    calls.push({ method, ...params });
    if (method === 'getbountychanges') return changes(params, calls);
    if (method === 'getrecentblockhashes') { const value = windows(calls); currentHeight = value.tip.height; return value; }
    if (method === 'getblockbounties') {
      const values = structuredClone(rows.get(params.block_hash) ?? []).map(value => ({ ...value, confirmations: currentHeight - value.block_height + 1 }));
      options.onChunk({ type: 'snapshot', tip: tip(currentHeight), block_hash: params.block_hash, unit: 'connects', cursor: 'stream-start' });
      options.onChunk({ type: 'bounties', tip: tip(currentHeight), items: values });
      options.onChunk({ type: 'state', tip: tip(currentHeight), cursor: 'stream-end' });
      return { chunks: 3, records: values.length };
    }
    throw new Error(`Unexpected method ${method}`);
  } };
  return { rpc, rows, calls, invalidated, get resets() { return resets; },
    run(extra = {}) { return discoverBounties({ rpc, network: 'testnet4', onInvalidate: value => invalidated.push(value), onReset: async () => { resets++; }, readBlock: (blockHash, options) => readBountyBlock({ rpc, network: 'testnet4', hash: blockHash, ...options }), ...extra }); } };
}

test('bounty discovery requests complete streams including empty blocks and publishes only after journal replay', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.blocks.size, 2);
  assert.equal(result.blocks.get(hash(2)).length, 1);
  assert.equal(result.blocks.get(hash(1)).length, 0);
  assert.equal(result.cursor, 'c0');
  assert.equal(f.calls[0].method, 'getbountychanges');
});

test('spend events without block_hash refresh their original cached block; no resurrection', async () => {
  let requests = 0;
  const f = fixture({ changes() {
    if (++requests === 2) { f.rows.set(hash(2), [row(1, { status: 'spent', spending_txid: hash(950) })]); return page('c1', [{ sequence: 1, type: 'spent', txid: hash(900), vout: 0, spending_txid: hash(950) }]); }
    return page(requests > 1 ? 'c1' : 'c0');
  } });
  const result = await f.run();
  assert.equal(result.blocks.get(hash(2))[0].status, 'spent');
  assert.equal(f.calls.filter(call => call.method === 'getblockbounties' && call.block_hash === hash(2)).length, 2);
  assert.ok(f.invalidated.some(value => value.txid === hash(900)));
});

test('all initial journal pages are consumed, including matured and available_again without block_hash', async () => {
  let calls = 0;
  const f = fixture({ changes() {
    calls++;
    if (calls === 1) return page('c1', [{ sequence: 1, type: 'pending_spend', txid: hash(900), vout: 0 }], true);
    if (calls === 2) return page('c2', [{ sequence: 2, type: 'available_again', txid: hash(900), vout: 0 }], true);
    if (calls === 3) return page('c3', [{ sequence: 3, type: 'matured', txid: hash(900), vout: 0 }]);
    return page('c3');
  } });
  const result = await f.run({ previous: new Map([[hash(2), [row(1, { status: 'immature', coinbase: true })]], [hash(1), []]]), cursor: 'c0' });
  assert.deepEqual(f.calls.filter(call => call.method === 'getbountychanges').map(call => call.cursor).slice(0, 4), ['c0', 'c1', 'c2', 'c3']);
  assert.equal(result.blocks.get(hash(2))[0].status, 'available');
  assert.equal(result.cursor, 'c3');
  assert.equal(f.resets, 0);
});

for (const mode of ['expired cursor', 'explicit resync']) test(`a ${mode} during catch-up triggers a full new snapshot`, async () => {
  let calls = 0;
  const f = fixture({ changes() {
    calls++;
    if (calls === 2) {
      f.rows.set(hash(2), [row(1, { status: 'pending_spend', spending_txid: hash(951) })]);
      if (mode === 'expired cursor') throw Object.assign(new Error('expired'), { code: -32011 });
      return page('c1', [{ sequence: 1, type: 'resync_required' }]);
    }
    return page(calls > 2 ? 'c2' : 'c0');
  } });
  const result = await f.run();
  assert.equal(result.blocks.size, 2);
  assert.equal(result.blocks.get(hash(2))[0].status, 'pending_spend');
  assert.ok(f.resets >= 2);
  assert.equal(f.calls.filter(call => call.method === 'getblockbounties' && call.block_hash === hash(2)).length, 2);
});

test('new blocks appearing during scan are incorporated before completion', async () => {
  let windows = 0;
  const f = fixture({ windows: () => window(++windows === 1 ? 1 : 2), changes: () => page('c0', [], false, 2) });
  f.rows.set(hash(3), [row(2, { txid: hash(901) })]);
  const result = await f.run();
  assert.equal(result.tip.height, 2);
  assert.equal(result.blocks.size, 3);
  assert.equal(result.blocks.get(hash(3))[0].txid, hash(901));
});

test('window exits remove queued outpoints even when they have no journal block hash', async () => {
  const obsolete = row(0, { block_hash: hash(1) });
  const f = fixture({ height: 600, rows: new Map(), changes: () => page('c1', [], false, 600) });
  const result = await f.run({ previous: new Map([[hash(1), [obsolete]]]), cursor: 'c0' });
  assert.equal(result.blocks.size, 600);
  assert.equal(result.blocks.has(hash(1)), false);
  assert.ok(f.invalidated.some(value => value.txid === obsolete.txid));
});

test('shared row budget rejects oversized streams before allocating a full flattened snapshot', async () => {
  const f = fixture(); f.rows.set(hash(2), [row(), row(1, { vout: 1 })]);
  const budget = { count: 0, limit: 1 };
  await assert.rejects(readBountyBlock({ rpc: f.rpc, network: 'testnet4', hash: hash(2), height: 1, budget }), /resource limit/);
  assert.equal(budget.count, 1);
});

test('incomplete streams, duplicate bounties and malformed cursors cannot be published', async () => {
  const f = fixture(); f.rows.set(hash(2), [row(), row()]);
  await assert.rejects(f.run(), /Duplicate bounty/);
  const rpc = { async request(method, params, { onChunk }) {
    onChunk({ type: 'snapshot', tip: tip(1), block_hash: hash(2), unit: 'connects', cursor: 'c0' });
    return { chunks: 1, records: 0 };
  } };
  await assert.rejects(readBountyBlock({ rpc, network: 'testnet4', hash: hash(2) }), /Incomplete/);
  await assert.rejects(fixture({ changes: () => page('', []) }).run(), /journal/);
  await assert.rejects(fixture({ changes: () => page('c1', [], true) }).run(), /journal/);
});

test('epoch cancellation prevents partial block data escaping discovery', async () => {
  let current = true;
  const f = fixture({ changes() { current = false; return page('c0'); } });
  await assert.rejects(f.run({ check: () => { if (!current) throw new Error('Wallet locked'); } }), /locked/);
  assert.equal(f.calls.filter(call => call.method === 'getblockbounties').length, 0);
});

function serviceFixture() {
  const account = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  account.privateKey.fill(0);
  const funding = { version: 2, locktime: 0, inputs: [{ txid: hash(999), vout: 0, sequence: 0xffffffff, scriptSig: '', witness: [] }], outputs: [{ type: 2, amount: '1000000000', domain: 'example.com', target: 'f'.repeat(64), rootVersion: 1, mask: 7 }] };
  const raw = serializeTransaction(funding).toString('hex');
  const bounty = row(1, { txid: transactionId(funding) });
  const service = new WalletService({ directory: '/unused-unit-test' });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.session = { data: {} }; service.epoch = 7;
  service.tip = tip(1);
  service.engine = { enabled: true, stopped: 0, async stop() { this.enabled = false; this.stopped++; } };
  service.claimBlocks.set(hash(2), [bounty]); service.claimOutpoints = new Map([[`${bounty.txid}:0`, bounty]]);
  service.getState = () => ({ wallet: { address: account.address } });
  service.emitState = () => {};
  service.funding = async () => raw;
  service.rpc = { async request(method) { if (method === 'getchaintip') return tip(1); throw new Error('unexpected request'); } };
  return { service, bounty };
}
function structuralProof(prepared) {
  // Only submit/cancellation is under test; full TLS authentication is tested by
  // the offline Python helper suite, and is mandatory before this method runs.
  const hello = Buffer.concat([Buffer.from('010000220303', 'hex'), Buffer.from(prepared.challenge, 'hex')]);
  return Buffer.concat([Buffer.from([2]), hello, ...[2, 8, 11, 15].map(type => Buffer.from([type, 0, 0, 0]))]).toString('hex');
}

test('prepared claims bind a spending txid and reject RPC metadata differing from funding bytes', async () => {
  const { service, bounty } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  assert.notEqual(prepared.context.txid, bounty.txid);
  assert.equal(prepared.context.txid, prepared.txid);
  assert.equal(prepared.context.validation_time, tip(1).mediantime);
  service.claimOutpoints.get(`${bounty.txid}:0`).domain = 'attacker.example';
  await assert.rejects(service.prepareAutomaticClaim(bounty), /domain differs/);
});

test('lock during funding lookup aborts claim preparation before opening any TLS connection', async () => {
  const { service, bounty } = serviceFixture();
  const funding = service.funding;
  service.funding = async () => { service.epoch++; service.session = null; return funding(); };
  await assert.rejects(service.prepareAutomaticClaim(bounty), /locked|changed/i);
});

test('unknown broadcast outcomes stop claims without awaiting the running engine itself', async () => {
  const { service, bounty } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  service.rpc.request = async method => { if (method === 'getchaintip') return tip(1); throw new Error('connection lost'); };
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), /broadcast was not confirmed/);
  await Promise.resolve();
  assert.equal(service.engine.enabled, false);
  assert.equal(service.reserved.has(`${bounty.txid}:0`), true);
  assert.match(service.error, new RegExp(prepared.txid));
});

test('an explicit consensus rejection does not masquerade as an unknown broadcast', async () => {
  const { service, bounty } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  service.rpc.request = async method => { if (method === 'getchaintip') return tip(1); throw Object.assign(new Error('node rejected'), { code: -32020, data: { node_code: -26 } }); };
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), /node rejected/i);
  assert.equal(service.engine.enabled, true);
  assert.equal(service.reserved.has(`${bounty.txid}:0`), false);
});

test('late responses from an old session cannot stop or unreserve a new session', async () => {
  const { service, bounty } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  service.rpc.request = async method => {
    if (method === 'getchaintip') return tip(1);
    service.epoch++;
    throw new Error('old connection closed after locking');
  };
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), /broadcast was not confirmed/);
  await Promise.resolve();
  assert.equal(service.engine.enabled, true);
  assert.equal(service.error, null);
  assert.equal(service.reserved.has(`${bounty.txid}:0`), true);
});
