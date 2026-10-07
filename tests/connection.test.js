import test from 'node:test';
import assert from 'node:assert/strict';
import { connectTab } from '../src/connection.js';

test('an existing observer is scanned without reinjection or losing its baseline', async () => {
  const result = await connectTab({ tabs: { sendMessage: async () => ({ ok: true }) }, scripting: { executeScript: async () => assert.fail('must not inject') } }, { id: 1 });
  assert.deepEqual(result, { ok: true, injected: false });
});
test('a tab opened before installation is connected by injecting the observer', async () => {
  let injected = false;
  const api = {
    tabs: { sendMessage: async () => { if (!injected) throw new Error('Receiving end does not exist'); return { ok: true }; } },
    scripting: { executeScript: async options => { assert.deepEqual(options, { target: { tabId: 2 }, files: ['content.js'] }); injected = true; } }
  };
  assert.deepEqual(await connectTab(api, { id: 2 }), { ok: true, injected: true });
});
test('an unresponsive older script is replaced instead of silently succeeding', async () => {
  let injected = false;
  const api = { tabs: { sendMessage: async () => injected ? { ok: true } : undefined }, scripting: { executeScript: async () => { injected = true; } } };
  assert.equal((await connectTab(api, { id: 3 })).injected, true);
});
test('a site-permission failure explains what the user needs to change', async () => {
  const api = { tabs: { sendMessage: async () => { throw new Error('missing'); } }, scripting: { executeScript: async () => { throw new Error('Cannot access contents of the page. Extension manifest must request permission.'); } } };
  const result = await connectTab(api, { id: 4 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /访问权限/);
});
test('a discarded tab stays unknown and is not woken or reloaded automatically', async () => {
  const result = await connectTab({}, { id: 5, discarded: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /休眠/);
});
test('injecting a script without a working report is not counted as connected', async () => {
  const api = { tabs: { sendMessage: async () => ({ ok: false }) }, scripting: { executeScript: async () => {} } };
  assert.equal((await connectTab(api, { id: 6 })).ok, false);
});
