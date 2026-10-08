import test from 'node:test';
import assert from 'node:assert/strict';
import { lampPixels } from '../src/lamp.js';

test('single lens preserves state colors at toolbar and package sizes', () => {
  for (const size of [16, 32, 128]) {
    for (const [status, expected] of Object.entries({ running: [84, 214, 154], attention: [245, 189, 79], idle: [239, 100, 97], unknown: [38, 50, 65] })) {
      const pixels = lampPixels(status, size);
      assert.equal(pixels.length, size * size * 4);
      assert.equal(pixels[3], 0, 'transparent corners');
      const center = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
      expected.forEach((value, channel) => assert.ok(Math.abs(pixels[center + channel] - value) <= 5, `${status} ${size}px`));
      assert.equal(pixels[center + 3], 255);
      assert.ok(pixels[(Math.floor(size / 2) * size + Math.floor(size * .2)) * 4 + 3] > 200, 'wide single lens');
    }
    for (const status of ['complete', 'stopped', 'error']) assert.deepEqual(lampPixels(status, size), lampPixels('idle', size));
  }
});
