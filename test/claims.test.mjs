import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaimsEngine, createProofRunner, validateClaimContext, validateClaimOptions } from '../src/core/claims.mjs';

const context = () => ({ domain: 'example.com', txid: '01'.repeat(32), input_index: 0, connection_work_target: 'ff'.repeat(32), root_certificates_version: 1, signature_algorithms_mask: 7, validation_time: 1800000000 });
const bounty = (vout = 0) => ({ txid: '02'.repeat(32), vout, domain: 'example.com', status: 'available' });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('Timed out waiting for claims state'); }

test('claims options are finite and public context cannot smuggle private fields', () => {
  assert.equal(validateClaimOptions().concurrency, 100);
  assert.equal(validateClaimOptions().connectionsPerSecond, 100);
  for (const options of [{ concurrency: 0 }, { concurrency: 257 }, { connectionsPerSecond: -1 }, { overallTimeout: Infinity }, { maxAttempts: 0 }, { allowPrivate: true }]) assert.throws(() => validateClaimOptions(options));
  for (const delta of [{ domain: '127.0.0.1/evil' }, { domain: 'wallet.local' }, { domain: 'EXAMPLE.com' }, { domain: 'localhost' }, { root_certificates_version: 2 }, { signature_algorithms_mask: 0 }, { validation_time: 0 }, { password: 'not permitted' }]) assert.throws(() => validateClaimContext({ ...context(), ...delta }));
  assert.deepEqual(validateClaimContext(context()), context());
});

function fakeSpawn(send) {
  const capture = {};
  return { capture, spawnProcess(command, args, options) {
    Object.assign(capture, { command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; capture.killed = true; setImmediate(() => child.emit('close', null)); return true; };
    let input = '';
    child.stdin.on('data', (chunk) => { input += chunk.toString(); });
    child.stdin.on('finish', () => { capture.request = JSON.parse(input); send(child, capture.request); });
    return child;
  } };
}
const validResult = (request) => ({ type: 'result', context: request.context, proof: '020100', verified: true });

test('proof runner sends only public context via stdin, no shell; requires verified matching result and clean exit', async () => {
  const fixture = fakeSpawn((child, request) => {
    child.stdout.write(`${JSON.stringify(validResult(request))}\n`);
    child.emit('close', 0);
  });
  const runner = createProofRunner({ ...fixture, helper: { command: '/private/helper', args: [] } });
  assert.equal(await runner(context()), '020100');
  assert.equal(fixture.capture.options.shell, false);
  assert.equal(fixture.capture.options.env.PYTHONPATH, undefined);
  assert.equal(fixture.capture.options.env.CONNECTCOIN_RPC_PASSWORD, undefined);
  assert.deepEqual(Object.keys(fixture.capture.request).sort(), ['context', 'options']);
  assert.equal(fixture.capture.request.context.txid, context().txid);
  assert.equal(fixture.capture.request.options.connectionsPerSecond, 100);
  assert.equal(fixture.capture.request.options.concurrency, 100);
});

test('proof runner rejects tampered contexts, oversized frames, unknown messages, partial output, and nonzero exit', async () => {
  const cases = [
    (request) => `${JSON.stringify({ ...validResult(request), context: { ...request.context, txid: '03'.repeat(32) } })}\n`,
    (request) => `${JSON.stringify({ ...validResult(request), verified: false })}\n`,
    () => 'x'.repeat(170000),
    () => '{"type":"please-sign","privateKey":true}\n',
    (request) => JSON.stringify(validResult(request)),
  ];
  for (const makeResponse of cases) {
    const fixture = fakeSpawn((child, request) => { child.stdout.write(makeResponse(request)); setImmediate(() => child.emit('close', 0)); });
    await assert.rejects(createProofRunner({ ...fixture, helper: { command: 'test' } })(context()));
  }
  const fixture = fakeSpawn((child, request) => { child.stdout.write(`${JSON.stringify(validResult(request))}\n`); child.emit('close', 1); });
  await assert.rejects(createProofRunner({ ...fixture, helper: { command: 'test' } })(context()));
});

test('aborting a TLS search terminates its helper and rejects after exit', async () => {
  const fixture = fakeSpawn(() => {});
  const abort = new AbortController();
  const promise = createProofRunner({ ...fixture, helper: { command: 'test' } })(context(), { signal: abort.signal });
  abort.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(fixture.capture.killed, true);
});

test('engine is opt-in, deduplicates bounties, preserves prepared txid, and submits once', async () => {
  let prepares = 0;
  let submits = 0;
  const engine = new ClaimsEngine({
    isUnlocked: () => true,
    prepare: async (item) => { prepares++; return { context: context(), item, immutableTransaction: 'fixed' }; },
    generateProof: async (ctx) => { assert.equal(ctx.txid, context().txid); assert.notEqual(ctx.txid, bounty().txid); return '020100'; },
    submit: async (prepared, proof) => { assert.equal(prepared.immutableTransaction, 'fixed'); assert.equal(proof, '020100'); submits++; return prepared.context.txid; },
  });
  assert.equal(engine.enqueue([bounty(), bounty(), { ...bounty(1), status: 'spent' }]), 1);
  await tick();
  assert.equal(prepares, 0);
  engine.start();
  await until(() => engine.snapshot().completed === 1);
  await engine.stop();
  assert.equal(submits, 1);
  assert.equal(engine.enqueue([bounty()]), 0);
});

test('wallet lock during generation never submits a found proof', async () => {
  let unlocked = true;
  let resolveProof;
  let submitted = false;
  const engine = new ClaimsEngine({ isUnlocked: () => unlocked, prepare: async () => ({ context: context() }), generateProof: () => new Promise((resolve) => { resolveProof = resolve; }), submit: async () => { submitted = true; } });
  engine.enqueue([bounty()]);
  engine.start();
  await until(() => resolveProof);
  unlocked = false;
  resolveProof('020100');
  await until(() => !engine.running);
  assert.equal(submitted, false);
  assert.equal(engine.enabled, false);
  await engine.stop();
});

test('stop aborts active work and forbids another worker until cleanup', async () => {
  let started = false;
  let release;
  let submitted = false;
  const engine = new ClaimsEngine({ isUnlocked: () => true, prepare: async () => ({ context: context() }), generateProof: (_, { signal }) => new Promise((resolve, reject) => { started = true; signal.addEventListener('abort', () => { release = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); }); }), submit: async () => { submitted = true; } });
  engine.enqueue([bounty()]); engine.start();
  await until(() => started);
  const stopped = engine.stop();
  assert.throws(() => engine.start(), /previous claims worker/);
  release();
  await stopped;
  assert.equal(submitted, false);
  assert.equal(engine.running, null);
});

test('bounded queue, backoff and unavailable bounties avoid flooding and stale broadcasts', async () => {
  let attempts = 0;
  const engine = new ClaimsEngine({ isUnlocked: () => true, maxQueue: 2, retryDelayMs: 300000, prepare: async () => { attempts++; throw new Error('bounty unavailable'); }, generateProof: async () => { throw new Error('must not generate'); }, submit: async () => { throw new Error('must not submit'); } });
  assert.equal(engine.enqueue([bounty(), bounty(1), bounty(2)]), 2);
  engine.start();
  await until(() => attempts === 2 && !engine.running);
  await tick();
  assert.equal(attempts, 2);
  engine.remove(bounty().txid, 0);
  assert.equal(engine.snapshot().queued, 1);
  await engine.stop();
  engine.setOptions({ connectionsPerSecond: 100, concurrency: 100 });
  assert.equal(engine.snapshot().options.connectionsPerSecond, 100);
});

test('locked wallet cannot start or submit queued claims', () => {
  const engine = new ClaimsEngine({ isUnlocked: () => false, prepare: async () => {}, submit: async () => {} });
  engine.enqueue([bounty()]);
  assert.throws(() => engine.start(), /Unlock/);
  assert.equal(engine.enabled, false);
});

test('discovery suspension preserves opt-in but prevents queued work until a complete snapshot', async () => {
  let prepared = 0;
  const engine = new ClaimsEngine({ isUnlocked: () => true, prepare: async () => { prepared++; return { context: context() }; }, generateProof: async () => '020100', submit: async () => context().txid });
  await engine.suspend();
  engine.enqueue([bounty()]); engine.start();
  await tick();
  assert.equal(engine.enabled, true);
  assert.equal(prepared, 0);
  engine.resume();
  await until(() => engine.snapshot().completed === 1);
  await engine.suspend(); await engine.stop(); engine.resume();
  engine.enqueue([bounty(1)]);
  await tick();
  assert.equal(prepared, 1);
  assert.equal(engine.enabled, false);
});
