import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { loadUsage, readUsageInPage, usageView } from '../src/usage.js';

const future = Math.floor(Date.now() / 1000) + 3600;
const window = { used_percent: 27, limit_window_seconds: 18000, reset_at: future };
const payload = { rate_limit: { primary_window: window, secondary_window: { used_percent: 90, limit_window_seconds: 604800, reset_at: future } }, account_id: 'private-test-account' };
async function read(options = {}) {
  const calls = [];
  const fetch = async (path, init) => {
    calls.push({ path, init });
    if (options.networkError) throw new Error('sensitive response must not escape');
    const session = path === '/api/auth/session';
    const status = session ? (options.sessionStatus || 200) : (options.usageStatus || 200);
    return { ok: status === 200, status, json: async () => session ? (options.session ?? { accessToken: 'synthetic-test-token' }) : (options.payload ?? payload) };
  };
  // Chrome injects the serialized function: verify it also works without imports.
  const result = await runInNewContext(`(${readUsageInPage.toString()})()`, { fetch, location: { origin: options.origin || 'https://chatgpt.com' }, AbortSignal, Date });
  return { result: JSON.parse(JSON.stringify(result)), calls };
}

test('reads official 5h percentage/reset and returns no session or account data', async () => {
  const { result, calls } = await read();
  assert.equal(result.ok, true);
  assert.equal(result.remainingPercent, 73);
  assert.equal(result.resetAt, future * 1000);
  assert.deepEqual(Object.keys(result).sort(), ['fetchedAt', 'ok', 'remainingPercent', 'resetAt']);
  assert.deepEqual(calls.map(call => call.path), ['/api/auth/session', '/backend-api/wham/usage']);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer synthetic-test-token');
  assert.ok(calls.every(call => call.init.credentials === 'include' && call.init.cache === 'no-store' && call.init.redirect === 'error'));
});

test('zero remaining is valid; weekly-only and additional limits are never shown as 5h', async () => {
  assert.equal((await read({ payload: { rate_limit: { primary_window: { ...window, used_percent: 100 } } } })).result.remainingPercent, 0);
  assert.equal((await read({ payload: { rate_limit: { primary_window: { ...window, used_percent: 0 } } } })).result.remainingPercent, 100);
  const weekly = { ...window, limit_window_seconds: 604800 };
  for (const payload of [{ rate_limit: { primary_window: weekly } }, { additional_rate_limits: [{ rate_limit: { primary_window: window } }] }, {}]) {
    const { result } = await read({ payload });
    assert.equal(result.ok, false);
    assert.equal(result.remainingPercent, undefined);
  }
});

test('invalid percentages and reset timestamps fail closed', async () => {
  for (const changed of [{ used_percent: null }, { used_percent: '27' }, { used_percent: -1 }, { used_percent: 101 }, { used_percent: NaN }, { reset_at: null }, { reset_at: '2000000000' }, { reset_at: Infinity }, { reset_at: -1 }]) {
    assert.equal((await read({ payload: { rate_limit: { primary_window: { ...window, ...changed } } } })).result.ok, false);
  }
});

test('authentication, denied access, throttling and network errors show no fabricated quota', async () => {
  for (const options of [{ session: {} }, { sessionStatus: 401 }, { usageStatus: 403 }, { usageStatus: 429 }, { usageStatus: 500 }, { networkError: true }]) {
    const { result } = await read(options);
    assert.equal(result.ok, false);
    assert.equal(result.remainingPercent, undefined);
    assert.equal(JSON.stringify(result).includes('synthetic-test-token'), false);
    assert.equal(JSON.stringify(result).includes('sensitive response'), false);
  }
  assert.equal((await read({ origin: 'https://example.com' })).calls.length, 0);
});

test('background reads the active eligible ChatGPT tab and handles unavailable pages', async () => {
  let target;
  const api = {
    tabs: { query: async query => query.active ? [{ id: 3 }] : [{ id: 1, url: 'https://example.com/' }, { id: 2, url: 'https://chatgpt.com/c/a' }, { id: 3, url: 'https://chatgpt.com/local/' }, { id: 4, url: 'https://chatgpt.com/c/b', discarded: true }] },
    scripting: { executeScript: async options => { target = options; return [{ result: { ok: true, remainingPercent: 73 } }]; } }
  };
  assert.equal((await loadUsage(api)).remainingPercent, 73);
  assert.equal(target.target.tabId, 3);
  assert.equal(target.world, 'ISOLATED');
  assert.equal(target.func, readUsageInPage);
  api.tabs.query = async () => [];
  assert.equal((await loadUsage(api)).ok, false);
  api.tabs.query = async () => [{ id: 4, url: 'https://chatgpt.com/c/b', discarded: true }];
  assert.equal((await loadUsage(api)).ok, false);
  api.tabs.query = async () => [{ id: 2, url: 'https://chatgpt.com/' }];
  api.scripting.executeScript = async () => { throw new Error('permission'); };
  assert.equal((await loadUsage(api)).ok, false);
});

test('expired windows and stale results never imply refreshed or full quota', () => {
  const usage = { ok: true, remainingPercent: 73, resetAt: 500000, fetchedAt: 100000 };
  assert.equal(usageView(usage, 200000).available, true);
  assert.equal(usageView(usage, 400000).available, false);
  assert.equal(usageView({ ...usage, fetchedAt: 499999 }, 500000).available, false);
  assert.equal(usageView({ ok: false, reason: 'failed' }).detail, 'failed');
});
