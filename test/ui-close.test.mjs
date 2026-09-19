import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeElectronTest } from '../scripts/ui-close.mjs';

async function fixtureApplication(close) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    process.on('message', message => {
      if (message === 'shutdown') process.disconnect();
    });
    process.send('ready');
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: process.platform !== 'win32', windowsHide: true });
  await once(child, 'message');
  return { process: () => child, close: () => close(child) };
}

test('UI teardown waits for successful graceful exit and clears its deadline', async () => {
  let requested = false;
  const application = await fixtureApplication(child => {
    requested = true;
    child.send('shutdown');
  });
  const result = await closeElectronTest(application, { timeoutMs: 2000 });
  assert.equal(requested, true);
  assert.equal(application.process().exitCode, 0);
  assert.ok(result.closeMs < 2000);
});

test('UI teardown timeout fails and reaps only its spawned test process', async () => {
  const sibling = await fixtureApplication(child => child.send('shutdown'));
  const application = await fixtureApplication(() => new Promise(() => {}));
  try {
    await assert.rejects(closeElectronTest(application, { timeoutMs: 100 }), /graceful shutdown exceeded 100 ms/);
    assert.ok(application.process().exitCode !== null || application.process().signalCode !== null);
    assert.equal(sibling.process().exitCode, null, 'An unrelated process running the same executable must remain alive.');
    assert.equal(sibling.process().signalCode, null);
    assert.equal(sibling.process().connected, true);
  } finally { await closeElectronTest(sibling); }
});

test('UI teardown preserves close errors after cleaning up its spawned child', async () => {
  const failure = new Error('shutdown fixture failed');
  const application = await fixtureApplication(() => { throw failure; });
  await assert.rejects(closeElectronTest(application), error => error === failure);
  assert.ok(application.process().exitCode !== null || application.process().signalCode !== null);
});
