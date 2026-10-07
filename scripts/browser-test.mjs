import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('dist');
const profile = await mkdtemp(path.join(tmpdir(), 'traffic-light-browser-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging']
});
const errors = [];
context.on('weberror', error => errors.push(error.error().message));
try {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  // Exercise real content scripts, runtime messages, storage and action APIs.
  // Capture the OS-notification boundary because this runner has no Windows desktop.
  await worker.evaluate(() => {
    globalThis.testNotifications = [];
    chrome.notifications.getPermissionLevel = async () => 'granted';
    chrome.notifications.create = async (id, options) => { globalThis.testNotifications.push({ id, ...options }); return id; };
  });
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><title>演示任务 · ChatGPT</title></head><body><main><div id="prompt-textarea" contenteditable="true"></div></main></body></html>' }));
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/c/test-run');
  async function records() { return worker.evaluate(async () => (await chrome.storage.session.get('records')).records || {}); }
  async function waitFor(check, description, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}; records=${JSON.stringify(await records())}`);
  }
  async function stateIs(status, url = 'https://chatgpt.com/c/test-run') {
    await waitFor(async () => Object.values(await records()).some(task => task.url === url && task.status === status), status);
  }
  const notices = () => worker.evaluate(() => globalThis.testNotifications);
  const replace = html => page.locator('main').evaluate((main, value) => { main.innerHTML = value; }, html);
  const stop = '<button data-testid="stop-button">Stop</button>';
  const reply = '<article><div data-message-author-role="assistant" data-message-id="new">已完成这次任务</div><button data-testid="good-response-turn-action-button">Good response</button><button data-testid="bad-response-turn-action-button">Bad response</button></article>';

  await stateIs('idle');
  assert.equal((await notices()).length, 0);
  await replace(reply);
  await stateIs('idle');
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal((await notices()).length, 0, 'Old replies must not notify');
  console.log('PASS initial/old conversation: no completion notification');

  await replace(reply + stop);
  await stateIs('running');
  const requestedAt = Date.now();
  await replace(reply + stop + '<div role="dialog"><h2>请批准本次操作</h2><button>Approve</button></div>');
  await stateIs('attention');
  await waitFor(async () => (await notices()).length === 1, 'yellow notification');
  assert.ok(Date.now() - requestedAt < 2000, 'Foreground yellow notification should arrive within 2 seconds');
  assert.match((await notices())[0].title, /需要你处理/);
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '1');
  await page.locator('main').evaluate(main => main.setAttribute('data-rerender', '1'));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await notices()).length, 1, 'Repeated DOM changes must not repeat yellow');
  console.log('PASS actionable approval: immediate yellow, badge, deduplicated notification');

  // Show two task states in the actual popup and save a screenshot for review.
  const other = await context.newPage();
  await other.goto('https://chatgpt.com/c/second-task');
  await other.locator('main').evaluate((main, html) => { main.innerHTML = html; }, stop);
  await stateIs('running', 'https://chatgpt.com/c/second-task');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole('heading', { name: '需要你处理', exact: true }).waitFor();
  await popup.locator('.task').nth(1).waitFor();
  await mkdir('artifacts', { recursive: true });
  await popup.setViewportSize({ width: 380, height: 680 });
  await popup.screenshot({ path: 'artifacts/popup.png', fullPage: true });
  await popup.getByRole('switch', { name: '桌面通知' }).uncheck({ force: true });
  await waitFor(() => worker.evaluate(async () => (await chrome.storage.local.get('notificationsEnabled')).notificationsEnabled === false), 'notification setting off');
  await popup.getByRole('switch', { name: '桌面通知' }).check({ force: true });
  await waitFor(() => worker.evaluate(async () => (await chrome.storage.local.get('notificationsEnabled')).notificationsEnabled === true), 'notification setting on');
  console.log('PASS popup: multiple tasks, yellow priority, settings, screenshot');

  await page.bringToFront();
  await replace(reply + stop);
  await stateIs('running');
  await replace('<div id="prompt-textarea" contenteditable="true"></div>');
  await stateIs('unknown');
  assert.equal((await notices()).length, 1, 'Disappearing stop button must not complete');
  await replace(reply.replace('已完成这次任务', '新的完整结果'));
  await stateIs('complete');
  await waitFor(async () => (await notices()).length === 2, 'completion notification');
  assert.match((await notices())[1].title, /任务已完成/);
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal((await notices()).length, 2, 'Completion notifies once');
  console.log('PASS running → ambiguous → confirmed completion: green once');

  await replace(reply + stop);
  await stateIs('running');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await replace(reply.replace('已完成这次任务', '中途停止的部分结果'));
  await stateIs('idle');
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal((await notices()).length, 2, 'Cancellation must not notify completion');
  console.log('PASS cancellation: no false green notification');

  await page.reload();
  await stateIs('idle');
  assert.equal((await notices()).length, 2);
  await other.close();
  await waitFor(async () => Object.values(await records()).length === 1, 'closed tab cleanup');
  assert.deepEqual(errors, []);
  console.log('PASS reload, tab cleanup and no uncaught browser errors');
  console.log('Browser extension integration checks passed. OS notification display and live authenticated ChatGPT DOM still require manual validation.');
} finally {
  await context.close();
}
