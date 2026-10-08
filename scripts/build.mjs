import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { lampPixels } from '../src/lamp.js';
await mkdir('dist/icons', { recursive: true });
await build({ entryPoints: ['src/background.js', 'src/popup.js'], outdir: 'dist', bundle: true, format: 'esm', target: 'chrome120' });
await build({ entryPoints: ['src/content.js'], outdir: 'dist', bundle: true, format: 'iife', target: 'chrome120' });
for (const file of ['popup.html', 'popup.css']) await copyFile(`src/${file}`, `dist/${file}`);
await copyFile('manifest.json', 'dist/manifest.json');

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
for (const size of [16, 32, 128]) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const pixels = lampPixels('unknown', size);
  for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(`dist/icons/${size}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
console.log(`Built ${manifest.name} ${manifest.version} → dist/`);
