import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StatePublisher } from '../src/core/state-publisher.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';

function clock() {
  let time = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const timer = { unref() {} };
      timers.set(timer, { callback, at: time + delay });
      return timer;
    },
    clearTimer: timer => timers.delete(timer),
    get pending() { return timers.size; },
    advance(ms) {
      time += ms;
      for (const [timer, entry] of [...timers]) if (entry.at <= time && timers.delete(timer)) entry.callback();
    },
  };
}

test('publication bursts build only the newest snapshot at a bounded five updates per second', () => {
  const scheduler = clock(), observed = [];
  let latest = 0;
  const publisher = new StatePublisher({ ...scheduler, publish: () => observed.push(latest) });
  publisher.request();
  for (latest = 1; latest <= 1000; latest++) publisher.request();
  latest = 1000;
  assert.deepEqual(observed, [0]);
  assert.equal(scheduler.pending, 1);
  scheduler.advance(199);
  assert.deepEqual(observed, [0]);
  scheduler.advance(1);
  assert.deepEqual(observed, [0, 1000]);
  assert.equal(scheduler.pending, 0);
  for (let second = 0; second < 5; second++) {
    for (let i = 0; i < 1000; i++) { latest++; publisher.request(); }
    scheduler.advance(200);
  }
  assert.equal(observed.length, 7);
  assert.equal(observed.at(-1), 6000);
  publisher.close();
});

test('immediate transitions discard the pending event and cannot replay its old snapshot', () => {
  const scheduler = clock(), observed = [];
  let latest = 'unlocked';
  const publisher = new StatePublisher({ ...scheduler, publish: () => observed.push(latest) });
  publisher.request();
  latest = 'private progress'; publisher.request();
  assert.equal(scheduler.pending, 1);
  latest = 'locked'; publisher.request({ immediate: true });
  assert.equal(scheduler.pending, 0);
  scheduler.advance(1000);
  assert.deepEqual(observed, ['unlocked', 'locked']);
  latest = 'shutdown'; publisher.request(); publisher.request();
  publisher.close();
  assert.equal(scheduler.pending, 0);
  publisher.request({ immediate: true }); scheduler.advance(1000);
  assert.equal(observed.at(-1), 'shutdown');
});

function serviceFixture() {
  const scheduler = clock();
  const service = new WalletService({
    directory: '.', proofRunner: async () => '020100',
    clientFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.walletExists = true;
  service.session = { data: { name: 'Fixture', receiveIndex: 0 } };
  service.epoch = 1;
  service.createEngine();
  service.statePublisher.close();
  let snapshots = 0;
  const originalGetState = service.getState.bind(service);
  service.getState = () => { snapshots++; return originalGetState(); };
  service.statePublisher = new StatePublisher({ ...scheduler, publish: () => service.emit('state', service.getState()) });
  const states = [];
  service.on('state', state => states.push(state));
  return { service, scheduler, states, get snapshots() { return snapshots; } };
}

test('one thousand claim updates coalesce before WalletService constructs full state', async () => {
  const fixture = serviceFixture(), { service, scheduler, states } = fixture;
  service.emitState();
  for (let attempts = 1; attempts <= 1000; attempts++) service.engine.notify({ attempts });
  assert.equal(fixture.snapshots, 1);
  assert.equal(states.length, 1);
  assert.equal(scheduler.pending, 1);
  scheduler.advance(200);
  assert.equal(fixture.snapshots, 2);
  assert.equal(states.at(-1).claims.attempts, 1000);
  await service.close();
});

test('transient failure and retry bursts coalesce without delaying a fatal error', async () => {
  const fixture = serviceFixture(), { service, scheduler, states } = fixture;
  service.engine.enabled = true; service.engine.notify({ status: 'searching' });
  const job = { diagnosticId: 1, failures: 0 };
  for (let attempt = 0; attempt < 1000; attempt++) {
    service.engine.jobError(job, new Error('TLS capture or proof validation failed'), 'proof', false);
    service.engine.notify({ status: 'waiting' });
    service.engine.notify({ status: 'submitting' });
    service.engine.notify({ status: 'searching', lastError: null });
  }
  assert.equal(fixture.snapshots, 1, 'failed attempts must not bypass the progress throttle');
  service.engine.jobError(job, new Error('TLS capture or proof validation failed'), 'proof', false);
  scheduler.advance(200);
  assert.equal(fixture.snapshots, 2);
  assert.equal(states.at(-1).claims.status, 'retrying');
  assert.equal(states.at(-1).claims.lastError, 'TLS capture or proof validation failed', 'a sustained retry warning remains available');
  assert.equal(states.at(-1).claims.lastErrorTransient, true);
  service.engine.fatal(Object.assign(new Error('Broadcast outcome unknown.'), { unknownOutcome: true }));
  assert.equal(states.at(-1).claims.enabled, false);
  assert.equal(states.at(-1).claims.lastError, 'Broadcast outcome unknown.');
  assert.equal(states.at(-1).claims.lastErrorTransient, false);
  assert.equal(states.at(-1).claims.lastErrorDiagnostic, false);
  scheduler.advance(200);
  assert.equal(states.at(-1).claims.enabled, false);
  assert.equal(states.at(-1).claims.lastError, 'Broadcast outcome unknown.');
  await service.close();
});

test('lock is immediate despite progress backlog, and close releases the final timer', async () => {
  const { service, scheduler, states } = serviceFixture();
  service.emitState();
  service.history = [{ txid: 'private-history-fixture' }];
  service.emitState();
  assert.equal(scheduler.pending, 1);
  let finishStop;
  const originalStop = service.engine.stop.bind(service.engine);
  service.engine.stop = () => new Promise(resolve => { finishStop = resolve; });
  const locking = service.lock();
  assert.equal(states.at(-1).phase, 'locked');
  assert.equal(states.at(-1).wallet, null);
  assert.deepEqual(states.at(-1).history, []);
  assert.equal(scheduler.pending, 0);
  const lockIndex = states.length - 1;
  finishStop(); await locking;
  scheduler.advance(1000);
  assert.ok(states.slice(lockIndex).every(state => state.phase === 'locked' && state.wallet === null && state.history.length === 0));
  service.engine.stop = originalStop;
  service.emitState();
  await service.close();
  const count = states.length;
  assert.equal(scheduler.pending, 0);
  scheduler.advance(1000); service.emitState();
  assert.equal(states.length, count);
});

test('critical errors, stopped claims and Developer Mode bypass progress delay', async () => {
  const { service, scheduler, states } = serviceFixture();
  service.engine.enabled = true;
  service.emitState();
  service.engine.notify({ attempts: 20 });
  service.engine.notify({ lastError: 'Broadcast outcome unknown.', lastErrorDiagnostic: false });
  assert.equal(states.at(-1).claims.lastError, 'Broadcast outcome unknown.');
  assert.equal(scheduler.pending, 0);
  const beforeStop = states.length;
  await service.engine.stop();
  assert.equal(states.length, beforeStop + 1);
  assert.equal(states.at(-1).claims.enabled, false);
  service.config.developerMode = true; service.emitState();
  assert.equal(states.at(-1).config.developerMode, true);
  service.error = 'RPC disconnected'; service.emitState();
  assert.equal(states.at(-1).error, 'RPC disconnected');
  await service.close();
});
