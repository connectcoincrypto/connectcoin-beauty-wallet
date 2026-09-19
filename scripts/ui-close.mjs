import assert from 'node:assert/strict';
import { ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function deadline(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

const exited = child => child.exitCode !== null || child.signalCode !== null;

async function terminateTestTree(child) {
  if (exited(child)) return;
  // Playwright wraps Electron in cmd.exe on Windows, so killing only the
  // returned process would orphan Electron. Restrict taskkill to that exact
  // spawned process tree; never select by executable name or user profile.
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } catch (error) {
      if (!exited(child)) throw error;
    }
  } else {
    // Playwright launches its process in a separate process group on POSIX.
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

// app.close() exercises Electron's actual before-quit handler and waits for
// Playwright's transport/process cleanup. A deadline failure always remains a
// failed test, even if emergency cleanup subsequently terminates its child.
export async function closeElectronTest(application, { timeoutMs = 10000 } = {}) {
  if (!application) return { closeMs: 0 };
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Shutdown deadline must be a positive integer.');
  const child = application.process();
  assert.ok(child instanceof ChildProcess && Number.isSafeInteger(child.pid) && child.pid > 0,
    'Shutdown cleanup requires the actual process spawned by Playwright.');
  const started = performance.now();
  let onClose;
  const closed = exited(child) ? Promise.resolve() : new Promise(resolve => {
    onClose = resolve;
    child.once('close', onClose);
  });
  try {
    await deadline((async () => {
      await application.close();
      await closed;
      assert.equal(child.exitCode, 0, `Electron must exit cleanly (signal=${child.signalCode ?? 'none'}).`);
    })(), timeoutMs, `Electron graceful shutdown exceeded ${timeoutMs} ms.`);
    return { closeMs: Math.round(performance.now() - started) };
  } catch (error) {
    try {
      await terminateTestTree(child);
      await deadline(closed, 5000, 'The spawned test process did not close after emergency cleanup.');
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Electron shutdown failed and its test process could not be fully cleaned up.');
    }
    throw error;
  } finally {
    if (onClose) child.off('close', onClose);
  }
}
