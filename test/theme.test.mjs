import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, readConfig, validateConfig, writeConfig } from '../src/core/config.mjs';

test('appearance defaults to system and accepts only the three explicit choices', () => {
  assert.equal(DEFAULT_CONFIG.theme, 'system');
  assert.equal(validateConfig({}).theme, 'system');
  for (const theme of ['system', 'light', 'dark']) assert.equal(validateConfig({ theme }).theme, theme);
  for (const theme of ['', 'auto', 'Dark', ' dark', 'dark\n', 'dark\u202e', null, false, 0, [], {}, '__proto__']) {
    assert.throws(() => validateConfig({ theme }));
  }
  let accessed = false;
  assert.throws(() => validateConfig({ get theme() { accessed = true; return 'dark'; } }));
  assert.equal(accessed, false);
});

test('legacy configurations inherit system and explicit appearance persists without altering network settings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'connectwallet-theme-test-'));
  try {
    const legacy = { version: 1, network: 'testnet4', rpc: { host: '127.0.0.1', port: 18190 }, autoLockMinutes: 30 };
    await writeFile(path.join(directory, 'config.json'), JSON.stringify(legacy));
    const initial = await readConfig(directory);
    assert.equal(initial.theme, 'system');
    for (const theme of ['dark', 'light', 'system']) {
      await writeConfig(directory, { ...initial, theme });
      const loaded = await readConfig(directory);
      assert.deepEqual(loaded, { ...initial, theme });
      assert.equal(JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8')).theme, theme);
    }
    await assert.rejects(writeConfig(directory, { ...initial, theme: 'automatic' }));
    assert.equal((await readConfig(directory)).theme, 'system');
  } finally {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
    assert.ok(path.basename(absolute).startsWith('connectwallet-theme-test-'));
    await rm(absolute, { recursive: true, force: true });
  }
});
