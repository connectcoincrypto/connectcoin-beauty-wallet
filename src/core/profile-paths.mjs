import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export const PROFILE_NAME = 'ConnectWallet';
export const VAULT_NAME = 'wallet.connectwallet.json';

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
/** Only the ConnectWallet profile is inspected; no discovery or migration. */
export function selectProfileDirectory(appData) {
  const directory = join(appData, PROFILE_NAME);
  selectVaultFile(directory);
  return directory;
}

export function selectVaultFile(directory) {
  const file = join(directory, VAULT_NAME);
  if (inspect(directory, 'directory')) inspect(file, 'file');
  return file;
}
