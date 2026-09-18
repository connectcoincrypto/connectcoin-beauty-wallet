import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

const root = new URL('../', import.meta.url);
const read = (file, encoding) => readFile(new URL(file, root), encoding);

test('ConnectWallet package, repository and renderer use the current identity', async () => {
  const pkg = JSON.parse(await read('package.json', 'utf8'));
  const lock = JSON.parse(await read('package-lock.json', 'utf8'));
  assert.equal(pkg.name, 'connectcoin-connect-wallet');
  assert.equal(pkg.productName, 'ConnectWallet');
  assert.equal(pkg.repository.url, 'https://github.com/connectcoincrypto/connectcoin-connect-wallet.git');
  assert.equal(pkg.build.appId, 'com.connectcoincrypto.connectwallet');
  // Stable installer upgrade identity: a display-name change must not create a second install.
  assert.equal(pkg.build.nsis.guid, 'd88d5a21-77b9-537e-98d1-01560f964433');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  for (const file of ['src/ui/app.mjs', 'src/ui/index.html', 'src/preload.cjs', 'src/main.mjs']) {
    const source = await read(file, 'utf8');
    assert.doesNotMatch(source, /beauty/i, `${file} has obsolete branding`);
  }
  assert.match(await read('src/ui/app.mjs', 'utf8'), /window\.connectwallet/);
  assert.match(await read('src/ui/index.html', 'utf8'), /<title>ConnectWallet · ConnectCoin<\/title>/);
});

test('committed PNG and Windows icon frames reproduce the new artwork with transparent corners', async () => {
  const mark = await read('assets/connectwallet-mark.png');
  const template = await read('assets/icon.svg', 'utf8');
  const source = template.replace('href="connectwallet-mark.png"', `href="data:image/png;base64,${mark.toString('base64')}"`);
  const ico = await read('assets/icon.ico');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), sizes.length);
  let offset = 6 + 16 * sizes.length;
  for (const [i, size] of [...sizes, 512, 1024].entries()) {
    const rendered = new Resvg(source, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render();
    assert.equal(rendered.width, size);
    assert.equal(rendered.height, size);
    const rgba = rendered.pixels;
    for (const pixel of [0, size - 1, size * (size - 1), size * size - 1]) {
      assert.equal(rgba[pixel * 4 + 3], 0, `${size}px corner is not transparent`);
    }
    assert.equal(rgba[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3], 255);
    if (i < sizes.length) {
      const entry = 6 + i * 16;
      assert.equal(ico[entry], size === 256 ? 0 : size);
      assert.equal(ico[entry + 1], ico[entry]);
      assert.equal(ico.readUInt16LE(entry + 4), 1);
      assert.equal(ico.readUInt16LE(entry + 6), 32);
      assert.equal(ico.readUInt32LE(entry + 12), offset);
      const length = ico.readUInt32LE(entry + 8);
      assert.deepEqual(ico.subarray(offset, offset + length), rendered.asPng());
      offset += length;
    } else {
      assert.deepEqual(await read(size === 512 ? 'assets/icon-512.png' : 'assets/icon.png'), rendered.asPng());
    }
  }
  assert.equal(offset, ico.length);
});
