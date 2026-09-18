// Wallet-local scheduling policy shared with ConnectCoin Core. Not consensus.
export const PRIORITY_FACTOR_SCALE = 1_000_000;
export const PRIORITY_FACTOR_MAX = 1_100_000;
export const MIN_EXPECTED_RETURN = 1000; // connects / second of TCP/TLS effort
const MAX_MONEY = 1_000_000_000_000_000_000n;
const HASH_SPACE = 2 ** 256;

export const MAX_P2C_SUCCESSFUL_CONNECTIONS = (1n << 64n) - 1n;

/** Core's soft per-outpoint budget: only completed CertificateVerify captures
 * count. Equality with 2/p is still eligible; pending/failed TCP never reserves
 * budget. A saturated uint64 counter stops further starts, as in Core.
 */
export function isP2CClaimConnectionLimitExceeded(target, successes) {
  if (typeof target !== 'string' || !/^[0-9a-f]{64}$/.test(target)) throw new Error('Invalid claim work target');
  if (typeof successes === 'number' && Number.isSafeInteger(successes)) successes = BigInt(successes);
  if (typeof successes !== 'bigint' || successes < 0n) throw new Error('Invalid successful connection count');
  if (successes >= MAX_P2C_SUCCESSFUL_CONNECTIONS) return true;
  return successes * (BigInt(`0x${target}`) + 1n) > (1n << 257n);
}

export function claimPriority(target, netReward) {
  if (typeof target !== 'string' || target.length !== 64 || /[^0-9a-f]/.test(target)) return 0n;
  if (typeof netReward !== 'bigint' || netReward <= 0n || netReward > MAX_MONEY) return 0n;
  // Do not truncate target+1 to 256 bits: the easiest target has probability 1.
  return (BigInt(`0x${target}`) + 1n) * netReward;
}

export function selectionPriority(raw, factor) {
  if (!Number.isSafeInteger(factor) || factor < PRIORITY_FACTOR_SCALE || factor > PRIORITY_FACTOR_MAX) throw new Error('Invalid bounty priority factor');
  return raw * BigInt(factor);
}

export function domainPriority(priority, rate, scale = 1) {
  if (typeof priority !== 'bigint' || priority < 0n || priority >= (1n << 352n) || !Number.isFinite(scale) || scale <= 0) return NaN;
  // Match Core's most-significant-word-first conversion and operation order.
  // Domain performance is approximate; the bounty/tie key remains exact.
  let numerator = 0;
  for (let shift = 320n; shift >= 0n; shift -= 32n) numerator = numerator * 4294967296 + Number((priority >> shift) & 0xffffffffn);
  return (numerator / HASH_SPACE) * rate / scale;
}

export function isWorthAttempting(raw, rate) {
  const expected = domainPriority(raw, rate);
  return Number.isFinite(rate) && rate > 0 && Number.isFinite(expected) && expected >= MIN_EXPECTED_RETURN;
}

export function compareClaimPriority(a, b) {
  if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
  // Core's uint256 ordering uses storage bytes, not the displayed hash order.
  const hashOrder = Buffer.compare(Buffer.from(a.bounty.txid, 'hex').reverse(), Buffer.from(b.bounty.txid, 'hex').reverse());
  return hashOrder || a.bounty.vout - b.bounty.vout;
}

export class P2CDomainStats {
  constructor() { this.attempts = []; }
  record(success, seconds) {
    if (typeof success !== 'boolean' || !Number.isFinite(seconds) || seconds < 0) return;
    this.attempts.push([success, seconds]);
    if (this.attempts.length > 100) this.attempts.shift();
  }
  connectionRate() {
    let successes = 0, seconds = 0;
    for (const [success, elapsed] of this.attempts) { successes += Number(success); seconds += elapsed; }
    return (0.1 + successes) / (0.02 + seconds);
  }
}

export function validateAttemptStats(stats, maxAttempts) {
  if (!stats || !Number.isSafeInteger(stats.completed) || stats.completed < 0 || stats.completed > maxAttempts ||
      !Array.isArray(stats.recent) || stats.recent.length !== Math.min(100, stats.completed)) throw new Error('Invalid helper attempt statistics');
  for (const sample of stats.recent) {
    if (!Array.isArray(sample) || sample.length !== 2 || typeof sample[0] !== 'boolean' ||
        typeof sample[1] !== 'number' || !Number.isFinite(sample[1]) || sample[1] < 0 || sample[1] > 3600) throw new Error('Invalid helper attempt statistics');
  }
  return stats;
}
