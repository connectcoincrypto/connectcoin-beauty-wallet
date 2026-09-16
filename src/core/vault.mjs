// Password encryption is separate from the optional BIP39 seed passphrase.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { networkParameters, normalizeMnemonic, validateMnemonic } from './crypto.mjs';

const derive = promisify(scrypt);
const KDF = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1, keyLength: 32 });
const LIMIT = 131072;
const FORMAT = 'connectcoin-beauty-wallet';
const VERSION = 1;

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) throw new Error('Use a wallet password of at least 12 characters (maximum 1,024 bytes)');
  return password;
}
function validatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validateMnemonic(value.mnemonic)) throw new Error('Invalid wallet recovery phrase');
  networkParameters(value.network);
  if (value.passphrase !== undefined && (typeof value.passphrase !== 'string' || value.passphrase.length > 1024)) throw new Error('Invalid BIP39 passphrase');
  return { ...value, mnemonic: normalizeMnemonic(value.mnemonic), network: value.network ?? 'testnet4' };
}
function header(envelope) {
  return Buffer.from(JSON.stringify({ format: envelope.format, version: envelope.version, kdf: envelope.kdf, cipher: envelope.cipher, salt: envelope.salt, nonce: envelope.nonce }), 'utf8');
}
function strictHex(value, bytes) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) throw new Error('Invalid encrypted wallet format');
  return Buffer.from(value, 'hex');
}
function validateEnvelope(value) {
  if (!value || value.format !== FORMAT || value.version !== VERSION || value.cipher !== 'aes-256-gcm' || JSON.stringify(value.kdf) !== JSON.stringify(KDF)) throw new Error('Unsupported encrypted wallet format or KDF parameters');
  strictHex(value.salt, 32);
  strictHex(value.nonce, 12);
  strictHex(value.tag, 16);
  if (typeof value.ciphertext !== 'string' || value.ciphertext.length < 2 || value.ciphertext.length > LIMIT || value.ciphertext.length % 2 || !/^[0-9a-f]+$/.test(value.ciphertext)) throw new Error('Invalid encrypted wallet ciphertext');
  return value;
}
async function keyFor(password, salt) {
  validatePassword(password);
  return derive(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 192 * 1024 * 1024 });
}
export async function encryptVault(payload, password) {
  validatePassword(password);
  const plaintext = Buffer.from(JSON.stringify(validatePayload(payload)), 'utf8');
  if (plaintext.length > LIMIT / 2) { plaintext.fill(0); throw new Error('Wallet data is too large'); }
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const envelope = { format: FORMAT, version: VERSION, kdf: { ...KDF }, cipher: 'aes-256-gcm', salt: salt.toString('hex'), nonce: nonce.toString('hex') };
  let key;
  try {
    key = await keyFor(password, salt);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(header(envelope));
    envelope.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('hex');
    envelope.tag = cipher.getAuthTag().toString('hex');
    return envelope;
  } finally { plaintext.fill(0); key?.fill(0); }
}
export async function decryptVault(envelope, password) {
  validateEnvelope(envelope);
  let key;
  let plaintext;
  try {
    key = await keyFor(password, Buffer.from(envelope.salt, 'hex'));
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'hex'));
    cipher.setAAD(header(envelope));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    plaintext = Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'hex')), cipher.final()]);
    return validatePayload(JSON.parse(plaintext.toString('utf8')));
  } catch { throw new Error('Cannot unlock wallet: incorrect password or damaged wallet file'); }
  finally { key?.fill(0); plaintext?.fill(0); }
}
async function safeFile(file, mustExist = false) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT + 4096) throw new Error('Unsafe or oversized wallet file');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' && !mustExist) return false;
    throw error;
  }
}
async function persist(file, envelope, replace) {
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Wallet directory must not be a symbolic link');
  if (await safeFile(destination)) {
    if (!replace) throw new Error('A wallet already exists at this location');
  } else if (replace) throw new Error('Wallet to update does not exist');
  const temporary = path.join(directory, `.wallet-${randomBytes(16).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // link() is atomic and refuses to replace an existing destination on create.
    if (replace) await rename(temporary, destination);
    else { await link(temporary, destination); await unlink(temporary); }
    await chmod(destination, 0o600);
    if (process.platform !== 'win32') {
      const directoryHandle = await open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
export async function createVault(file, payload, password) {
  await persist(file, await encryptVault(payload, password), false);
}
export async function unlockVault(file, password) {
  await safeFile(file, true);
  const value = await readFile(file, 'utf8');
  if (Buffer.byteLength(value) > LIMIT + 4096) throw new Error('Wallet file is too large');
  return decryptVault(JSON.parse(value), password);
}
export async function updateVault(file, payload, password) {
  // Prove the existing password before replacement; never overwrite blindly.
  await unlockVault(file, password);
  await persist(file, await encryptVault(payload, password), true);
}
export async function changeVaultPassword(file, currentPassword, newPassword) {
  const payload = await unlockVault(file, currentPassword);
  await persist(file, await encryptVault(payload, newPassword), true);
}
