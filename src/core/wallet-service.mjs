import { EventEmitter } from 'node:events';
import { randomUUID, randomInt } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { RpcClient } from './rpc.mjs';
import { readConfig, writeConfig, validateConfig, validateTheme, validateDeveloperMode, validateTip } from './config.mjs';
import { deriveAccount, generateMnemonic, normalizeMnemonic, validateMnemonic } from './crypto.mjs';
import { createVault, unlockVault, updateVault, validatePassword, replaceVault, vaultFingerprint } from './vault.mjs';
import { buildPayment, prepareClaim, attachClaimProof, parseCoinAmount, formatCoinAmount, estimateClaimFee, parseTransaction, transactionId } from './transaction.mjs';
import { ClaimsEngine, getClaimsHelper, isKnownClaimRejection } from './claims.mjs';
import { bountyKey, discoverBounties, readBountyBlock } from './bounty-discovery.mjs';
import { DiagnosticLog } from './diagnostics.mjs';
import { StatePublisher } from './state-publisher.mjs';
import { performance } from 'node:perf_hooks';
import { selectVaultFile, VAULT_NAME } from './profile-paths.mjs';
import { createRsaProbe } from './rsa-probe.mjs';

const HASH = /^[0-9a-f]{64}$/;
const MONEY = /^-?\d{1,19}$/;
function amount(value) {
  if (typeof value !== 'string' || !MONEY.test(value) || BigInt(value) > 1000000000000000000n || BigInt(value) < -1000000000000000000n) throw new Error('RPC returned an invalid monetary amount.');
  return BigInt(value);
}
function walletName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40 || /[\x00-\x1f]/.test(name)) throw new Error('Use a wallet name between 1 and 40 characters.');
  return name.trim();
}
function formatSigned(value) { return value < 0n ? `-${formatCoinAmount(-value)}` : formatCoinAmount(value); }
function waitForReview(promise, signal) {
  // Cancel this review's wait, never a refresh shared with the rest of the wallet.
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(Object.assign(new Error('Payment review cancelled.'), { name: 'AbortError' })); };
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
function validateRow(row) {
  if (!row || !HASH.test(row.txid)) throw new Error('Invalid transaction returned by RPC.');
  return row;
}
export class WalletService extends EventEmitter {
  constructor({ directory, resourcesPath, allowRegtest = false, clientFactory = options => new RpcClient(options), proofRunner, connectionPoolFactory, rsaProbe } = {}) {
    super(); Object.assign(this, { directory, resourcesPath, allowRegtest, clientFactory, proofRunner, connectionPoolFactory });
    this.vaultFile = join(directory, VAULT_NAME);
    this.diagnostics = null;
    this.session = null; this.epoch = 0; this.setup = null; this.preview = null;
    this.rsaProbe = rsaProbe ?? createRsaProbe({ resourcesPath });
    this.sendPreparation = null;
    this.replacement = null; this.walletWrite = null; this.closed = false;
    this.walletExists = false; this.accounts = []; this.accountCache = new Map(); this.utxos = []; this.history = [];
    this.balance = null; this.qrDataUrl = null; this.error = null; this.rpc = null;
    this.network = { status: 'offline', chain: 'testnet4', height: null };
    this.claimBlocks = new Map(); this.claimCursor = null; this.claimInfo = {}; this.retiredClaims = new Map(); this.tip = null;
    this.reserved = new Set(); this.fundingCache = new Map(); this.fundingPending = new Map(); this.lastActivity = Date.now(); this.persisting = Promise.resolve();
    this.statePublisher = new StatePublisher({ publish: () => this.emit('state', this.getState()) });
    this.statePriority = null;
  }
  async initialize() {
    this.vaultFile = selectVaultFile(this.directory);
    this.config = await readConfig(this.directory, { allowRegtest: this.allowRegtest });
    this.walletExists = await access(this.vaultFile).then(() => true, () => false);
    this.diagnostics = new DiagnosticLog({ directory: this.directory });
    this.recordDiagnostic('wallet.started', { stage: 'lifecycle' });
    await this.diagnostics.flush();
    this.connectClient(); this.createEngine();
    this.timer = setInterval(() => {
      if (this.setup && Date.now() > this.setup.expires) { this.setup = null; this.emitState(); }
      if (this.replacement && Date.now() > this.replacement.expires) this.cancelWalletReplacement();
      if (this.session && Date.now() - this.lastActivity >= this.config.autoLockMinutes * 60000) void this.lock();
      else if (this.session) void this.refresh().catch(() => {});
    }, 20000);
    this.timer.unref?.();
    return this.getState();
  }
  connectClient() {
    this.cancelSendPreview();
    this.rpc?.close(); this.refreshing = null; this.fundingPending.clear();
    const rpc = this.clientFactory({ ...this.config.rpc, onDiagnostic: (event, details) => this.recordDiagnostic(event, details) }); this.rpc = rpc;
    this.tip = null;
    this.network = { status: 'offline', chain: this.config.network, height: null };
    rpc.on('disconnected', () => {
      if (this.rpc !== rpc) return;
      this.tip = null;
      this.network.status = 'offline';
      this.cancelSendPreview();
      void this.engine?.stop(); this.emitState();
    });
  }
  createEngine() {
    this.engine = new ClaimsEngine({
      isUnlocked: () => Boolean(this.session),
      resourcesPath: this.resourcesPath,
      ...(this.proofRunner ? { generateProof: this.proofRunner } : {}),
      ...(this.connectionPoolFactory ? { poolFactory: this.connectionPoolFactory } : {}),
      onDiagnostic: (event, details) => this.recordDiagnostic(event, details),
      prepare: (bounty, options) => this.prepareAutomaticClaim(bounty, options),
      submit: (prepared, proof, options) => this.submitAutomaticClaim(prepared, proof, options),
      getNetReward: bounty => BigInt(bounty.amount) - BigInt(estimateClaimFee(this.config.feeRate)),
      getValidationTime: () => validateTip(this.tip, this.config.network).mediantime,
      options: { connectionsPerSecond: this.config.claims.maxConnectionsPerSecond, concurrency: this.config.claims.maxConcurrent },
      onState: state => {
        this.claimInfo = state;
        for (const [key, row] of this.retiredClaims) if (!this.engine?.hasActive(key)) {
          if (this.claimOutpoints?.get(key) === row) this.claimOutpoints.delete(key);
          this.retiredClaims.delete(key);
        }
        this.emitState();
      },
    });
  }
  getState() {
    const current = this.accounts.find(a => a.change === 0 && a.index === this.session?.data.receiveIndex);
    return {
      phase: this.session ? 'unlocked' : this.walletExists ? 'locked' : 'welcome',
      setupActive: Boolean(this.setup), securityEpoch: this.epoch,
      replacementActive: Boolean(!this.session && this.replacement && this.replacement.epoch === this.epoch && this.replacement.expires > Date.now()),
      replacementMode: !this.session && this.replacement && this.replacement.epoch === this.epoch && this.replacement.expires > Date.now() ? this.replacement.mode : null,
      wallet: this.session ? { name: this.session.data.name, address: current?.address ?? '', path: current?.path,
        qrDataUrl: this.qrDataUrl, balance: this.balance, recovering: Boolean(this.recovering), addressCount: this.accounts.length } : null,
      network: { ...this.network, host: this.config.rpc.host, port: this.config.rpc.port },
      config: structuredClone(this.config), history: this.session ? this.history : [],
      claims: { ...this.claimInfo, enabled: Boolean(this.engine?.enabled), available: this.claimInfo.queued ?? 0,
        lastErrorDiagnostic: this.claimInfo.lastErrorDiagnostic === true,
        sent: this.claimInfo.completed ?? 0, successful: this.claimInfo.completed ?? 0,
        helperAvailable: Boolean(this.proofRunner || this.connectionPoolFactory || getClaimsHelper({ resourcesPath: this.resourcesPath })), scanning: Boolean(this.scanningBounties) },
      busy: Boolean(this.refreshing), error: this.error,
      diagnostics: this.session && this.config.developerMode ? this.diagnostics?.snapshot() ?? null : null,
    };
  }
  emitState() {
    if (!this.config) return;
    // Progress bursts must not serialize history/QR/diagnostics once per bounty.
    // Security transitions and actionable errors bypass the progress throttle.
    const priority = [this.epoch, Boolean(this.session), this.walletExists, this.config.developerMode,
      this.network.status, Boolean(this.engine?.enabled), this.error,
      this.claimInfo.lastErrorDiagnostic === true || this.claimInfo.lastErrorTransient === true
        ? null : this.claimInfo.lastError ?? null];
    const immediate = !this.statePriority || priority.some((value, index) => value !== this.statePriority[index]);
    this.statePriority = priority;
    this.statePublisher.request({ immediate });
  }
  recordDiagnostic(event, details = {}) {
    try { this.diagnostics?.record(event, { ...details, height: this.network.height }); } catch { /* Logging never controls the wallet. */ }
  }
  activity() { this.lastActivity = Date.now(); }
  assertSession(epoch = this.epoch) { if (!this.session || epoch !== this.epoch) throw new Error('Wallet locked or changed; please try again after unlocking.'); }
  assertReplacement(replacementId, mode) {
    const value = this.replacement;
    if (this.closed || this.session || !this.walletExists || !value || value.replacementId !== replacementId || value.epoch !== this.epoch || value.expires <= Date.now()) throw new Error('Wallet replacement expired or was cancelled. Start again from the unlock screen.');
    if (mode && value.mode !== mode) throw new Error('Use recovery words to reset your password, or choose Use another wallet.');
    return value;
  }
  async beginWalletReplacement({ mode } = {}) {
    if (mode !== 'recover' && mode !== 'switch') throw new Error('Choose recovery or another wallet.');
    if (this.closed || !this.walletExists || this.session || this.walletWrite) throw new Error('Lock the existing wallet and wait for any wallet operation to finish.');
    const epoch = ++this.epoch;
    this.replacement = null; this.setup = null;
    await this.persisting.catch(() => {});
    const expectedFingerprint = await vaultFingerprint(this.vaultFile);
    if (this.closed || this.epoch !== epoch || this.session || this.walletWrite) throw new Error('Wallet replacement was cancelled.');
    this.replacement = { replacementId: randomUUID(), mode, epoch, expectedFingerprint, expires: Date.now() + 600000 };
    this.emitState();
    return { replacementId: this.replacement.replacementId };
  }
  cancelWalletReplacement() {
    this.replacement = null; this.setup = null; this.epoch++;
    this.emitState(); return this.getState();
  }
  async prepareWallet({ name, password, wordCount = 24, replacementId } = {}) {
    if (this.closed || this.walletWrite || this.session) throw new Error('A wallet operation is already in progress.');
    if (this.walletExists) this.assertReplacement(replacementId, 'switch');
    else if (replacementId !== undefined) throw new Error('No wallet is available to replace.');
    validatePassword(password); name = walletName(name);
    const mnemonic = generateMnemonic(wordCount);
    const checkIndexes = new Set(); while (checkIndexes.size < 3) checkIndexes.add(randomInt(wordCount));
    this.setup = { setupId: randomUUID(), mnemonic, password, name, replacementId, epoch: this.epoch, checkIndexes: [...checkIndexes].sort((a,b) => a-b), expires: Date.now() + 600000 };
    return { setupId: this.setup.setupId, mnemonic, checkIndexes: this.setup.checkIndexes };
  }
  cancelSetup() { this.setup = null; return this.getState(); }
  async confirmWallet({ setupId, answers } = {}) {
    const setup = this.setup;
    if (!setup || setup.setupId !== setupId || setup.epoch !== this.epoch || setup.expires < Date.now()) throw new Error('Wallet setup expired. Please create a new recovery phrase.');
    const words = setup.mnemonic.split(' ');
    if (!answers || setup.checkIndexes.some(index => String(answers[index] ?? '').trim().toLowerCase() !== words[index])) throw new Error('The backup words do not match. Check your written recovery phrase.');
    await this.createWallet(setup, false);
    if (this.setup === setup) this.setup = null;
    return this.getState();
  }
  async restoreWallet({ name, password, mnemonic, replacementId } = {}) {
    validatePassword(password);
    if (!validateMnemonic(mnemonic)) throw new Error('Enter a valid 12, 18 or 24-word BIP39 recovery phrase.');
    await this.createWallet({ name: walletName(name), password, mnemonic: normalizeMnemonic(mnemonic), replacementId }, true);
    return this.getState();
  }
  async createWallet(input, recover) {
    if (this.closed || this.walletWrite || this.session) throw new Error('A wallet operation is already in progress.');
    const operation = this.createWalletInternal(input, recover);
    this.walletWrite = operation;
    try { await operation; }
    finally { if (this.walletWrite === operation) this.walletWrite = null; }
  }
  async createWalletInternal({ name, password, mnemonic, replacementId, setupId }, recover) {
    const replacement = this.walletExists ? this.assertReplacement(replacementId, recover ? undefined : 'switch') : null;
    if (!replacement && replacementId !== undefined) throw new Error('No wallet is available to replace.');
    const epoch = this.epoch;
    const check = () => {
      if (this.closed || epoch !== this.epoch || this.session) throw new Error('Wallet creation or replacement was cancelled.');
      if (replacement) this.assertReplacement(replacementId, recover ? undefined : 'switch');
      if (setupId && (this.setup?.setupId !== setupId || this.setup.expires <= Date.now())) throw new Error('Wallet setup expired or was cancelled.');
    };
    check();
    const data = { name, mnemonic, network: this.config.network, passphrase: '', receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1, needsRecovery: recover, createdAt: new Date().toISOString() };
    await this.persisting.catch(() => {}); check();
    try {
      if (replacement) await replaceVault(this.vaultFile, data, password, { expectedFingerprint: replacement.expectedFingerprint, check });
      else await createVault(this.vaultFile, data, password, { check });
    } catch (error) {
      if (error.walletPublished === true) {
        this.walletExists = true; this.replacement = null; this.setup = null; this.epoch++;
        this.error = error.message; this.emitState();
      }
      throw error;
    }
    this.walletExists = true;
    this.replacement = null;
    // Cancellation may arrive after publication while cleanup is still pending.
    // The saved wallet remains available, but that cancelled setup cannot unlock it.
    if (this.closed || this.epoch !== epoch || (setupId && (this.setup?.setupId !== setupId || this.setup.expires <= Date.now()))) {
      this.setup = null; this.emitState(); return;
    }
    await this.openSession(data, password);
  }
  async unlock({ password } = {}) {
    if (this.closed || !this.walletExists || this.session) throw new Error('Wallet is not locked.');
    this.replacement = null; this.setup = null; this.epoch++;
    const epoch = this.epoch;
    await this.walletWrite?.catch(() => {});
    if (this.closed || this.epoch !== epoch) throw new Error('Unlock was cancelled.');
    const data = await unlockVault(this.vaultFile, password);
    if (this.epoch !== epoch) throw new Error('Unlock was cancelled.');
    await this.openSession(data, password); return this.getState();
  }
  async openSession(data, password) {
    if (data.network !== this.config.network) throw new Error('Wallet and RPC configuration belong to different networks.');
    for (const key of ['receiveIndex', 'changeIndex']) if (!Number.isSafeInteger(data[key]) || data[key] < 0 || data[key] > 999) throw new Error('Unsupported wallet address index.');
    walletName(data.name);
    this.replacement = null; this.setup = null;
    this.session = { data, password }; this.epoch++; this.activity(); this.error = null;
    this.buildAccounts(); await this.makeQR(); this.emitState();
    void this.refresh().catch(() => {});
  }
  publicAccount(index, change) {
    this.assertSession();
    const cacheKey = `${change}:${index}`;
    if (this.accountCache.has(cacheKey)) return this.accountCache.get(cacheKey);
    const account = deriveAccount(this.session.data.mnemonic, { network: this.config.network, index, change, passphrase: this.session.data.passphrase });
    const { privateKey, ...publicData } = account; privateKey.fill(0);
    this.accountCache.set(cacheKey, publicData); return publicData;
  }
  buildAccounts() {
    this.accounts = [];
    for (const change of [0,1]) {
      const issued = this.session.data[change ? 'changeIndex' : 'receiveIndex'];
      const used = this.session.data[change ? 'lastUsedChange' : 'lastUsedReceive'] ?? -1;
      const maximum = this.session.data.scanLookahead ? Math.min(999, Math.max(issued, used + 20)) : issued;
      for (let index = 0; index <= maximum; index++) this.accounts.push(this.publicAccount(index, change));
    }
  }
  async makeQR() {
    const epoch = this.epoch;
    const address = this.accounts.find(a => a.change === 0 && a.index === this.session?.data.receiveIndex)?.address;
    const qrDataUrl = address ? await QRCode.toDataURL(address, { errorCorrectionLevel: 'M', margin: 2, width: 280, color: { dark: '#17211b', light: '#ffffff' } }) : null;
    if (epoch === this.epoch && this.session) this.qrDataUrl = qrDataUrl;
  }
  async persist() {
    this.assertSession();
    const data = structuredClone(this.session.data), password = this.session.password;
    const operation = this.persisting.catch(() => {}).then(() => updateVault(this.vaultFile, data, password));
    this.persisting = operation; await operation;
  }
  async lock() {
    this.cancelSendPreview();
    this.epoch++; this.preview = null; this.setup = null; this.replacement = null;
    const epoch = this.epoch;
    this.session = null; this.accounts = []; this.utxos = []; this.history = []; this.balance = null; this.qrDataUrl = null;
    this.tip = null; this.retiredClaims.clear();
    this.fundingCache.clear(); this.fundingPending.clear(); this.claimBlocks.clear(); this.claimOutpoints?.clear(); this.claimCursor = null; this.reserved.clear(); this.accountCache.clear();
    this.rpc?.close();
    // Hide sensitive renderer state immediately, before waiting for helper shutdown.
    this.emitState();
    await this.engine?.stop('locked'); this.engine?.clear();
    if (epoch !== this.epoch) return this.getState();
    this.connectClient(); this.emitState(); return this.getState();
  }
  async newAddress() {
    this.assertSession();
    const epoch = this.epoch;
    if (this.session.data.needsRecovery) throw new Error('Wait for recovery discovery to finish.');
    if (this.session.data.receiveIndex >= 999 || this.session.data.receiveIndex >= (this.session.data.lastUsedReceive ?? -1) + 20) throw new Error('Use one of your existing receive addresses before creating more. Recovery keeps a 20-address gap.');
    const previousIndex = this.session.data.receiveIndex;
    this.session.data.receiveIndex++;
    try { await this.persist(); }
    catch(error) { if (epoch === this.epoch && this.session) this.session.data.receiveIndex = previousIndex; throw error; }
    this.assertSession(epoch); this.buildAccounts(); await this.makeQR(); this.emitState();
    void this.refresh().catch(() => {});
    return { address: this.getState().wallet.address, qrDataUrl: this.qrDataUrl };
  }
  async getRecoveryPhrase({ password } = {}) {
    this.assertSession(); const epoch = this.epoch;
    const verified = await unlockVault(this.vaultFile, password); this.assertSession(epoch);
    return { mnemonic: verified.mnemonic, path: "m/44'/1'/0'/change/index", network: verified.network };
  }
  async ensureNetwork() {
    const epoch = this.epoch, rpc = this.rpc;
    const tip = validateTip(await rpc.request('getchaintip'), this.config.network);
    this.assertSession(epoch);
    if (rpc !== this.rpc) throw new Error('RPC connection changed.');
    this.network = { ...this.network, status: 'online', height: tip.height, chain: tip.chain };
    this.tip = tip; return tip;
  }
  checkResponse(response) { validateTip(response?.tip, this.config.network); return response; }
  async page(method, address, { firstOnly = false, onTip } = {}) {
    const epoch = this.epoch, rpc = this.rpc; const items = []; let cursor; const seen = new Set();
    do {
      this.assertSession(epoch);
      if (seen.size >= 1000) throw new Error('Address pagination exceeds this release’s local resource limit.');
      const result = this.checkResponse(await rpc.request(method, { address, ...(cursor ? { cursor } : {}) }));
      this.assertSession(epoch);
      if (rpc !== this.rpc) throw new Error('RPC connection changed.');
      if (result.address !== address || result.unit !== 'connects' || !Array.isArray(result.items) || result.items.length > 500) throw new Error('RPC returned an invalid address page.');
      onTip?.(result.tip);
      items.push(...result.items.map(validateRow));
      if (items.length > 20000) throw new Error('Address history exceeds this release’s local resource limit. No partial balance was accepted.');
      cursor = result.next_cursor;
      if (cursor !== null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 4096 || seen.has(cursor))) throw new Error('RPC returned an invalid or repeated cursor.');
      seen.add(cursor);
      // An empty page may still have a continuation; only a positive result or
      // exhaustion proves whether this address contributes to the recovery gap.
      if (firstOnly && items.length) break;
    } while (cursor);
    return items;
  }
  async recoverAddresses(epoch) {
    this.recovering = true; this.emitState();
    try {
      const emptyAddresses = new Set(), rpc = this.rpc, tipHash = this.tip?.hash;
      let stableTip = true;
      const onTip = tip => {
        if (tip.hash !== tipHash || this.tip?.hash !== tipHash || this.rpc !== rpc) {
          stableTip = false; emptyAddresses.clear();
        }
      };
      const lastUsed = [-1,-1];
      for (const change of [0,1]) {
        let gap = 0;
        for (let index = 0; gap < 20; index++) {
          this.assertSession(epoch);
          if (index >= 1000) throw new Error('Recovery reached the 1,000-address safety limit. Contact support before using this wallet.');
          const account = this.publicAccount(index, change);
          const history = await this.page('getaddresshistory', account.address, { firstOnly: true, onTip });
          if (history.length) { lastUsed[change] = index; gap = 0; } else gap++;
          if (!history.length && stableTip) emptyAddresses.add(account.address);
        }
      }
      this.assertSession(epoch);
      this.session.data.receiveIndex = Math.max(this.session.data.receiveIndex, lastUsed[0] + 1);
      this.session.data.changeIndex = Math.max(this.session.data.changeIndex, lastUsed[1] + 1);
      this.session.data.lastUsedReceive = lastUsed[0]; this.session.data.lastUsedChange = lastUsed[1]; this.session.data.needsRecovery = false;
      this.session.data.scanLookahead = true;
      await this.persist(); this.assertSession(epoch); this.buildAccounts(); await this.makeQR();
      return emptyAddresses;
    } finally { this.recovering = false; this.emitState(); }
  }
  async refresh() {
    if (!this.session) return this.getState();
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    const started = performance.now();
    const operation = this.refreshInternal(epoch).catch(error => {
      const cancelled = error?.name === 'AbortError' && !error.unknownOutcome;
      this.recordDiagnostic(cancelled ? 'wallet.refresh_cancelled' : 'wallet.refresh_failed', {
        stage: 'refresh', ...(!cancelled ? { error } : {}), durationMs: Math.round(performance.now() - started),
      });
      if (!cancelled && epoch === this.epoch) { this.error = error.message; if (!this.rpc.socket) this.network.status = 'offline'; this.emitState(); }
      throw error;
    }).finally(() => { if (this.refreshing === operation) this.refreshing = null; this.emitState(); });
    this.refreshing = operation;
    this.emitState(); return this.refreshing;
  }
  async refreshInternal(epoch) {
    await this.ensureNetwork(); this.assertSession(epoch);
    const rpc = this.rpc, recoveryTipHash = this.tip.hash;
    const emptyAddresses = this.session.data.needsRecovery ? await this.recoverAddresses(epoch) : null;
    // Reuse only fully exhausted empty discovery results inside this refresh.
    // A new block, same-height fork, or changed connection invalidates them.
    let stableRecoveryTip = true, reusedEmptyHistory = false;
    const onTip = tip => {
      if (tip.hash !== recoveryTipHash || this.tip?.hash !== recoveryTipHash || this.rpc !== rpc) stableRecoveryTip = false;
    };
    if (emptyAddresses?.size) onTip(await this.ensureNetwork());
    this.assertSession(epoch);
    if (rpc !== this.rpc) throw new Error('RPC connection changed.');
    const totals = { confirmed: 0n, available: 0n, pending: 0n, immature: 0n };
    const utxos = [], history = new Map(); let highestReceive = this.session.data.lastUsedReceive ?? -1, highestChange = this.session.data.lastUsedChange ?? -1;
    for (const account of this.accounts) {
      this.assertSession(epoch);
      if (rpc !== this.rpc) throw new Error('RPC connection changed.');
      onTip(this.tip ?? {});
      // Restored wallets must keep watching their unused gap: a payment may arrive
      // later at an address issued by the old installation before restoration.
      const reuseEmpty = stableRecoveryTip && emptyAddresses?.has(account.address);
      const transactions = reuseEmpty ? [] : await this.page('getaddresshistory', account.address, { onTip });
      reusedEmptyHistory ||= Boolean(reuseEmpty);
      if (transactions.length && account.change === 0) highestReceive = Math.max(highestReceive, account.index);
      if (transactions.length && account.change === 1) highestChange = Math.max(highestChange, account.index);
      const issuedIndex = this.session.data[account.change ? 'changeIndex' : 'receiveIndex'];
      if (!transactions.length && account.index > issuedIndex) continue;
      const balance = this.checkResponse(await this.rpc.request('getaddressbalance', { address: account.address }));
      onTip(balance.tip);
      if (balance.address !== account.address || balance.unit !== 'connects') throw new Error('Invalid RPC balance.');
      totals.confirmed += amount(balance.confirmed); totals.available += amount(balance.available_confirmed);
      totals.pending += amount(balance.pending_delta); totals.immature += amount(balance.immature);
      const rows = await this.page('getaddressutxos', account.address, { onTip });
      for (const row of rows) {
        if (!Number.isInteger(row.vout) || row.vout < 0 || row.vout > 0xffffffff || amount(row.amount) < 0n) throw new Error('Invalid RPC output.');
        utxos.push({ ...row, account });
      }
      for (const row of transactions) {
        const existing = history.get(row.txid) ?? { ...row, net: 0n };
        existing.net += amount(row.balance_delta);
        history.set(row.txid, existing);
      }
    }
    this.assertSession(epoch);
    if (rpc !== this.rpc) throw new Error('RPC connection changed.');
    if (reusedEmptyHistory) {
      onTip(await this.ensureNetwork());
      this.assertSession(epoch);
      // Some addresses may already have been skipped before a later response
      // revealed a changed tip. Re-read all addresses, with no recovery cache.
      if (!stableRecoveryTip) return this.refreshInternal(epoch);
    }
    this.utxos = utxos;
    this.balance = Object.fromEntries(Object.entries(totals).map(([key,value]) => [key, formatSigned(value)]));
    this.history = [...history.values()].sort((a,b) => (b.block_height ?? Number.MAX_SAFE_INTEGER) - (a.block_height ?? Number.MAX_SAFE_INTEGER)).map(row => ({
      txid: row.txid, direction: row.net < 0n ? 'sent' : row.net > 0n ? 'received' : 'self',
      amount: formatCoinAmount(row.net < 0n ? -row.net : row.net), status: row.status, confirmations: row.confirmations, blockHeight: row.block_height,
    }));
    if (highestReceive !== this.session.data.lastUsedReceive || highestChange !== this.session.data.lastUsedChange) {
      this.session.data.lastUsedReceive = highestReceive; this.session.data.lastUsedChange = highestChange;
      await this.persist(); this.assertSession(epoch); this.buildAccounts();
    }
    this.assertSession(epoch); this.error = null; this.emitState();
    if (this.engine.enabled) await this.syncBounties();
    return this.getState();
  }
  async funding(txid, { signal } = {}) {
    if (!HASH.test(txid)) throw new Error('Invalid transaction ID.');
    const cancelled = () => Object.assign(new Error('Funding lookup cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (signal?.aborted) throw cancelled();
    const wait = promise => {
      if (!signal) return promise;
      // The read is shared by claims/payment preparation. Cancel only this
      // consumer's wait; the remaining consumers still need its reply/cache.
      // Both handlers stay attached so a later shared failure is also observed.
      return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
        promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
          error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    };
    if (this.fundingCache.has(txid)) return this.fundingCache.get(txid);
    const epoch = this.epoch, rpc = this.rpc;
    const existing = this.fundingPending.get(txid);
    if (existing?.epoch === epoch && existing.rpc === rpc) return wait(existing.promise);
    if (this.fundingPending.size >= 256) throw new Error('Too many funding transactions are being prepared; retry shortly.');
    const entry = { epoch, rpc };
    entry.promise = Promise.resolve().then(async () => {
      this.assertSession(epoch);
      if (this.rpc !== rpc) throw new Error('RPC connection changed while preparing funding.');
      const result = await rpc.request('gettransaction', { txid });
      this.assertSession(epoch);
      if (this.rpc !== rpc) throw new Error('RPC connection changed while preparing funding.');
      const raw = this.checkResponse(result).transaction?.hex;
      if (transactionId(parseTransaction(raw)) !== txid) throw new Error('The RPC server supplied transaction bytes that do not match their ID.');
      if (this.fundingCache.size >= 256) this.fundingCache.delete(this.fundingCache.keys().next().value);
      this.fundingCache.set(txid, raw); return raw;
    }).finally(() => { if (this.fundingPending.get(txid) === entry) this.fundingPending.delete(txid); });
    this.fundingPending.set(txid, entry);
    return wait(entry.promise);
  }
  cancelSendPreview() {
    this.sendPreparation?.abort();
    this.sendPreparation = null;
    this.preview = null;
  }
  async previewSend({ address, amount: coins, feeRate = this.config.feeRate, domain, expectedConnections } = {}) {
    this.assertSession(); const epoch = this.epoch;
    if (this.session.data.needsRecovery) throw new Error('Wait for recovery discovery to finish before sending.');
    this.cancelSendPreview();
    const value = parseCoinAmount(coins); if (value <= 0n) throw new Error('Enter an amount greater than zero.');
    const preparation = new AbortController(), rpc = this.rpc;
    this.sendPreparation = preparation;
    const check = () => {
      this.assertSession(epoch);
      if (preparation.signal.aborted || this.sendPreparation !== preparation || this.rpc !== rpc) {
        throw Object.assign(new Error('Payment review cancelled. Review the payment again.'), { name: 'AbortError' });
      }
    };
    const verified = []; const keys = [];
    try {
      await waitForReview(this.refresh(), preparation.signal); check();
      const eligible = this.utxos.filter(u => u.status === 'confirmed' && u.mature === true && !this.reserved.has(`${u.txid}:${u.vout}`)).sort((a,b) => BigInt(a.amount) > BigInt(b.amount) ? -1 : 1);
      let total = 0n;
      for (const utxo of eligible.slice(0,256)) {
        const rawTransaction = await this.funding(utxo.txid, { signal: preparation.signal }); check();
        const key = deriveAccount(this.session.data.mnemonic, { network: this.config.network, index: utxo.account.index, change: utxo.account.change, passphrase: this.session.data.passphrase });
        keys.push(key.privateKey); verified.push({ ...utxo, rawTransaction, privateKey: key.privateKey });
        total += BigInt(utxo.amount);
        if (total > value + 100000000n) break;
      }
      check();
      const change = this.publicAccount(this.session.data.changeIndex, 1);
      const output = domain === undefined ? { address, amount: value.toString() } : { domain, amount: value.toString(), expectedConnections, rootVersion: 1, mask: 7 };
      const build = () => buildPayment({ utxos: verified, outputs: [output], changeAddress: change.address, network: this.config.network, feeRate });
      // Validate funding/fees/domain before opening a connection. No wallet keys
      // or transaction bytes are ever passed to the isolated capability helper.
      let payment = build(), policy = {};
      if (domain !== undefined) {
        output.domain = payment.transaction.outputs[0].domain;
        let result;
        try {
          result = await waitForReview(this.rsaProbe({ domain: output.domain, rootVersion: 1, validationTime: Math.floor(Date.now() / 1000) }, { signal: preparation.signal }), preparation.signal);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          result = { verified: false, status: 'failed' };
        }
        check();
        const rsaVerified = result?.verified === true && result.status === 'verified';
        output.mask = rsaVerified ? 6 : 7;
        if (rsaVerified) payment = build();
        const status = rsaVerified ? 'verified' : ['unavailable', 'timeout', 'busy'].includes(result?.status) ? result.status : 'failed';
        policy = { signatureAlgorithmsMask: output.mask, rsaProbeStatus: status, expectedConnections: String(expectedConnections ?? '1') };
      }
      check();
      // The selected mask and signed bytes are frozen together for confirmation.
      this.preview = { ...payment, ...policy, previewId: randomUUID(), epoch, expires: Date.now() + 120000, address: domain === undefined ? address : output.domain, amount: formatCoinAmount(value), changeIndex: change.index };
      return { previewId: this.preview.previewId, address: this.preview.address, amount: formatCoinAmount(value), fee: formatCoinAmount(BigInt(payment.fee)), total: formatCoinAmount(value + BigInt(payment.fee)), txid: payment.txid, type: domain === undefined ? 'payment' : 'p2c', ...policy };
    } finally {
      for (const key of keys) key.fill(0);
      if (this.sendPreparation === preparation) this.sendPreparation = null;
    }
  }
  async confirmSend({ previewId } = {}) {
    const preview = this.preview; this.preview = null;
    if (!preview || preview.previewId !== previewId || preview.expires < Date.now()) throw new Error('Payment review expired. Review the payment again.');
    this.assertSession(preview.epoch);
    await this.ensureNetwork(); this.assertSession(preview.epoch);
    // Persist the change path BEFORE broadcast; recovery must never rely on success responses.
    if (BigInt(preview.change) > 0n) {
      if (this.session.data.changeIndex >= 999 || this.session.data.changeIndex >= (this.session.data.lastUsedChange ?? -1) + 20) throw new Error('Too many unused change addresses. Wait for pending payments to appear before sending again.');
      this.session.data.changeIndex = Math.max(this.session.data.changeIndex, preview.changeIndex + 1);
      await this.persist(); this.assertSession(preview.epoch); this.buildAccounts();
    }
    for (const input of preview.selected) this.reserved.add(`${input.txid}:${input.vout}`);
    try {
      const result = await this.rpc.request('sendrawtransaction', { transaction_hex: preview.hex });
      if (result?.txid !== preview.txid) throw new Error('RPC returned an unexpected transaction ID.');
      if (this.session) void this.refresh().catch(() => {});
      return { txid: preview.txid, status: 'submitted' };
    } catch { throw new Error(`Broadcast was not confirmed. Check transaction ${preview.txid} before trying again; selected inputs remain reserved until the wallet is reopened.`); }
  }
  async saveConfig(input = {}) {
    const config = validateConfig({ ...this.config, ...input, network: this.config.network, rpc: { ...this.config.rpc, ...input.rpc }, claims: { ...this.config.claims, ...input.claims } }, { allowRegtest: this.allowRegtest });
    this.cancelSendPreview();
    this.epoch++; this.replacement = null; this.setup = null; this.rpc?.close(); this.refreshing = null;
    await this.engine.stop(); this.engine.clear(); this.preview = null;
    this.config = await writeConfig(this.directory, config, { allowRegtest: this.allowRegtest });
    this.claimBlocks.clear(); this.claimOutpoints?.clear(); this.claimCursor = null; this.connectClient();
    this.engine.setOptions({ connectionsPerSecond: config.claims.maxConnectionsPerSecond, concurrency: config.claims.maxConcurrent });
    this.emitState(); if (this.session) void this.refresh().catch(() => {}); return this.getState();
  }
  async setTheme({ theme } = {}) {
    validateTheme(theme);
    // Appearance is independent of keys, RPC and claims. Do not reconnect,
    // invalidate payment reviews or change the security epoch for a color change.
    this.config = await writeConfig(this.directory, { ...this.config, theme }, { allowRegtest: this.allowRegtest });
    this.emitState(); return this.getState();
  }
  async setDeveloperMode({ enabled } = {}) {
    validateDeveloperMode(enabled);
    // Diagnostic visibility is independent of wallet, RPC and claim execution.
    this.config = await writeConfig(this.directory, { ...this.config, developerMode: enabled }, { allowRegtest: this.allowRegtest });
    this.emitState(); return this.getState();
  }
  async setClaims({ enabled, maxConnectionsPerSecond, maxConcurrent, lookbackBlocks } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('Choose whether Automatic Claims should be enabled.');
    this.assertSession();
    const epoch = this.epoch, rpc = this.rpc, engine = this.engine;
    const generation = this.claimToggleGeneration = (this.claimToggleGeneration ?? 0) + 1;
    const check = () => {
      this.assertSession(epoch);
      if (this.rpc !== rpc || this.engine !== engine || this.claimToggleGeneration !== generation) throw new Error('Automatic Claims settings changed; try again.');
    };
    const config = validateConfig({ ...this.config, claims: { ...this.config.claims,
      ...(maxConnectionsPerSecond === undefined ? {} : { maxConnectionsPerSecond }),
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
      ...(lookbackBlocks === undefined ? {} : { lookbackBlocks }) } }, { allowRegtest: this.allowRegtest });
    if (enabled && !this.proofRunner && !this.connectionPoolFactory && !getClaimsHelper({ resourcesPath: this.resourcesPath })) throw new Error('Install the Automatic Claims helper first (npm run setup:claims), or use the packaged desktop app.');
    await engine.stop(); check();
    // A previous scan must settle before a new run can publish any state.
    if (enabled && this.bountySync) await this.bountySync.catch(() => {});
    check();
    const saved = await writeConfig(this.directory, config, { allowRegtest: this.allowRegtest });
    check(); this.config = saved;
    engine.setOptions({ connectionsPerSecond: saved.claims.maxConnectionsPerSecond, concurrency: saved.claims.maxConcurrent });
    if (enabled) {
      await this.ensureNetwork(); check();
      // Existing queue entries cannot run before the journal and window catch up.
      await engine.suspend(); check(); engine.start();
      void this.syncBounties().catch(error => {
        if (epoch !== this.epoch || this.rpc !== rpc || this.claimToggleGeneration !== generation) return;
        if (error?.name === 'AbortError' && error.code === 'ABORT_ERR' && !error.unknownOutcome) return;
        this.error = error.message; void engine.stop(); this.emitState();
      });
    }
    this.emitState(); return this.getState();
  }
  async blockBounties(hash, { rpc = this.rpc, epoch = this.epoch, height, check: parentCheck = () => {}, budget } = {}) {
    const check = () => {
      if (!this.session || epoch !== this.epoch || this.rpc !== rpc) {
        throw Object.assign(new Error('Bounty discovery cancelled after the wallet or connection changed.'), { name: 'AbortError', code: 'ABORT_ERR' });
      }
      parentCheck();
    };
    return readBountyBlock({ rpc, network: this.config.network, hash, height, check, budget });
  }
  async syncBounties() {
    if (!this.engine.enabled) return;
    if (this.bountySync) return this.bountySync;
    const epoch = this.epoch, rpc = this.rpc, engine = this.engine;
    const started = performance.now();
    const pending = this.syncBountiesInternal(epoch).catch(error => {
      const cancelled = error?.name === 'AbortError' && error.code === 'ABORT_ERR' && !error.unknownOutcome;
      this.recordDiagnostic(cancelled ? 'wallet.discovery_cancelled' : 'wallet.discovery_failed', {
        stage: 'discovery', ...(!cancelled ? { error } : {}), durationMs: Math.round(performance.now() - started),
      });
      if (!cancelled && epoch === this.epoch && this.rpc === rpc && this.engine === engine && engine.enabled) {
        this.error = error.message;
        // Never continue queued work after a partial/invalid discovery.
        void engine.stop();
      }
      throw error;
    }).finally(() => {
      if (this.bountySync === pending) {
        this.bountySync = null; this.scanningBounties = false; this.emitState();
      }
    });
    this.bountySync = pending; return pending;
  }
  async syncBountiesInternal(epoch) {
    const rpc = this.rpc, engine = this.engine;
    const check = () => {
      if (!this.session || epoch !== this.epoch || this.rpc !== rpc || this.engine !== engine || !engine.enabled) {
        throw Object.assign(new Error('Automatic Claims stopped or its connection changed.'), { name: 'AbortError', code: 'ABORT_ERR' });
      }
    };
    check(); this.scanningBounties = true; this.emitState();
    const result = await discoverBounties({
      rpc, network: this.config.network, lookback: this.config.claims.lookbackBlocks,
      previous: this.claimBlocks, cursor: this.claimCursor, check,
      onInvalidate: (row, reason) => reason === 'window_exit' ? engine.retire(row.txid, row.vout) : engine.remove(row.txid, row.vout),
      onWindow: snapshot => {
        // A retained in-flight row is no longer in the discovery block cache.
        // Still cancel it if a subsequent window reveals its block was replaced.
        const canonical = new Map(snapshot.blocks.map(block => [block.height, block.hash]));
        for (const key of engine.activeKeys()) {
          const row = this.claimOutpoints?.get(key);
          if (!row) continue;
          const blockHash = canonical.get(row.block_height);
          if (row.block_height > snapshot.tip.height || (blockHash && blockHash !== row.block_hash)) engine.remove(row.txid, row.vout);
        }
      },
      onReset: async () => { await engine.suspend(); check(); engine.clear({ preserveSelection: true }); },
      readBlock: (hash, options) => this.blockBounties(hash, { ...options, rpc, epoch }),
    });
    check();
    const available = [], outpoints = new Map();
    for (const rows of result.blocks.values()) for (const row of rows) {
      const key = bountyKey(row); outpoints.set(key, row);
      if (row.status === 'available' && row.root_certificates_version === 1 && !this.reserved.has(key)) available.push(row);
      else engine.remove(row.txid, row.vout);
    }
    // Only already-running, normally aged-out work can outlive discovery.
    // Preserve each outpoint until all its captures/submission have settled.
    for (const [key, row] of this.claimOutpoints ?? []) if (!outpoints.has(key)) {
      if (engine.hasActive(key) && engine.queue.get(key)?.retired) {
        outpoints.set(key, row); this.retiredClaims.set(key, row);
      } else engine.remove(row.txid, row.vout);
    }
    check(); this.claimBlocks = result.blocks; this.claimOutpoints = outpoints; this.claimCursor = result.cursor;
    this.tip = validateTip(result.tip, this.config.network);
    engine.retainCatalog(outpoints.values());
    engine.enqueue(available);
    check(); engine.resume();
  }
  async prepareAutomaticClaim(bounty, { signal, previous } = {}) {
    this.assertSession();
    const epoch = this.epoch, rpc = this.rpc, engine = this.engine;
    const check = () => {
      this.assertSession(epoch);
      if (signal?.aborted || !engine.enabled || this.engine !== engine || this.rpc !== rpc) throw Object.assign(new Error('Automatic Claims stopped.'), { name: 'AbortError' });
    };
    check();
    const current = this.claimOutpoints?.get(bountyKey(bounty));
    if (!current || current.status !== 'available' || this.reserved.has(bountyKey(current))) throw new Error('This bounty is no longer eligible for claiming.');
    // The validated tip is refreshed by wallet/discovery sync, not twice per
    // claim. MTP is a certificate-checking reference, not a bounty expiry rule.
    const tip = validateTip(this.tip, this.config.network);
    const rawTransaction = await this.funding(current.txid, { signal }); check();
    if (this.claimOutpoints?.get(bountyKey(current))?.status !== 'available') throw new Error('Bounty availability changed while preparing its claim.');
    // Preserve the fixed challenge and actual payout on retries, as Core does.
    // Reauthenticate funding and availability each time; never reuse a proposal
    // across a wallet/security epoch or RPC connection change.
    const reusable = previous?.epoch === epoch && previous.rpc === rpc && bountyKey(previous.bounty) === bountyKey(current);
    const rewardAddress = reusable ? previous.rewardAddress : this.getState().wallet.address;
    const prepared = prepareClaim({ bounty: current, rawTransaction, rewardAddress, fee: reusable ? previous.fee : estimateClaimFee(this.config.feeRate), network: this.config.network });
    check();
    return { ...prepared, epoch, rpc, rewardAddress, context: {
      domain: prepared.bounty.domain, txid: prepared.txid, input_index: 0,
      connection_work_target: prepared.bounty.target, root_certificates_version: prepared.bounty.rootVersion,
      signature_algorithms_mask: prepared.bounty.mask, validation_time: tip.mediantime,
    } };
  }
  async submitAutomaticClaim(prepared, proof, { signal } = {}) {
    const engine = this.engine;
    const check = () => {
      this.assertSession(prepared.epoch);
      if (signal?.aborted || !engine.enabled || this.engine !== engine || this.rpc !== prepared.rpc) throw Object.assign(new Error('Automatic Claims stopped.'), { name: 'AbortError' });
    };
    check();
    const key = bountyKey(prepared.bounty), current = this.claimOutpoints?.get(key);
    if (!current || current.status !== 'available' || this.reserved.has(key)) throw new Error('This bounty is no longer eligible for claiming.');
    const signed = attachClaimProof(prepared, proof); check();
    this.reserved.add(key);
    try {
      const result = await prepared.rpc.request('sendrawtransaction', { transaction_hex: signed.hex }, { signal });
      if (result?.txid !== signed.txid) throw new Error('RPC returned an unexpected claim transaction ID.');
      return { txid: signed.txid };
    } catch (error) {
      if (error?.name === 'AbortError' && error.notSent === true && !error.unknownOutcome) {
        // The transport proves no bytes were submitted. STOP during pacing or
        // connection setup must neither reserve an unspent bounty indefinitely
        // nor report an uncertain broadcast. Sent requests keep their outcome.
        if (this.epoch === prepared.epoch && this.rpc === prepared.rpc) this.reserved.delete(key);
        throw error;
      }
      if (isKnownClaimRejection(error)) {
        if (this.epoch === prepared.epoch && this.rpc === prepared.rpc) this.reserved.delete(key);
        // Keep numeric rejection codes for local diagnostics without retaining
        // backend text, transaction bytes or arbitrary response data.
        throw Object.assign(new Error('The node rejected this claim. Its bounty or proof may no longer be valid.'), {
          code: error.code, data: { node_code: error.data?.node_code },
        });
      }
      // A timeout, disconnect, mismatched reply or already-known TX can follow a
      // successful broadcast. Stop instead of producing and retrying another claim.
      const message = `Claim broadcast was not confirmed. Check transaction ${signed.txid} before enabling Automatic Claims again.`;
      if (this.epoch === prepared.epoch && this.rpc === prepared.rpc) this.error = message;
      // Close the global dispatch gate immediately, before another proof can
      // broadcast. Never await stop from one of the tasks it must drain.
      if (this.epoch === prepared.epoch && this.rpc === prepared.rpc && this.engine === engine) {
        void engine.stop(); this.emitState();
      }
      throw Object.assign(new Error(message), { code: error.code, data: { node_code: error.data?.node_code }, unknownOutcome: true });
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const refreshing = this.refreshing;
    // lock() publishes cleared sensitive state synchronously before its first await.
    const locking = this.lock();
    this.statePublisher.close();
    await locking; this.rpc?.close();
    // The interrupted refresh must publish its terminal diagnostic before the
    // lifecycle marker is flushed and Electron exits.
    await refreshing?.catch(() => {});
    // Finish any already-started atomic encrypted write before Electron exits.
    await this.persisting.catch(() => {});
    await this.walletWrite?.catch(() => {});
    this.recordDiagnostic('wallet.closed', { stage: 'lifecycle' });
    await this.diagnostics?.flush();
  }
}
