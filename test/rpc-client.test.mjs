import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { RpcClient, RpcError, validateRpcParams } from '../src/core/rpc.mjs';

const hash = 'a'.repeat(64);
const line = message => `${JSON.stringify(message)}\n`;
const response = (request, result) => ({ jsonrpc: '2.0', id: request.id, result });
const note = (method, params) => ({ jsonrpc: '2.0', method, params });
async function mock(handler, options = {}) {
  const sockets = new Set(), requests = [];
  let connections = 0;
  const server = net.createServer(socket => {
    connections++; sockets.add(socket);
    socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        requests.push(request); handler(request, socket, requests);
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new RpcClient({ host: '127.0.0.1', port: server.address().port, timeoutMs: 1000, ...options });
  return { client, requests, get connections() { return connections; }, async close() {
    client.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TEST: stranded RPC promise')), 400); })]); }
  finally { clearTimeout(timer); }
}

test('method/parameter allowlist cannot leak secrets or invoke getters', () => {
  for (const method of ['getblocktemplate', 'stop', '__proto__', 'constructor']) assert.throws(() => validateRpcParams(method, {}), /not allowed/);
  assert.throws(() => validateRpcParams('getchaintip', { mnemonic: 'secret' }), /Unexpected/);
  assert.throws(() => validateRpcParams('gettransaction', { txid: hash, password: 'secret' }), /Unexpected/);
  assert.throws(() => validateRpcParams('gettransaction', { get txid() { throw new Error('getter executed'); } }), /plain data/);
  assert.throws(() => validateRpcParams('gettransaction', Object.create({ txid: hash })), /Unexpected/);
  assert.throws(() => validateRpcParams('gettransaction', { txid: { toJSON: () => hash } }), /Invalid/);
  assert.throws(() => validateRpcParams('getchaintip', []), /Unexpected/);
  assert.throws(() => validateRpcParams('getchaintip', JSON.parse('{"__proto__":{"mnemonic":"secret"}}')), /Unexpected/);
  assert.deepEqual(validateRpcParams('gettransaction', { txid: hash.toUpperCase() }), { txid: hash });
  assert.throws(() => validateRpcParams('getaddressbalance', { address: 'tcc1p\u202eaddress' }));
  assert.throws(() => validateRpcParams('getbountychanges', { cursor: 'x'.repeat(1025) }));
  assert.throws(() => validateRpcParams('sendrawtransaction', { transaction_hex: '00'.repeat(400001) }));
  assert.deepEqual(validateRpcParams('getbountychanges', { cursor: null }), { cursor: null });
});

test('concurrent requests share one connection; chunk fragmentation is reassembled', async () => {
  const server = await mock((request, socket) => {
    const encoded = line(response(request, { method: request.method }));
    if (request.method === 'getchaintip') { socket.write(encoded.slice(0, 8)); setTimeout(() => socket.write(encoded.slice(8)), 5); }
    else setTimeout(() => socket.write(encoded), 10);
  });
  try {
    const results = await Promise.all([server.client.request('getchaintip'), server.client.request('getrecentblockhashes')]);
    assert.deepEqual(results.map(result => result.method), ['getchaintip', 'getrecentblockhashes']);
    assert.equal(server.connections, 1); assert.equal(server.client.pending.size, 0);
  } finally { await server.close(); }
});

test('bounty stream initial reply and all notifications may arrive in the same chunk', async () => {
  const server = await mock((request, socket) => socket.write([
    response(request, { stream_id: 's1' }),
    note('stream.chunk', { stream_id: 's1', sequence: 0, items: { type: 'snapshot', block_hash: hash } }),
    note('stream.chunk', { stream_id: 's1', sequence: 1, items: { type: 'bounties', items: [{ txid: hash }] } }),
    note('stream.chunk', { stream_id: 's1', sequence: 2, items: { type: 'state' } }),
    note('stream.end', { stream_id: 's1', chunks: 3, complete: true }),
  ].map(line).join('')));
  const chunks = [];
  try {
    const result = await server.client.request('getblockbounties', { block_hash: hash }, { onChunk: item => chunks.push(item) });
    assert.deepEqual(result, { chunks: 3, records: 1 });
    assert.deepEqual(chunks.map(chunk => chunk.type), ['snapshot', 'bounties', 'state']);
    assert.equal(server.client.pending.size, 0); assert.equal(server.client.streams.size, 0);
  } finally { await server.close(); }
});

test('malformed stream IDs reject promptly rather than leaving an untracked promise', async () => {
  for (const result of [{}, { stream_id: '' }, { stream_id: 1 }, { stream_id: 'x'.repeat(129) }]) {
    const server = await mock((request, socket) => socket.write(line(response(request, result))));
    try {
      await assert.rejects(bounded(server.client.request('getblockbounties', { block_hash: hash }, { onChunk() {} })), /invalid or oversized/);
      assert.equal(server.client.pending.size, 0); assert.equal(server.client.streams.size, 0);
    } finally { await server.close(); }
  }
});

test('stream sequence errors, missing snapshot, and callback failures tear down affected requests', async () => {
  for (const mode of ['sequence', 'snapshot', 'callback']) {
    const server = await mock((request, socket) => socket.write([
      response(request, { stream_id: 'stream' }), note('stream.chunk', { stream_id: 'stream', sequence: mode === 'sequence' ? 1 : 0, items: { type: mode === 'snapshot' ? 'state' : 'snapshot' } }),
    ].map(line).join('')));
    try {
      await assert.rejects(bounded(server.client.request('getblockbounties', { block_hash: hash }, { onChunk() { if (mode === 'callback') throw new Error('Bad bounty'); } })), /invalid or oversized/);
      assert.equal(server.client.pending.size, 0); assert.equal(server.client.streams.size, 0);
    } finally { await server.close(); }
  }
});

test('incomplete stream reports failure and does not claim a complete block', async () => {
  const server = await mock((request, socket) => socket.write([
    response(request, { stream_id: 's' }), note('stream.chunk', { stream_id: 's', sequence: 0, items: { type: 'snapshot' } }),
    note('stream.end', { stream_id: 's', chunks: 1, complete: false, error: { code: -32001 } }),
  ].map(line).join('')));
  try { await assert.rejects(server.client.request('getblockbounties', { block_hash: hash }, { onChunk() {} }), /incomplete/); }
  finally { await server.close(); }
});

test('invalid envelopes, UTF8, and oversized unframed messages fail closed', async () => {
  for (const malformed of [
    request => line({ jsonrpc: '2.0', id: request.id, result: 1, error: { code: -1, message: 'bad' } }),
    request => line({ jsonrpc: '2.0', id: request.id, error: {} }),
    request => line({ jsonrpc: '2.0', id: request.id + 1, result: null }),
    () => Buffer.from([0xff, 10]),
    () => Buffer.alloc(2 * 1024 * 1024 + 1, 65),
  ]) {
    const server = await mock((request, socket) => socket.write(malformed(request)));
    try { await assert.rejects(bounded(server.client.request('getchaintip')), /invalid or oversized/); }
    finally { await server.close(); }
  }
});

test('timeout and transport loss make broadcast outcome explicitly unknown, with no retry', async () => {
  for (const close of [true, false]) {
    const server = await mock((_request, socket) => { if (close) socket.destroy(); }, { timeoutMs: 50 });
    try {
      await assert.rejects(server.client.request('sendrawtransaction', { transaction_hex: '00'.repeat(20) }), error => error.unknownOutcome && /unknown/.test(error.message));
      await delay(30); assert.equal(server.requests.length, 1); assert.equal(server.connections, 1);
    } finally { await server.close(); }
  }
});

test('RPC not-ready and rate limit errors retain structured codes; future request obeys cooldown', async () => {
  const times = [];
  const server = await mock((request, socket, requests) => {
    times.push(performance.now());
    socket.write(line(requests.length === 1 ? { jsonrpc: '2.0', id: request.id, error: { code: -32029, message: 'Rate limited', data: { retry_after_ms: 80 } } } : response(request, true)));
  });
  try {
    await assert.rejects(server.client.request('getchaintip'), error => error instanceof RpcError && error.code === -32029);
    assert.equal(await server.client.request('getchaintip'), true);
    assert.ok(times[1] - times[0] >= 70);
  } finally { await server.close(); }
  const notReady = await mock((request, socket) => socket.write(line({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Not ready' } })));
  try { await assert.rejects(notReady.client.request('getchaintip'), error => error.code === -32001); }
  finally { await notReady.close(); }
});

test('quota survives reconnection and block quotas are canonical per block', async () => {
  const times = [];
  const server = await mock((request, socket) => { times.push(performance.now()); socket.write(line(response(request, true))); }, { quota: 1, windowMs: 100 });
  try {
    await server.client.request('getchaintip');
    const oldClosed = once(server.client, 'disconnected'); server.client.socket.destroy(); await oldClosed;
    await server.client.request('getchaintip');
    assert.ok(times[1] - times[0] >= 90); assert.equal(server.connections, 2);
    assert.equal(server.client.history.get('getchaintip').length, 1);
    await server.client.pace('getblockbounties', { block_hash: hash });
    await server.client.pace('getblockbounties', { block_hash: 'b'.repeat(64) });
    assert.equal(server.client.history.get(`getblockbounties:${hash}`).length, 1);
  } finally { await server.close(); }
});

test('queued parameters are snapshotted, close aborts pace waiters, connection-close race settles', async () => {
  const server = await mock((request, socket) => socket.write(line(response(request, request.params))), { quota: 1, windowMs: 1000 });
  try {
    const params = { txid: hash };
    const first = server.client.request('gettransaction', params); params.txid = 'b'.repeat(64);
    assert.deepEqual(await first, { txid: hash });
    const waiting = server.client.request('gettransaction', { txid: hash });
    const assertion = assert.rejects(bounded(waiting), /abort|closed/i);
    server.client.close(); await assertion; assert.equal(server.client.queuedRequests, 0);
  } finally { await server.close(); }
  const race = await mock((request, socket) => socket.write(line(response(request, true))));
  try {
    race.client.once('connected', () => race.client.close());
    await assert.rejects(bounded(race.client.request('getchaintip')), /closed/);
  } finally { await race.close(); }
});
