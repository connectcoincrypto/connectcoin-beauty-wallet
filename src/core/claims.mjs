import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTEXT_KEYS = ['domain', 'txid', 'input_index', 'connection_work_target', 'root_certificates_version', 'signature_algorithms_mask', 'validation_time'];
const HASH = /^[0-9a-f]{64}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const DEFAULT_CLAIM_OPTIONS = Object.freeze({ connectionsPerSecond: 5, concurrency: 5, overallTimeout: 180, maxAttempts: 1000 });

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
export function validateClaimOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid claim options');
  if (Object.keys(options).some((key) => !Object.hasOwn(DEFAULT_CLAIM_OPTIONS, key))) throw new Error('Unknown claim option');
  const result = { ...DEFAULT_CLAIM_OPTIONS, ...options };
  integer(result.connectionsPerSecond, 1, 256, 'connections per second');
  integer(result.concurrency, 1, 256, 'simultaneous connections');
  integer(result.overallTimeout, 1, 600, 'claim timeout');
  integer(result.maxAttempts, 1, 100000, 'claim attempts');
  return Object.freeze(result);
}
export function validateClaimContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== CONTEXT_KEYS.length || CONTEXT_KEYS.some((key) => !Object.hasOwn(input, key))) throw new Error('Invalid public claim context');
  const context = Object.fromEntries(CONTEXT_KEYS.map((key) => [key, input[key]]));
  if (typeof context.domain !== 'string' || !DOMAIN.test(context.domain) || /(?:^|\.)(?:localhost|local|internal)$/.test(context.domain)) throw new Error('A public DNS domain is required');
  if (typeof context.txid !== 'string' || !HASH.test(context.txid) || typeof context.connection_work_target !== 'string' || !HASH.test(context.connection_work_target)) throw new Error('Invalid claim hash');
  integer(context.input_index, 0, 0xffffffff, 'claim input index');
  if (context.root_certificates_version !== 1) throw new Error('Unsupported root certificate bundle');
  integer(context.signature_algorithms_mask, 1, 7, 'signature policy');
  integer(context.validation_time, 1, 253402300799, 'chain median time');
  return Object.freeze(context);
}

function aborted(message = 'Automatic Claims stopped') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Resources must be outside ASAR. An absent helper is explicit, never silently downloaded. */
export function getClaimsHelper({ basePath = BASE, resourcesPath } = {}) {
  const executable = process.platform === 'win32' ? 'beauty-claims.exe' : 'beauty-claims';
  const candidates = [resourcesPath && resolve(resourcesPath, 'claims-helper', executable), resolve(basePath, 'helpers/bin/beauty-claims', executable)].filter(Boolean);
  for (const command of candidates) if (existsSync(command)) return { command, args: [], packaged: true };
  const command = resolve(basePath, '.claims-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (existsSync(command)) return { command, args: ['-I', resolve(basePath, 'helpers/claims_bridge.py')], packaged: false };
  return null;
}

/** Main-process-only subprocess bridge. No key material is serialized across it. */
export function createProofRunner({ helper, basePath = BASE, resourcesPath, spawnProcess = spawn } = {}) {
  return async function generateProof(contextInput, { signal, options, onProgress = () => {} } = {}) {
    const context = validateClaimContext(contextInput);
    const limits = validateClaimOptions(options);
    if (signal?.aborted) throw aborted();
    const runtime = helper ?? getClaimsHelper({ basePath, resourcesPath });
    if (!runtime) throw new Error('Automatic Claims helper is not installed. Run npm run setup:claims or use a packaged desktop release.');
    return new Promise((accept, reject) => {
      let child;
      let timer;
      let output = '';
      let outputBytes = 0;
      let stderrBytes = 0;
      let result;
      let failure;
      let settled = false;
      const stop = (error) => {
        failure ??= error;
        // Terminate the sole helper process, including its worker threads/sockets.
        // No shell and no descendant process tree is created by the helper.
        if (child && !child.killed) child.kill('SIGKILL');
      };
      const onAbort = () => stop(aborted());
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else accept(result.proof);
      };
      const receive = (line) => {
        let message;
        try { message = JSON.parse(line); } catch { throw new Error('Malformed claims helper response'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Malformed claims helper response');
        if (result) throw new Error('Unexpected output after claims proof');
        if (message.type === 'progress') {
          integer(message.attempts, 0, limits.maxAttempts, 'progress attempts');
          if (typeof message.elapsed !== 'number' || !Number.isFinite(message.elapsed) || message.elapsed < 0) throw new Error('Invalid helper progress');
          try { onProgress({ attempts: message.attempts, elapsed: message.elapsed }); } catch { /* UI callbacks cannot compromise cancellation. */ }
        } else if (message.type === 'result') {
          const returnedContext = validateClaimContext(message.context);
          if (CONTEXT_KEYS.some((key) => returnedContext[key] !== context[key]) || message.verified !== true) throw new Error('Proof does not match the prepared claim');
          if (typeof message.proof !== 'string' || !/^02(?:[0-9a-f]{2})+$/.test(message.proof) || message.proof.length > 131072) throw new Error('Invalid proof encoding');
          result = message;
        } else if (message.type === 'error') {
          throw new Error(typeof message.message === 'string' ? message.message.slice(0, 500) : 'TLS proof generation failed');
        } else throw new Error('Unknown claims helper response');
      };
      try {
        const environmentNames = new Set(['path', 'systemroot', 'systemdrive', 'windir', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'localappdata', 'appdata', 'user', 'username', 'lang', 'lc_all', 'tz']);
        const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentNames.has(key.toLowerCase())));
        // Do not inherit RPC credentials, developer tokens, Python module overrides,
        // or any application-private environment into the network-facing helper.
        child = spawnProcess(runtime.command, runtime.args ?? [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1' } });
        child.once('error', (error) => finish(new Error(`Claims helper could not start: ${error.message}`)));
        child.stdout.on('data', (chunk) => {
          if (failure || settled) return;
          outputBytes += chunk.length;
          // At most 600 throttled progress messages + one 64-KiB proof, never an unbounded log.
          if (outputBytes > 512 * 1024) { stop(new Error('Claims helper output limit exceeded')); return; }
          output += chunk.toString('utf8');
          try {
            let end;
            while ((end = output.indexOf('\n')) !== -1) {
              if (end > 160 * 1024) throw new Error('Claims helper frame limit exceeded');
              const line = output.slice(0, end);
              output = output.slice(end + 1);
              receive(line);
            }
            if (output.length > 160 * 1024) throw new Error('Claims helper frame limit exceeded');
          } catch (error) { stop(error); }
        });
        child.stderr.on('data', (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes > 8192) stop(new Error('Claims helper diagnostic limit exceeded'));
        });
        child.stdin.on('error', (error) => stop(new Error(`Claims helper input failed: ${error.message}`)));
        child.once('close', (code) => {
          if (signal?.aborted) failure ??= aborted();
          if (failure) finish(failure);
          else if (code !== 0 || !result || output.trim()) finish(new Error('Claims helper ended without a verified proof'));
          else finish();
        });
        timer = setTimeout(() => stop(new Error('TLS proof generation exceeded its deadline')), (limits.overallTimeout + 15) * 1000);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        if (!failure) child.stdin.end(`${JSON.stringify({ context, options: limits })}\n`);
      } catch (error) { if (child) stop(error); else finish(error); }
    });
  };
}

/** Opt-in scheduler; prepares and verifies one immutable claim transaction per job. */
export class ClaimsEngine {
  constructor({ prepare, submit, isUnlocked, generateProof = createProofRunner(), onState = () => {}, options = {}, retryDelayMs = 30000, maxQueue = 20000 }) {
    if (![prepare, submit, isUnlocked, generateProof, onState].every((fn) => typeof fn === 'function')) throw new Error('Claim callbacks are required');
    this.prepare = prepare;
    this.submit = submit;
    this.isUnlocked = isUnlocked;
    this.generateProof = generateProof;
    this.onState = onState;
    this.options = validateClaimOptions(options);
    this.retryDelayMs = integer(retryDelayMs, 1, 300000, 'retry delay');
    this.maxQueue = integer(maxQueue, 1, 20000, 'claim queue size');
    this.queue = new Map();
    this.completed = new Set();
    this.enabled = false;
    this.running = null;
    this.controller = null;
    this.timer = null;
    this.state = { enabled: false, status: 'off', queued: 0, completed: 0, attempts: 0, lastError: null };
  }
  snapshot() { return { ...this.state, enabled: this.enabled, queued: this.queue.size, options: { ...this.options } }; }
  notify(patch = {}) {
    this.state = { ...this.state, ...patch };
    try { this.onState(this.snapshot()); } catch { /* Presentation failure must not interrupt cleanup. */ }
  }
  setOptions(options) {
    if (this.enabled || this.running) throw new Error('Stop Automatic Claims before changing connection limits');
    this.options = validateClaimOptions(options);
    this.notify();
  }
  enqueue(bounties) {
    if (!Array.isArray(bounties)) throw new Error('Bounty list required');
    let count = 0;
    for (const bounty of bounties) {
      if (!bounty || typeof bounty.txid !== 'string' || !HASH.test(bounty.txid) || !Number.isInteger(bounty.vout) || bounty.vout < 0 || bounty.vout > 0xffffffff || bounty.status !== 'available') continue;
      const key = `${bounty.txid}:${bounty.vout}`;
      if (this.completed.has(key) || this.queue.has(key)) continue;
      if (this.queue.size >= this.maxQueue) break;
      // Discovery is untrusted; prepare must authenticate amount/policy against the funding TX.
      this.queue.set(key, { bounty: structuredClone(bounty), due: 0, failures: 0 });
      count++;
    }
    this.notify();
    this.kick();
    return count;
  }
  remove(txid, vout) {
    const key = `${txid}:${vout}`;
    this.queue.delete(key);
    if (this.activeKey === key) this.controller?.abort();
    this.notify();
  }
  clear() {
    this.queue.clear();
    this.completed.clear();
    this.controller?.abort();
    this.notify({ completed: 0 });
  }
  start() {
    if (!this.isUnlocked()) throw new Error('Unlock the wallet before starting Automatic Claims');
    if (this.running && !this.enabled) throw new Error('Wait for the previous claims worker to stop');
    this.enabled = true;
    this.notify({ status: 'waiting', lastError: null });
    this.kick();
  }
  async stop() {
    this.enabled = false;
    this.paused = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.notify({ status: 'off', domain: null });
    await this.running;
  }
  async suspend() {
    this.paused = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.running;
  }
  resume() { this.paused = false; this.kick(); }
  kick() {
    if (!this.enabled || this.running || this.paused) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.isUnlocked()) { this.enabled = false; this.notify({ status: 'locked' }); return; }
    const now = Date.now();
    const next = [...this.queue].find(([, job]) => job.due <= now);
    if (!next) {
      this.notify({ status: 'waiting' });
      if (this.queue.size) {
        let earliest = Infinity;
        for (const job of this.queue.values()) earliest = Math.min(earliest, job.due);
        this.timer = setTimeout(() => this.kick(), Math.max(1, earliest - now));
        this.timer.unref?.();
      }
      return;
    }
    const [key, job] = next;
    this.activeKey = key;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    // Deferring prevents synchronous callback throws from racing assignment of running.
    this.running = Promise.resolve().then(async () => {
      const eligible = () => this.enabled && this.isUnlocked() && !signal.aborted && this.queue.get(key) === job;
      if (!eligible()) throw aborted();
      this.notify({ status: 'preparing', domain: job.bounty.domain, attempts: 0, lastError: null });
      const prepared = await this.prepare(structuredClone(job.bounty), { signal });
      if (!eligible()) throw aborted();
      const context = validateClaimContext(prepared.context);
      this.notify({ status: 'searching', domain: context.domain });
      const proof = await this.generateProof(context, { signal, options: this.options, onProgress: (progress) => { if (eligible()) this.notify({ attempts: progress.attempts }); } });
      if (!eligible()) throw aborted();
      this.notify({ status: 'submitting' });
      const receipt = await this.submit(prepared, proof, { signal });
      // A broadcast already handed to the kernel cannot be recalled by locking.
      this.completed.add(key);
      if (this.completed.size > this.maxQueue) this.completed.delete(this.completed.values().next().value);
      this.queue.delete(key);
      this.notify({ status: this.enabled ? 'claimed' : 'off', completed: this.state.completed + 1, lastClaim: typeof receipt === 'string' ? receipt : receipt?.txid ?? context.txid });
    }).catch((error) => {
      if (error.name !== 'AbortError') {
        job.failures = Math.min(job.failures + 1, 8);
        job.due = Date.now() + Math.min(this.retryDelayMs * 2 ** (job.failures - 1), 300000);
        this.notify({ status: this.enabled ? 'retrying' : 'off', lastError: String(error.message || error).slice(0, 500) });
      }
    }).finally(() => {
      this.running = null;
      this.controller = null;
      this.activeKey = null;
      this.kick();
    });
  }
}
