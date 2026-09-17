import net from 'node:net';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { validateRpcEndpoint } from './config.mjs';

const PARAMS = Object.freeze({
  getchaintip: [], getrecentblockhashes: [], getblockbounties: ['block_hash'],
  getaddressbalance: ['address'], getaddresshistory: ['address', 'cursor'], getaddressutxos: ['address', 'cursor'],
  gettransaction: ['txid'], sendrawtransaction: ['transaction_hex'], getbountychanges: ['cursor'],
  subscribebounties: [], subscribeaddress: ['address'], subscribetip: [], unsubscribe: ['subscription_id'],
});
const MAX_FRAME = 2 * 1024 * 1024;
const PLAIN = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value));

export class RpcError extends Error {
  constructor(message, code, data) { super(message); this.name = 'RpcError'; this.code = code; this.data = data; }
}

// Reject unexpected fields rather than accidentally transmitting a recovery
// phrase/password/private key attached to a caller's object. Copy primitives
// before any await so callers cannot mutate the queued request or quota key.
export function validateRpcParams(method, params) {
  if (!Object.hasOwn(PARAMS, method)) throw new Error('This RPC method is not allowed.');
  if (!PLAIN(params) || Reflect.ownKeys(params).some(key => typeof key !== 'string' || !PARAMS[method].includes(key))) throw new Error('Unexpected RPC parameters.');
  const clean = {};
  for (const key of PARAMS[method]) {
    if (!Object.hasOwn(params, key)) {
      if (key !== 'cursor') throw new Error(`Missing RPC parameter: ${key}.`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(params, key);
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('RPC parameters must be plain data.');
    const value = descriptor.value;
    if (key === 'cursor' && value === null) { clean[key] = null; continue; }
    if (typeof value !== 'string') throw new Error(`Invalid RPC parameter: ${key}.`);
    if ((key === 'block_hash' || key === 'txid') && !/^[0-9a-f]{64}$/i.test(value)) throw new Error('Invalid RPC hash.');
    if (key === 'address' && (value.length < 8 || value.length > 90 || !/^[a-zA-Z0-9]+$/.test(value))) throw new Error('Invalid RPC address.');
    if (key === 'cursor' && (value.length < 1 || value.length > 1024 || !/^[A-Za-z0-9_.-]+$/.test(value))) throw new Error('Invalid RPC cursor.');
    if (key === 'subscription_id' && (value.length < 1 || value.length > 100 || !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error('Invalid RPC subscription ID.');
    if (key === 'transaction_hex' && (value.length < 20 || value.length > 800000 || value.length % 2 || !/^[0-9a-f]+$/i.test(value))) throw new Error('Invalid or oversized transaction bytes.');
    clean[key] = key === 'block_hash' || key === 'txid' ? value.toLowerCase() : value;
  }
  return clean;
}
function lossError(request, reason) {
  if (request.method === 'sendrawtransaction' && request.sent) {
    const error = new Error('Broadcast outcome is unknown. Check the transaction ID before retrying.');
    error.unknownOutcome = true;
    return error;
  }
  return reason;
}
function clearRequest(request) { clearTimeout(request.timer); clearTimeout(request.deadlineTimer); }

/** A bounded, plaintext, native TCP client. No wallet secrets cross this class. */
export class RpcClient extends EventEmitter {
  constructor({ host, port, timeoutMs = 40000, quota = 48, windowMs = 60000, onDiagnostic = () => {} } = {}) {
    super();
    Object.assign(this, validateRpcEndpoint({ host, port }));
    for (const [name, value, maximum] of [['timeoutMs', timeoutMs, 120000], ['quota', quota, 60], ['windowMs', windowMs, 60000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid RPC ${name}.`);
    }
    Object.assign(this, { timeoutMs, quota, windowMs });
    this.onDiagnostic = onDiagnostic;
    this.connectionErrors = new WeakMap();
    this.pending = new Map(); this.streams = new Map(); this.history = new Map(); this.cooldowns = new Map();
    this.nextId = 0; this.socket = null; this.connecting = null; this.closed = false; this.queuedRequests = 0;
    this.abort = new AbortController();
  }
  diagnostic(event, details) {
    // Diagnostic sinks must never change transport, quota, or broadcast outcomes.
    try { Promise.resolve(this.onDiagnostic(event, details)).catch(() => {}); } catch {}
  }
  async connect() {
    if (this.closed) throw new Error('RPC connection is closed.');
    if (this.socket && !this.socket.destroyed && !this.socket.connecting) return this.socket;
    if (this.connecting) return this.connecting;
    const connecting = new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      let buffer = Buffer.alloc(0), connected = false;
      let socketFailure = null, idleFailureReported = false;
      const idleFailure = (error, stage) => {
        if (idleFailureReported || (!connected && this.queuedRequests > 0)) return;
        if ([...this.pending.values(), ...this.streams.values()].some(request => request.socket === socket)) return;
        idleFailureReported = true;
        this.diagnostic('rpc.failed', { stage, durationMs: performance.now() - startedAt, error, unknownOutcome: false });
      };
      const connectTimer = setTimeout(() => socket.destroy(new Error('RPC connection timed out.')), Math.min(8000, this.timeoutMs));
      socket.setNoDelay(true); socket.setKeepAlive(true, 10000);
      socket.on('connect', () => {
        clearTimeout(connectTimer);
        if (this.closed || this.socket !== socket) { socket.destroy(); reject(new Error('RPC connection is closed.')); return; }
        connected = true;
        this.diagnostic('rpc.connected', { stage: 'connect', durationMs: performance.now() - startedAt });
        this.emit('connected'); resolve(socket);
      });
      socket.on('data', chunk => {
        if (this.socket !== socket || socket.destroyed) return;
        try {
          if (buffer.length + chunk.length > 4 * 1024 * 1024) throw new Error('RPC input exceeds its safety limit.');
          buffer = Buffer.concat([buffer, chunk]);
          let end;
          while ((end = buffer.indexOf(10)) >= 0) {
            if (end === 0 || end > MAX_FRAME) throw new Error('RPC frame exceeds its safety limit.');
            const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
            const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
            this.receive(message, socket, line.length);
          }
          if (buffer.length > MAX_FRAME) throw new Error('RPC frame exceeds its safety limit.');
        } catch {
          const error = new Error('RPC server returned an invalid or oversized response.');
          idleFailure(error, 'request');
          this.failAll(error, socket);
          socket.destroy();
        }
      });
      socket.on('error', error => {
        socketFailure = error;
        idleFailure(error, connected ? 'request' : 'connect');
        if (!connected) {
          const failure = new Error(`Cannot connect to RPC (${error.code ?? 'network error'}).`);
          this.connectionErrors.set(failure, error);
          reject(failure);
        }
      });
      socket.on('close', () => {
        clearTimeout(connectTimer);
        if (!connected) reject(new Error('RPC connection closed before connecting.'));
        // An old socket may close after a new connection has already begun.
        // Reject only requests owned by this socket; never kill the new one.
        const error = new Error('Connection to the RPC server was lost.');
        this.failAll(error, socket, socketFailure ?? error);
        this.diagnostic('rpc.disconnected', { stage: 'connect', durationMs: performance.now() - startedAt });
        if (this.socket === socket) { this.socket = null; this.emit('disconnected'); }
      });
    });
    this.connecting = connecting;
    try { return await connecting; }
    finally { if (this.connecting === connecting) this.connecting = null; }
  }
  failAll(error, socket = null, diagnosticError = error) {
    for (const [id, request] of this.pending) if (!socket || request.socket === socket) {
      if (request.diagnostic) request.diagnostic.error ??= diagnosticError;
      clearRequest(request); this.pending.delete(id); request.reject(lossError(request, error));
    }
    for (const [id, stream] of this.streams) if (!socket || stream.socket === socket) {
      if (stream.diagnostic) stream.diagnostic.error ??= diagnosticError;
      clearRequest(stream); this.streams.delete(id); stream.reject(lossError(stream, error));
    }
  }
  receive(message, socket = this.socket, frameBytes = 0) {
    if (!PLAIN(message) || message.jsonrpc !== '2.0') throw new Error('Invalid RPC envelope.');
    if (Object.hasOwn(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending || pending.socket !== socket || Object.hasOwn(message, 'method')) throw new Error('Unexpected RPC response.');
      const result = Object.hasOwn(message, 'result'), error = Object.hasOwn(message, 'error');
      if (result === error) throw new Error('RPC response must contain either result or error.');
      // Validate every part BEFORE removing pending, so malformed stream IDs
      // cannot strand an untracked promise when the socket is torn down.
      if (error) {
        if (!PLAIN(message.error) || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string') throw new Error('Invalid RPC error.');
        if (message.error.code === -32029) {
          const retry = message.error.data?.retry_after_ms;
          const wait = Number.isSafeInteger(retry) && retry > 0 ? Math.min(60000, retry) : this.windowMs;
          this.cooldowns.set(pending.method, performance.now() + wait);
        } else if (message.error.code === -32001) this.cooldowns.set('*', performance.now() + 1000);
        this.pending.delete(message.id); clearRequest(pending);
        pending.reject(new RpcError('RPC request failed. ' + message.error.message.slice(0, 180), message.error.code, message.error.data));
      } else if (pending.streaming) {
        const streamId = message.result?.stream_id;
        if (!PLAIN(message.result) || typeof streamId !== 'string' || streamId.length < 1 || streamId.length > 128 || this.streams.has(streamId)) throw new Error('Invalid stream identifier.');
        if (pending.diagnostic) pending.diagnostic.stage = 'stream';
        const stream = { ...pending, next: 0, records: 0, bytes: 0, phase: 'snapshot' };
        this.pending.delete(message.id); clearRequest(pending);
        this.streams.set(streamId, stream); this.resetStreamTimer(streamId, stream);
        stream.deadlineTimer = setTimeout(() => { this.failAll(new Error('Bounty transfer exceeded its total time limit.'), socket); socket.destroy(); }, 180000);
      } else {
        this.pending.delete(message.id); clearRequest(pending); pending.resolve(message.result);
      }
      return;
    }
    if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) throw new Error('Invalid RPC notification.');
    const params = message.params;
    if (message.method === 'stream.chunk' || message.method === 'stream.end') {
      if (!PLAIN(params) || typeof params.stream_id !== 'string') throw new Error('Invalid RPC stream envelope.');
      const stream = this.streams.get(params.stream_id);
      if (!stream || stream.socket !== socket) throw new Error('Unexpected RPC stream.');
      if (message.method === 'stream.end') {
        if (params.complete !== true || params.chunks !== stream.next || stream.phase !== 'end') {
          const failure = new Error('Bounty stream was incomplete; nothing from this block was applied.');
          let diagnosticError = failure;
          // stream.end puts its server error inside params. Retain only numeric
          // classifications for diagnostics, never its message or arbitrary data.
          if (params.complete === false && PLAIN(params.error) && Number.isSafeInteger(params.error.code)) {
            const data = PLAIN(params.error.data) && Number.isSafeInteger(params.error.data.node_code)
              ? { node_code: params.error.data.node_code } : undefined;
            diagnosticError = new RpcError(failure.message, params.error.code, data);
          }
          this.failAll(failure, socket, diagnosticError);
          socket.destroy();
        } else {
          this.streams.delete(params.stream_id); clearRequest(stream);
          stream.resolve({ chunks: stream.next, records: stream.records });
        }
      } else {
        if (!Number.isSafeInteger(params.sequence) || params.sequence !== stream.next || !PLAIN(params.items) || stream.next >= 2002) throw new Error('RPC stream sequence mismatch.');
        const kind = params.items.type;
        if (stream.phase === 'snapshot') {
          if (kind !== 'snapshot') throw new Error('Bounty stream is missing its snapshot.');
          stream.phase = 'bounties';
        } else if (stream.phase === 'bounties') {
          if (kind === 'state') stream.phase = 'end';
          else if (kind !== 'bounties' || !Array.isArray(params.items.items)) throw new Error('Invalid bounty stream payload.');
        } else throw new Error('Unexpected data after bounty stream state.');
        if (kind === 'bounties') stream.records += params.items.items.length;
        stream.bytes += frameBytes;
        if (stream.records > 100000 || stream.bytes > 64 * 1024 * 1024) throw new Error('Bounty block exceeds the wallet resource limit; it was not applied.');
        stream.next++;
        const callbackResult = stream.onChunk(params.items);
        if (callbackResult && typeof callbackResult.then === 'function') {
          // Unawaited callbacks could apply chunks after stream failure/lock.
          Promise.resolve(callbackResult).catch(() => {});
          throw new Error('RPC stream callbacks must be synchronous.');
        }
        this.resetStreamTimer(params.stream_id, stream);
      }
      return;
    }
    if (message.method === 'subscription' && PLAIN(params)) this.emit('notification', params);
    else throw new Error('Unknown RPC notification.');
  }
  resetStreamTimer(id, stream) {
    clearTimeout(stream.timer);
    stream.timer = setTimeout(() => { this.failAll(new Error('Bounty transfer timed out.'), stream.socket); stream.socket.destroy(); }, this.timeoutMs);
  }
  async pace(method, params) {
    const key = method === 'getblockbounties' ? `${method}:${params.block_hash}` : method;
    const limit = method === 'getblockbounties' ? 8 : this.quota;
    for (;;) {
      if (this.closed) throw new Error('RPC client is closed.');
      const now = performance.now();
      const cooldown = Math.max(this.cooldowns.get(method) ?? 0, this.cooldowns.get('*') ?? 0);
      if (cooldown > now) { await delay(Math.ceil(cooldown - now), undefined, { signal: this.abort.signal }); continue; }
      for (const [k, times] of this.history) if (!times.length || times.at(-1) <= now - this.windowMs) this.history.delete(k);
      const entries = this.history.get(key) ?? [];
      while (entries.length && entries[0] <= now - this.windowMs) entries.shift();
      if (entries.length < limit) {
        if (!this.history.has(key) && this.history.size >= 4096) throw new Error('RPC quota tracking capacity reached; retry after one minute.');
        entries.push(now); this.history.set(key, entries); return;
      }
      await delay(Math.max(1, entries[0] + this.windowMs - now + 10), undefined, { signal: this.abort.signal });
    }
  }
  async request(method, params = {}, { onChunk } = {}) {
    const startedAt = performance.now(), diagnostic = { stage: 'request', error: null };
    // Never copy caller params, arbitrary method names, or response bodies into diagnostics.
    const metadata = typeof method === 'string' && Object.hasOwn(PARAMS, method) ? { method } : {};
    let queued = false, unknownOutcome = false;
    try {
      const clean = validateRpcParams(method, params);
      if ((method === 'getblockbounties') !== (typeof onChunk === 'function')) throw new Error('Bounty requests require a stream callback; other requests must not use one.');
      if (this.queuedRequests >= 32) throw new Error('Too many queued RPC requests; retry shortly.');
      this.queuedRequests++; queued = true;
      await this.pace(method, clean);
      diagnostic.stage = 'connect';
      const socket = await this.connect();
      diagnostic.stage = 'request';
      if (this.closed || socket.destroyed || this.socket !== socket) throw new Error('RPC connection is closed.');
      if (this.pending.size + this.streams.size >= 12) throw new Error('Too many RPC requests; retry shortly.');
      if (this.nextId >= Number.MAX_SAFE_INTEGER) throw new Error('RPC request identifier space exhausted. Reopen the wallet.');
      const id = ++this.nextId;
      const encoded = JSON.stringify({ jsonrpc: '2.0', id, method, params: clean }) + '\n';
      if (Buffer.byteLength(encoded) > 900000 || socket.writableLength + Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error('RPC request exceeds the wallet output buffer limit.');
      return await new Promise((resolve, reject) => {
        const request = { resolve, reject, method, socket, streaming: typeof onChunk === 'function', onChunk, sent: false, diagnostic };
        request.timer = setTimeout(() => { this.failAll(new Error('RPC request timed out.'), socket); socket.destroy(); }, this.timeoutMs);
        this.pending.set(id, request);
        try {
          request.sent = true;
          socket.write(encoded, error => {
            if (error) { this.failAll(error, socket); socket.destroy(); }
          });
        } catch (error) { this.failAll(error, socket); socket.destroy(); }
      });
    } catch (error) {
      unknownOutcome = Boolean(error?.unknownOutcome);
      this.diagnostic('rpc.failed', { ...metadata, stage: diagnostic.stage, durationMs: performance.now() - startedAt, error: diagnostic.error ?? this.connectionErrors.get(error) ?? error, unknownOutcome });
      throw error;
    } finally {
      if (queued) this.queuedRequests--;
      const durationMs = performance.now() - startedAt;
      if (durationMs >= 1000) this.diagnostic('rpc.slow', { ...metadata, stage: diagnostic.stage, durationMs, unknownOutcome });
    }
  }
  close() {
    this.closed = true; this.abort.abort();
    this.failAll(new Error('RPC client closed.')); this.socket?.destroy(); this.socket = null;
  }
}
