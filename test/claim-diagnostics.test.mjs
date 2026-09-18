import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaimsEngine, createProofRunner } from '../src/core/claims.mjs';

const context = { domain: 'example.com', txid: '01'.repeat(32), input_index: 0,
  connection_work_target: 'ff'.repeat(32), root_certificates_version: 1,
  signature_algorithms_mask: 7, validation_time: 1800000000 };
const bounty = vout => ({ txid: '02'.repeat(32), vout, amount: '1000000000', domain: 'example.com', status: 'available', connection_work_target: 'f'.repeat(64), signature_algorithms_mask: 7, root_certificates_version: 1 });
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Mock claims did not finish');
}

for (const stage of ['prepare', 'proof', 'submit']) test(`diagnostics retain a ${stage} failure after the next claim clears its warning`, async t => {
  const events = [];
  const failure = Object.assign(new Error('The node rejected this claim. Its bounty or proof may no longer be valid.'), { code: -32020, data: { node_code: -26 } });
  const engine = new ClaimsEngine({
    isUnlocked: () => true,
    options: { connectionsPerSecond: 256, concurrency: 1 },
    randomIndex: () => 0,
    onDiagnostic: (event, details) => {
      events.push({ event, details });
      // The rejected outpoint leaves discovery; a per-connection worker is
      // otherwise allowed to retry TCP immediately after its one-second pause.
      if (event === 'claim.failed' && details.claimId === 1) engine.remove(bounty(0).txid, 0);
    },
    prepare: async item => {
      if (item.vout === 0 && stage === 'prepare') throw failure;
      return { item, context: { ...context, txid: (item.vout === 0 ? '01' : '03').repeat(32) } };
    },
    generateProof: async publicContext => {
      if (publicContext.txid === context.txid && stage === 'proof') throw failure;
      return '020100';
    },
    submit: async prepared => { if (prepared.item.vout === 0 && stage === 'submit') throw failure; return prepared.context.txid; },
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
  assert.equal(recorded.failures, stage === 'proof' ? 0 : 1);
  assert.ok(recorded.retryDelayMs > (stage === 'proof' ? 900 : 29000) && recorded.retryDelayMs <= (stage === 'proof' ? 1000 : 30000));
  assert.ok(recorded.durationMs >= 0);
  assert.equal(recorded.durationScope, 'stage');
  assert.equal(recorded.attempts, stage === 'prepare' ? 0 : 1);
  assert.equal(events.find(row => row.event === 'claim.succeeded').details.claimId, 2);
  assert.equal(events.find(row => row.event === 'claim.succeeded').details.durationScope, 'stage');
  assert.ok(!JSON.stringify(events).includes(context.txid));
  assert.ok(!JSON.stringify(events).includes(bounty(0).txid));
  assert.ok(!JSON.stringify(events).includes('example.com'));
});

test('throwing and rejecting diagnostic callbacks do not stop claims', async () => {
  for (const onDiagnostic of [() => { throw new Error('disk unavailable'); }, async () => { throw new Error('disk unavailable'); }]) {
    const engine = new ClaimsEngine({ isUnlocked: () => true, onDiagnostic, options: { connectionsPerSecond: 256, concurrency: 1 },
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
