import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForUiCondition } from '../scripts/ui-wait.mjs';

test('UI readiness retries false results from asynchronous page predicates', async () => {
  let calls = 0;
  const page = { evaluate: async (predicate, argument) => predicate(argument) };
  await waitForUiCondition(page, async expected => {
    await Promise.resolve();
    return ++calls === expected;
  }, 3, { timeout: 1000 });
  assert.equal(calls, 3);
});

test('UI readiness rejects an asynchronous predicate that never becomes true', async () => {
  const page = { evaluate: async predicate => predicate() };
  await assert.rejects(waitForUiCondition(page, async () => false, undefined, {
    timeout: 100, message: 'Boolean-only readiness fixture.',
  }), /Boolean-only readiness fixture/);
});
