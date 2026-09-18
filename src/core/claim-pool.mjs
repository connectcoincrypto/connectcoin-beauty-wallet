import { spawn } from 'node:child_process';
import { getClaimsHelper, validateClaimContext } from './claims.mjs';

export const CONNECTION_DEFAULTS = Object.freeze({ connectionsPerSecond: 100, concurrency: 100 });
export function validateConnectionOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(CONNECTION_DEFAULTS, key))) throw new Error('Invalid connection options');
  const options = { ...CONNECTION_DEFAULTS, ...input };
  for (const value of Object.values(options)) if (!Number.isInteger(value) || value < 1 || value > 256) throw new Error('Connection limits must be between 1 and 256');
  return Object.freeze(options);
}
export function claimAborted() { return Object.assign(new Error('Automatic Claims stopped'), { name: 'AbortError' }); }
const MAX_COUNTER = (1n << 64n) - 1n;
function counter(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > MAX_COUNTER) throw new Error('Invalid helper connection counter');
  return value;
}

/** One process for the entire run. Requests contain public claim contexts only. */
export class ConnectionPool {
  constructor({ helper, resourcesPath, basePath, spawnProcess = spawn, onDiagnostic = () => {} } = {}) {
    Object.assign(this, { helper, resourcesPath, basePath, spawnProcess, onDiagnostic });
    this.pacesStarts = true; // Protocol 3 enforces one global clock at socket start.
    this.requests = new Map(); this.sequence = 0; this.closing = false;
  }
  async start(options) {
    if (this.ready) return this.ready;
    this.options = validateConnectionOptions(options);
    const runtime = this.helper ?? getClaimsHelper({ basePath: this.basePath, resourcesPath: this.resourcesPath });
    if (!runtime) throw new Error('Automatic Claims helper is not installed. Run npm run build:claims.');
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.closed = new Promise(resolve => { this.closedResolve = resolve; });
    const allowed = new Set(['path', 'systemroot', 'systemdrive', 'windir', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'localappdata', 'appdata', 'user', 'username', 'lang', 'lc_all', 'tz']);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
    try {
      this.child = this.spawnProcess(runtime.command, [...runtime.args ?? [], '--service'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1' } });
      this.buffer = ''; this.stderrBytes = 0;
      this.child.once('error', error => { this.fail(new Error(`Claims helper could not start: ${error.message}`)); this.closedResolve(); });
      this.child.stdin.on('error', error => { if (!this.closing) this.fail(new Error(`Claims helper input failed: ${error.message}`)); });
      this.child.stdout.on('data', data => {
        if (this.failure) return;
        try {
          this.buffer += data.toString('utf8');
          let end;
          while ((end = this.buffer.indexOf('\n')) !== -1) {
            if (end > 160 * 1024) throw new Error('Claims helper frame limit exceeded');
            const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
            this.receive(JSON.parse(line));
          }
          if (this.buffer.length > 160 * 1024) throw new Error('Claims helper frame limit exceeded');
        } catch (error) { this.fail(error); }
      });
      this.child.stderr.on('data', data => { this.stderrBytes += data.length; if (this.stderrBytes > 8192) this.fail(new Error('Claims helper diagnostic limit exceeded')); });
      this.child.once('close', () => {
        clearTimeout(this.startTimer); clearTimeout(this.killTimer);
        if (!this.closing) this.fail(new Error('Persistent claims helper closed unexpectedly'));
        else for (const request of [...this.requests.values()]) this.finish(request, claimAborted());
        this.readyReject(claimAborted()); this.closedResolve();
      });
      this.startTimer = setTimeout(() => this.fail(new Error('Claims helper startup timed out; update or rebuild the helper')), 15000);
      this.send({ type: 'start', protocol: 3, options: this.options });
    } catch (error) { this.fail(error); this.closedResolve(); }
    return this.ready;
  }
  send(message) {
    if (this.failure) throw this.failure;
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > 16384) throw new Error('Claims helper request limit exceeded');
    // There are at most concurrency+two DNS requests, not an unbounded pipe queue.
    if ((this.child?.stdin.writableLength ?? 0) > 1024 * 1024) throw new Error('Claims helper input backpressure exceeded');
    this.child.stdin.write(line);
  }
  request(kind, body, { signal, onStarted, onCapture } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.started || this.closing || signal?.aborted) return Promise.reject(claimAborted());
    if (this.requests.size >= 512 || this.sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error('Claims helper request capacity exceeded'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const request = { id, kind, body, signal, onStarted, onCapture, resolve, reject, started: false, capture: null };
      request.abort = () => { try { this.send({ type: 'cancel', id }); } catch { /* A closing helper is already cancelled. */ } };
      // Bounds one DNS/capture/verification, never a whole bounty's search.
      request.timer = setTimeout(() => this.fail(new Error('Claims helper request exceeded its deadline')), 45000);
      signal?.addEventListener('abort', request.abort, { once: true });
      this.requests.set(id, request);
      try { this.send({ type: kind, id, ...body }); } catch (error) { this.fail(error); }
    });
  }
  resolve(domain, options = {}) { return this.request('resolve', { domain }, options); }
  attempt(context, { bountyId, successfulConnections = 0n, ...options } = {}) {
    if (typeof bountyId !== 'string' || !/^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/.test(bountyId) || Number(bountyId.split(':')[1]) > 0xffffffff) return Promise.reject(new Error('Invalid bounty identity'));
    const publicContext = validateClaimContext(context);
    return this.request('attempt', { context: publicContext, bountyId, successfulConnections: counter(String(successfulConnections)) }, options);
  }
  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Malformed claims helper response');
    if (message.type === 'ready') {
      if (this.started || message.protocol !== 3 || message.roots !== 1) throw new Error('Incompatible claims helper; update or rebuild it');
      this.started = true; clearTimeout(this.startTimer); this.readyResolve(); return;
    }
    if (message.type === 'error') throw new Error(typeof message.message === 'string' ? message.message.slice(0, 500) : 'Claims helper failed');
    if (!Number.isSafeInteger(message.id)) throw new Error('Invalid helper request identity');
    const request = this.requests.get(message.id);
    if (!request) throw new Error('Unexpected or duplicate helper response');
    if (message.type === 'resolved' && request.kind === 'resolve') {
      if (typeof message.ok !== 'boolean') throw new Error('Invalid DNS helper result');
      this.finish(request, request.signal?.aborted ? claimAborted() : message.ok ? null : new Error('Domain resolution failed'), message); return;
    }
    if (request.kind !== 'attempt') throw new Error('Mismatched helper response type');
    if (message.type === 'started') {
      if (request.started || request.capture) throw new Error('Duplicate helper start');
      request.started = true; request.onStarted?.(); return;
    }
    if (!['capture', 'attempt'].includes(message.type)) throw new Error('Unknown claims helper response');
    const context = validateClaimContext(message.context);
    if (Object.keys(context).some(key => context[key] !== request.body.context[key])) throw new Error('Proof does not match the prepared claim');
    if (typeof message.started !== 'boolean' || message.started !== request.started || typeof message.captured !== 'boolean' || typeof message.cancelled !== 'boolean' ||
        typeof message.seconds !== 'number' || !Number.isFinite(message.seconds) || message.seconds < 0 || message.seconds > 3600 ||
        (message.captured && !message.started)) throw new Error('Invalid helper capture status');
    counter(message.successfulConnections);
    const minimum = BigInt(request.body.successfulConnections) + (message.captured ? 1n : 0n);
    if (BigInt(message.successfulConnections) < (minimum > MAX_COUNTER ? MAX_COUNTER : minimum)) throw new Error('Helper connection counter moved backwards');
    if (message.type === 'capture') {
      if (!request.started || request.capture) throw new Error('Unexpected or duplicate capture');
      request.capture = message; request.onCapture?.(message); return;
    }
    if (request.started && !request.capture) throw new Error('Missing helper capture observation');
    if (request.capture && (request.capture.captured !== message.captured || request.capture.seconds !== message.seconds ||
        request.capture.successfulConnections !== message.successfulConnections)) throw new Error('Conflicting helper capture observation');
    if (message.proof !== null) {
      if (!message.captured || message.verified !== true || message.cancelled || typeof message.proof !== 'string' || !/^02(?:[0-9a-f]{2})+$/.test(message.proof) || message.proof.length > 131072) throw new Error('Invalid verified proof result');
    } else if (message.verified !== false) throw new Error('Invalid proof verification status');
    this.finish(request, request.signal?.aborted ? claimAborted() : null, message);
  }
  finish(request, error, result) {
    if (!this.requests.delete(request.id)) return;
    clearTimeout(request.timer); request.signal?.removeEventListener('abort', request.abort);
    if (error) request.reject(error); else request.resolve(result);
  }
  fail(error) {
    if (this.failure) return;
    this.failure = Object.assign(error, { helperFatal: true });
    clearTimeout(this.startTimer); this.readyReject?.(this.failure);
    for (const request of [...this.requests.values()]) this.finish(request, this.failure);
    if (this.child && !this.child.killed) this.child.kill('SIGKILL');
    try { Promise.resolve(this.onDiagnostic('helper.failed', { stage: 'proof', error: this.failure })).catch(() => {}); } catch { /* No effect on cancellation. */ }
  }
  async close() {
    if (this.closing) return this.closed;
    this.closing = true;
    clearTimeout(this.startTimer);
    if (!this.child) { this.closedResolve?.(); return; }
    try { this.send({ type: 'shutdown' }); this.child.stdin.end(); } catch { this.child.kill('SIGKILL'); }
    this.killTimer = setTimeout(() => { if (!this.child.killed) this.child.kill('SIGKILL'); }, 2000);
    await this.closed;
    clearTimeout(this.killTimer);
  }
}
