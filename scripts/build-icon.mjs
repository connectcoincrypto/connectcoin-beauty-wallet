// Render the committed ConnectWallet artwork deterministically. PNG-backed ICO entries
// are supported by modern Windows/Electron and preserve full alpha transparency.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const template = await readFile(path.join(assets, 'icon.svg'), 'utf8');
const mark = await readFile(path.join(assets, 'connectwallet-mark.png'));
assert.equal(mark.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert.equal((template.match(/href="connectwallet-mark\.png"/g) ?? []).length, 1);
// Embed only this known local asset; icon generation does not fetch resources.
const source = template.replace('href="connectwallet-mark.png"', `href="data:image/png;base64,${mark.toString('base64')}"`);
const sizes = [16, 24, 32, 48, 64, 128, 256];
await mkdir(assets, { recursive: true });

function render(size) {
  const image = new Resvg(source, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render();
  assert.equal(image.width, size);
  assert.equal(image.height, size);
  return image.asPng();
}

const pngs = sizes.map(render);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2); // Resource type ICON, not CURSOR.
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  header[entry] = sizes[i] === 256 ? 0 : sizes[i];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4); // One color plane.
  header.writeUInt16LE(32, entry + 6); // RGBA, 8 bits per channel.
  header.writeUInt32LE(pngs[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += pngs[i].length;
}
const ico = Buffer.concat([header, ...pngs]);
assert.equal(ico.length, offset);
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  const start = ico.readUInt32LE(entry + 12);
  assert.equal(ico.subarray(start, start + 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(ico.readUInt32BE(start + 16), sizes[i]);
  assert.equal(ico.readUInt32BE(start + 20), sizes[i]);
}
await Promise.all([
  writeFile(path.join(assets, 'icon.png'), render(1024)),
  writeFile(path.join(assets, 'icon-512.png'), render(512)),
  writeFile(path.join(assets, 'icon.ico'), ico),
]);
console.log('Built assets/icon.png (1024), assets/icon-512.png (512), and assets/icon.ico (16–256, seven sizes).');
