import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaimsEngine, createProofRunner } from '../src/core/claims.mjs';
import { validateAttemptStats } from '../src/core/claim-priority.mjs';

const context = { domain: 'example.com', txid: '01'.repeat(32), input_index: 0,
  connection_work_target: 'ff'.repeat(32), root_certificates_version: 1,
  signature_algorithms_mask: 7, validation_time: 1800000000 };
const bounty = (vout = 0, extra = {}) => ({ txid: '02'.repeat(32), vout, amount: '1000000000',
  domain: 'example.com', status: 'available', connection_work_target: 'ff'.repeat(32),
  root_certificates_version: 1, signature_algorithms_mask: 7, ...extra });
const progress = (completed, recent, extra = {}) => ({ type: 'progress', attempts: completed,
  elapsed: 1, attemptStats: { completed, recent }, ...extra });
function runner(messages, resultExtra = {}) {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); return true; };
    child.stdin.on('finish', () => {
      for (const message of messages) {
        if (child.killed) break;
        child.stdout.write(JSON.stringify(message) + '\n');
      }
      if (!child.killed) {
        child.stdout.write(JSON.stringify({ type: 'result', context, proof: '020100', verified: true, attempts: messages.at(-1)?.attempts ?? 0, ...resultExtra }) + '\n');
        setImmediate(() => child.emit('close', 0));
      }
    });
    return child;
  };
  return createProofRunner({ helper: { command: 'isolated-mock-helper' }, spawnProcess });
}
function engineFixture(t) {
  const engine = new ClaimsEngine({ isUnlocked: () => true, randomIndex: () => 0,
    prepare: async () => ({ context }), submit: async () => context.txid, generateProof: async () => '020100' });
  t.after(() => engine.stop());
  engine.enqueue([bounty(), bounty(1, { signature_algorithms_mask: 1 })]);
  return engine;
}

test('TLS helper forwards valid cumulative completion snapshots, including zero duration and duplicate snapshots', async () => {
  const messages = [
    progress(0, []), progress(1, [[true, 0]]), progress(1, [[true, 0]]),
    progress(2, [[true, 0], [false, 3600]]),
  ];
  const observed = [];
  assert.equal(await runner(messages)(context, { onProgress: value => observed.push(value) }), '020100');
  assert.deepEqual(observed.map(value => value.attemptStats), messages.map(value => value.attemptStats));
});

test('statistics validator rejects malformed or oversized completion records', () => {
  const invalid = [
    null, false, [], {}, { completed: -1, recent: [] }, { completed: 1.5, recent: [] },
    { completed: NaN, recent: [] }, { completed: Infinity, recent: [] },
    { completed: 1001, recent: Array(100).fill([false, 0]) },
    { completed: 0, recent: [[true, 0]] }, { completed: 1, recent: [] },
    { completed: 2, recent: [[true, 1]] }, { completed: 1, recent: [null] },
    { completed: 1, recent: [[true]] }, { completed: 1, recent: [[true, 1, 2]] },
    { completed: 1, recent: [[1, 0]] }, { completed: 1, recent: [['true', 0]] },
    { completed: 1, recent: [[true, -1]] }, { completed: 1, recent: [[true, Infinity]] },
    { completed: 1, recent: [[true, NaN]] }, { completed: 1, recent: [[true, '1']] },
    { completed: 1, recent: [[true, 3600.000001]] },
    { completed: 101, recent: Array(101).fill([true, 0]) },
  ];
  for (const value of invalid) assert.throws(() => validateAttemptStats(value, 1000), /statistics/);
});

for (const [name, messages] of [
  ['mismatched total', [progress(1, [[true, 0.1]], { attempts: 2 })]],
  ['decreasing completed count', [progress(2, [[true, 0.1], [false, 0.2]]), progress(1, [[true, 0.1]])]],
  ['wrong history length', [progress(2, [[true, 0.1]])]],
  ['non-boolean capture outcome', [progress(1, [[1, 0.1]])]],
  ['negative capture time', [progress(1, [[true, -0.1]])]],
  ['over-budget capture time', [progress(1, [[true, 3601]])]],
  ['count outside configured attempt budget', [progress(1001, Array(100).fill([true, 0]))]],
]) test(`TLS helper rejects hostile ${name} instead of using it to rank domains`, async () => {
  await assert.rejects(runner(messages)(context), /attempt|statistics|sequence|progress/);
});

test('duplicate cumulative snapshots count each completed connection once and never combine exact masks', t => {
  const engine = engineFixture(t);
  const job = engine.queue.get(bounty().txid + ':0');
  let completed = engine.recordAttemptStats(job, { completed: 2, recent: [[true, 0.1], [false, 0.2]] }, 0);
  completed = engine.recordAttemptStats(job, { completed: 2, recent: [[true, 0.1], [false, 0.2]] }, completed);
  completed = engine.recordAttemptStats(job, { completed: 3, recent: [[true, 0.1], [false, 0.2], [true, 0.3]] }, completed);
  assert.equal(completed, 3);
  const stats = engine.domainStats.get('example.com:7');
  assert.deepEqual(stats.attempts, [[true, 0.1], [false, 0.2], [true, 0.3]]);
  assert.ok(Math.abs(stats.connectionRate() - 2.1 / 0.62) < 1e-12);
  assert.equal(engine.domainStats.has('example.com:1'), false);
  assert.throws(() => engine.recordAttemptStats(job, { completed: 1, recent: [[true, 1]] }, completed), /sequence/);
  assert.equal(stats.attempts.length, 3);
});

test('a telemetry gap larger than the window replaces old observations with the exact latest 100', t => {
  const engine = engineFixture(t), job = engine.queue.get(bounty().txid + ':0');
  engine.recordAttemptStats(job, { completed: 1, recent: [[false, 300]] }, 0);
  const samples = Array.from({ length: 100 }, (_, index) => [index % 2 === 0, index / 1000]);
  engine.recordAttemptStats(job, { completed: 150, recent: samples }, 1);
  assert.deepEqual(engine.domainStats.get('example.com:7').attempts, samples);
  const next = [...samples.slice(1), [true, 0.5]];
  engine.recordAttemptStats(job, { completed: 151, recent: next }, 150);
  assert.deepEqual(engine.domainStats.get('example.com:7').attempts, next);
});

test('a new helper run restarts its local completion counter without resetting shared domain history', t => {
  const engine = engineFixture(t), job = engine.queue.get(bounty().txid + ':0');
  engine.recordAttemptStats(job, { completed: 2, recent: [[true, 0.1], [false, 0.2]] }, 0);
  engine.recordAttemptStats(job, { completed: 1, recent: [[true, 0.3]] }, 0);
  assert.deepEqual(engine.domainStats.get('example.com:7').attempts, [[true, 0.1], [false, 0.2], [true, 0.3]]);
});

test('catalog retirement bounds local factors and statistics but retains an active out-of-window attempt', t => {
  const engine = engineFixture(t), first = bounty(), second = bounty(1, { signature_algorithms_mask: 1 });
  const active = engine.queue.get(first.txid + ':0');
  engine.recordAttemptStats(active, { completed: 1, recent: [[true, 0.1]] }, 0);
  const factor = active.factor;
  engine.activeKey = first.txid + ':0';
  engine.retainCatalog([second]);
  assert.equal(engine.factors.get(first.txid + ':0'), factor);
  assert.equal(engine.domainStats.has('example.com:7'), true);
  engine.activeKey = null;
  engine.retainCatalog([second]);
  assert.equal(engine.factors.has(first.txid + ':0'), false);
  assert.equal(engine.domainStats.has('example.com:7'), false);
  assert.equal(engine.factors.has(second.txid + ':1'), true);
});

test('selection-preserving discovery reset keeps factors, stats and cursors; normal clear erases them', t => {
  const engine = engineFixture(t), row = bounty(), id = row.txid + ':0';
  const job = engine.queue.get(id), factor = job.factor;
  engine.recordAttemptStats(job, { completed: 1, recent: [[true, 0.1]] }, 0);
  engine.markAssigned(job);
  const cursor = engine.domainCursors.get('example.com');
  engine.clear({ preserveSelection: true });
  assert.equal(engine.queue.size, 0);
  assert.equal(engine.factors.get(id), factor);
  assert.equal(engine.domainStats.get('example.com:7').attempts.length, 1);
  assert.strictEqual(engine.domainCursors.get('example.com'), cursor);
  engine.enqueue([row]);
  assert.equal(engine.queue.get(id).factor, factor);
  engine.clear();
  assert.equal(engine.factors.size, 0); assert.equal(engine.domainStats.size, 0);
  assert.equal(engine.domainCursors.size, 0); assert.equal(engine.preferReward, false);
});

test('old helpers missing completion telemetry fail closed instead of silently keeping the rate prior', async () => {
  await assert.rejects(runner([{ type: 'progress', attempts: 1, elapsed: 0.1 }])(context), /statistics|progress|telemetry/i);
  await assert.rejects(runner([], { attempts: 1 })(context), /statistics|attempt|telemetry|result/i);
});

for (const attempts of [undefined, null, 0, 2, -1, 1.5, '1']) test(`verified helper result requires the exact positive completed count: ${String(attempts)}`, async () => {
  await assert.rejects(runner([progress(1, [[true, 0.1]])], { attempts })(context), /attempt|result|statistics/i);
});
