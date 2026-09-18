import { expect } from '@playwright/test';

// waitForFunction treats an async predicate's Promise as truthy in our installed
// Playwright version. Poll outside the page so a false IPC result is retried.
export async function waitForUiCondition(page, predicate, argument, { timeout = 15000, message = 'The expected UI state must become ready.' } = {}) {
  await expect.poll(() => page.evaluate(predicate, argument), {
    timeout, intervals: [25, 50, 100], message,
  }).toBe(true);
}
