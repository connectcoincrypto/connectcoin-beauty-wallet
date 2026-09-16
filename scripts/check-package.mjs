import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = resolve(root, 'helpers/bin/beauty-claims', process.platform === 'win32' ? 'beauty-claims.exe' : 'beauty-claims');
try {
  await access(helper);
  await access(resolve(root, 'assets/icon.png'));
  await access(resolve(root, 'assets/icon.ico'));
} catch {
  throw new Error('Desktop packaging requires the native Automatic Claims helper and icons. Run npm run build:claims and npm run build:icon on this operating system first.');
}
await new Promise((accept, reject) => {
  const child = spawn(helper, ['--self-test'], { cwd: root, shell: false, windowsHide: true, stdio: 'inherit', timeout: 30000 });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? accept() : reject(new Error('Bundled Automatic Claims helper failed its self-test.')));
});
console.log('Native helper and desktop assets verified for packaging.');
