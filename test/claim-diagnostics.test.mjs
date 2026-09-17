import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaimsEngine, createProofRunner } from '../src/core/claims.mjs';

const context = { domain: 'example.com', txid: '01'.repeat(32), input_index: 0,
  connection_work_target: 'ff'.repeat(32), root_certificates_version: 1,
  signature_algorithms_mask: 7, validation_time: 1800000000 };
const bounty = vout => ({ txid: '02'.repeat(32), vout, domain: 'example.com', status: 'available' });
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Mock claims did not finish');
}

for (const stage of ['prepare', 'proof', 'submit']) test(`diagnostics retain a ${stage} failure after the next claim clears its warning`, async t => {
  const events = [];
  let active;
  const failure = Object.assign(new Error('The node rejected this claim. Its bounty or proof may no longer be valid.'), { code: -32020, data: { node_code: -26 } });
  const engine = new ClaimsEngine({
    isUnlocked: () => true,
    onDiagnostic: (event, details) => events.push({ event, details }),
    prepare: async item => {
      active = item.vout;
      if (active === 0 && stage === 'prepare') throw failure;
      return { context };
    },
    generateProof: async (_, { onProgress }) => {
      onProgress({ attempts: 7, elapsed: 0.01 });
      if (active === 0 && stage === 'proof') throw failure;
      return '020100';
    },
    submit: async () => { if (active === 0 && stage === 'submit') throw failure; return context.txid; },
  });
  t.after(() => engine.stop());
  engine.enqueue([bounty(0), bounty(1)]); engine.start();
  await until(() => engine.snapshot().completed === 1 && !engine.running);
  assert.equal(engine.enabled, true);
  assert.equal(engine.snapshot().lastError, null);
  const recorded = events.find(row => row.event === 'claim.failed').details;
  assert.equal(recorded.stage, stage);
  assert.equal(recorded.claimId, 1);
  assert.equal(recorded.error.code, -32020);
  assert.equal(recorded.error.data.node_code, -26);
  assert.equal(recorded.failures, 1);
  assert.ok(recorded.retryDelayMs > 29000 && recorded.retryDelayMs <= 30000);
  assert.ok(recorded.durationMs >= 0);
  assert.equal(recorded.attempts, stage === 'prepare' ? 0 : 7);
  assert.equal(events.find(row => row.event === 'claim.succeeded').details.claimId, 2);
  assert.ok(!JSON.stringify(events).includes(context.txid));
  assert.ok(!JSON.stringify(events).includes(bounty(0).txid));
  assert.ok(!JSON.stringify(events).includes('example.com'));
});

test('throwing and rejecting diagnostic callbacks do not stop claims', async () => {
  for (const onDiagnostic of [() => { throw new Error('disk unavailable'); }, async () => { throw new Error('disk unavailable'); }]) {
    const engine = new ClaimsEngine({ isUnlocked: () => true, onDiagnostic,
      prepare: async () => ({ context }), generateProof: async () => '020100', submit: async () => context.txid });
    try {
      engine.enqueue([bounty(0)]); engine.start();
      await until(() => engine.snapshot().completed === 1);
      assert.equal(engine.enabled, true);
    } finally { await engine.stop(); }
  }
});

test('helper failure metadata counts but never copies stderr or partial proof output', async () => {
  const events = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('finish', () => {
      child.stderr.write('private-helper-stderr-canary');
      child.emit('close', 7);
    });
    return child;
  };
  const runner = createProofRunner({ helper: { command: 'mock' }, spawnProcess,
    onDiagnostic: (event, details) => events.push({ event, details }) });
  await assert.rejects(runner(context), /without a verified proof/);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'helper.failed');
  assert.equal(events[0].details.exitCode, 7);
  assert.equal(events[0].details.stderrBytes, Buffer.byteLength('private-helper-stderr-canary'));
  assert.ok(!JSON.stringify(events).includes('private-helper-stderr-canary'));
});
