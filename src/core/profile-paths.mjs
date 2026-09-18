import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export const PROFILE_NAME = 'ConnectWallet';
export const VAULT_NAME = 'wallet.connectwallet.json';
// Compatibility identifiers only: existing profiles stay in place, including
// their encrypted wallet, preferences, backups and single-instance lock.
export const LEGACY_PROFILE_NAME = 'ConnectCoin Beauty Wallet';
export const LEGACY_VAULT_NAME = 'wallet.beauty.json';

function inspect(path, kind) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`The wallet ${kind} is not a regular ${kind}. No wallet files were changed.`);
    }
    return true;
  } catch (error) {
    // Permission and I/O errors are NOT evidence that an existing wallet is absent.
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function conflict(message) {
  throw Object.assign(new Error(`${message} Keep both locations safe and resolve the conflict before opening ConnectWallet. No wallet files were changed.`), { code: 'WALLET_PROFILE_CONFLICT' });
}
function inspectProfile(directory) {
  const exists = inspect(directory, 'directory');
  const current = exists && inspect(join(directory, VAULT_NAME), 'file');
  const legacy = exists && inspect(join(directory, LEGACY_VAULT_NAME), 'file');
  if (current && legacy) conflict('Both current and legacy encrypted wallet filenames exist in the same profile.');
  return { exists, vault: current || legacy, legacy };
}

/** Read-only selection: never migrate, duplicate or replace an encrypted wallet. */
export function selectProfileDirectory(appData) {
  const currentDirectory = join(appData, PROFILE_NAME);
  const legacyDirectory = join(appData, LEGACY_PROFILE_NAME);
  const current = inspectProfile(currentDirectory);
  const legacy = inspectProfile(legacyDirectory);
  if (current.vault && legacy.vault) conflict('Encrypted wallets exist in both ConnectWallet and the legacy profile folder.');
  if (legacy.vault) return legacyDirectory;
  if (current.vault || current.exists) return currentDirectory;
  return legacy.exists ? legacyDirectory : currentDirectory;
}

export function selectVaultFile(directory) {
  const profile = inspectProfile(directory);
  return join(directory, profile.legacy ? LEGACY_VAULT_NAME : VAULT_NAME);
}
