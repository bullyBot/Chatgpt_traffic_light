// Shared, dependency-free glass lens renderer for toolbar and packaged PNGs.
export const COLORS = { running: '#54d69a', attention: '#f5bd4f', complete: '#ef6461', idle: '#ef6461', stopped: '#ef6461', error: '#ef6461' };

export function lampPixels(status, size) {
  const color = COLORS[status] || '#263241';
  const base = color.match(/\w\w/g).map(value => parseInt(value, 16));
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (x + .5 - size / 2) / (size / 2);
    const ny = (y + .5 - size / 2) / (size / 2);
    const radius = Math.hypot(nx, ny);
    const offset = (y * size + x) * 4;
    if (radius > .98) continue;
    let rgb;
    if (radius > .82) {
      // Narrow brushed metal rim, brighter along its upper-left edge.
      const light = Math.max(0, (-nx - ny) / 2);
      const rim = radius > .93 ? 28 : 48 + 70 * light;
      rgb = [rim, rim + 8, rim + 15];
    } else {
      const shade = 1 - .38 * Math.pow(radius / .82, 3);
      const reflection = .38 * Math.exp(-((nx + .28) ** 2 / .15 + (ny + .40) ** 2 / .025));
      const texture = size >= 32 ? .015 * Math.cos(x * 2.4) * Math.cos(y * 2.4) : 0;
      rgb = base.map(channel => channel * (shade + texture) + (255 - channel) * reflection);
    }
    pixels.set([...rgb, Math.min(1, (.98 - radius) * size) * 255], offset);
  }
  return pixels;
}
