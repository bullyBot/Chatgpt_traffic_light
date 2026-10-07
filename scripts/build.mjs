import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
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
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let rgba = x >= size * .23 && x <= size * .77 ? [23, 34, 52, 255] : [0, 0, 0, 0];
    [.19, .5, .81].forEach((center, i) => {
      if (Math.hypot(x + .5 - size / 2, y + .5 - size * center) < size * .12) rgba = [[239, 100, 97, 255], [245, 189, 79, 255], [84, 214, 154, 255]][i];
    });
    rows.set(rgba, y * (size * 4 + 1) + 1 + x * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(`dist/icons/${size}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
console.log(`Built ${manifest.name} ${manifest.version} → dist/`);
