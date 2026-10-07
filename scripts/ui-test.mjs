// Real Chromium DOM/timers/canvas with an explicit in-memory Chrome API harness.
// This is separate from test:browser, which loads the actual MV3 extension.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
const context = await browser.newContext();
const errors = [];
context.on('weberror', error => errors.push(error.error().message));
const background = await context.newPage();
background.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await context.route('https://background.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Extension API test harness</title>' }));
  await background.goto('https://background.test/');
  await background.evaluate(() => {
    function event() {
      const listeners = [];
      return { addListener: listener => listeners.push(listener), emit: (...args) => listeners.map(listener => listener(...args)), listeners };
    }
    const session = {}, local = {};
    const area = data => ({
      get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
      set: async values => Object.assign(data, structuredClone(values))
    });
    globalThis.testNotifications = [];
    globalThis.testTabs = {};
    globalThis.testAction = {};
    globalThis.testOpen = [];
    globalThis.notificationPermission = 'granted';
    globalThis.chrome = {
      runtime: { id: 'test-extension', onMessage: event() },
      storage: { session: area(session), local: area(local) },
      action: {
        setIcon: async value => { testAction.icon = value; },
        setBadgeText: async value => { testAction.badge = value.text; },
        setBadgeBackgroundColor: async () => {},
        setTitle: async value => { testAction.title = value.title; }
      },
      notifications: {
        getPermissionLevel: async () => notificationPermission,
        create: async (id, options) => { testNotifications.push({ id, ...options }); return id; },
        clear: async () => true, onClicked: event()
      },
      tabs: {
        onRemoved: event(), onUpdated: event(),
        query: async () => Object.values(testTabs),
        get: async id => { if (!testTabs[id]) throw new Error('closed'); return testTabs[id]; },
        update: async (id, options) => { testOpen.push({ id, ...options }); },
        create: async options => { testOpen.push(options); }, sendMessage: async () => {}
      },
      windows: { update: async () => {} },
      alarms: { create: async () => {}, onAlarm: event() }
    };
    globalThis.dispatch = (message, sender) => new Promise(resolve => {
      const pending = chrome.runtime.onMessage.emit(message, sender, resolve);
      if (!pending.includes(true)) resolve(null);
    });
  });
  await background.addScriptTag({ path: 'dist/background.js', type: 'module' });
  const shell = '<!doctype html><html><head><meta charset="utf-8"><title>演示任务 · ChatGPT</title></head><body><main><div id="prompt-textarea" contenteditable="true"></div></main></body></html>';
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: shell }));
  let nextId = 1;
  async function newTask(url) {
    const page = await context.newPage();
    const tabId = nextId++;
    await background.evaluate(({ tabId, url }) => { testTabs[tabId] = { id: tabId, url, windowId: 1 }; }, { tabId, url });
    await page.exposeFunction('__sendToExtension', message => background.evaluate(({ message, sender }) => dispatch(message, sender), { message, sender: { id: 'test-extension', frameId: 0, url: page.url(), tab: { id: tabId } } }));
    const content = await readFile('dist/content.js', 'utf8');
    await page.addInitScript({ content: `globalThis.chrome = { runtime: { id: 'test-extension', sendMessage: message => __sendToExtension(message), onMessage: { addListener() {} } } }; document.addEventListener('DOMContentLoaded', () => { ${content}\n });` });
    await page.goto(url);
    return { page, tabId };
  }
  const records = () => background.evaluate(async () => (await chrome.storage.session.get('records')).records || {});
  const notices = () => background.evaluate(() => testNotifications);
  async function waitFor(check, description, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}; ${JSON.stringify(await records())}`);
  }
  const { page, tabId } = await newTask('https://chatgpt.com/c/test-run');
  const stateIs = status => waitFor(async () => (await records())[tabId]?.status === status, status);
  const replace = html => page.locator('main').evaluate((main, value) => { main.innerHTML = value; }, html);
  const stop = '<button data-testid="stop-button">Stop</button>';
  const reply = '<article><div data-message-author-role="assistant" data-message-id="new">完整结果</div><button data-testid="good-response-turn-action-button">Good response</button><button data-testid="bad-response-turn-action-button">Bad response</button></article>';
  await stateIs('idle');
  await replace(reply);
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal((await notices()).length, 0);
  console.log('PASS browser DOM: initial idle / old reply do not notify');

  await replace(reply + stop);
  await stateIs('running');
  const requestAt = Date.now();
  await replace(reply + stop + '<div role="dialog"><h2>批准运行命令</h2><button>Approve</button></div>');
  await stateIs('attention');
  await waitFor(async () => (await notices()).length === 1, 'yellow notification');
  assert.ok(Date.now() - requestAt < 2000);
  assert.match((await notices())[0].title, /需要你处理/);
  assert.equal(await background.evaluate(() => testAction.badge), '1');
  await page.locator('main').evaluate(main => main.setAttribute('data-rerender', '1'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await notices()).length, 1);
  console.log('PASS browser DOM + background: yellow in <2s, notification once, toolbar badge');

  const second = await newTask('https://chatgpt.com/c/second-task');
  await second.page.locator('main').evaluate((main, value) => { main.innerHTML = value; }, stop);
  await waitFor(async () => (await records())[second.tabId]?.status === 'running', 'second task running');
  const popup = await context.newPage();
  await context.route('https://extension.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'popup.html';
    if (!['popup.html', 'popup.js', 'popup.css'].includes(file)) return route.abort();
    return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(`dist/${file}`) });
  });
  await popup.exposeFunction('__sendToExtension', message => background.evaluate(message => dispatch(message, { id: 'test-extension' }), message));
  await popup.addInitScript(() => {
    globalThis.chrome = { runtime: { sendMessage: message => __sendToExtension(message) }, storage: { onChanged: { addListener() {} } }, tabs: { create: async () => {} } };
  });
  await popup.goto('https://extension.test/popup.html');
  await popup.getByRole('heading', { name: '需要你处理', exact: true }).waitFor();
  await popup.locator('.task').nth(1).waitFor();
  assert.equal(await popup.locator('.task').count(), 2);
  await mkdir('artifacts', { recursive: true });
  await popup.setViewportSize({ width: 380, height: 680 });
  await popup.screenshot({ path: 'artifacts/popup.png', fullPage: true });
  await popup.getByRole('switch', { name: '桌面通知' }).uncheck({ force: true });
  await waitFor(() => background.evaluate(async () => (await chrome.storage.local.get('notificationsEnabled')).notificationsEnabled === false), 'notifications off');
  await popup.getByRole('switch', { name: '桌面通知' }).check({ force: true });
  await waitFor(() => background.evaluate(async () => (await chrome.storage.local.get('notificationsEnabled')).notificationsEnabled === true), 'notifications on');
  console.log('PASS popup: two pages, yellow priority, persistent notification switch');

  await replace(reply + stop);
  await stateIs('running');
  await replace('<div id="prompt-textarea" contenteditable="true"></div>');
  await stateIs('unknown');
  assert.equal((await notices()).length, 1);
  await replace(reply.replace('完整结果', '新的完整结果'));
  await stateIs('complete');
  await waitFor(async () => (await notices()).length === 2, 'completed notification');
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal((await notices()).length, 2);
  assert.match((await notices())[1].title, /任务已完成/);
  console.log('PASS browser DOM + background: missing control stays unknown; stable fresh reply notifies once');

  await replace(reply + stop);
  await stateIs('running');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await replace(reply.replace('完整结果', '中断的部分结果'));
  await stateIs('idle');
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal((await notices()).length, 2);
  console.log('PASS browser click capture: cancellation suppresses late completion');

  await replace(reply + stop);
  await stateIs('running');
  await page.keyboard.press('Escape');
  await replace(reply.replace('完整结果', '键盘取消后的部分结果'));
  await stateIs('idle');
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal((await notices()).length, 2);
  console.log('PASS keyboard cancellation: Escape cannot produce a false completion');

  await page.reload();
  await stateIs('idle');
  assert.equal((await notices()).length, 2);
  await background.evaluate(() => chrome.notifications.onClicked.emit(testNotifications[0].id));
  await waitFor(() => background.evaluate(() => testOpen.length > 0), 'notification click');
  assert.equal(await background.evaluate(() => testOpen[0].id), tabId);
  await second.page.close();
  await background.evaluate(id => { delete testTabs[id]; chrome.tabs.onRemoved.emit(id); }, second.tabId);
  await waitFor(async () => !(await records())[second.tabId], 'closed tab cleanup');
  console.log('PASS reload, notification return-to-tab and tab cleanup');

  // A denied notification is surfaced, not reported as successfully delivered.
  await background.evaluate(() => { notificationPermission = 'denied'; });
  await replace('<div role="dialog"><h2>新的审批</h2><button>Approve</button></div>');
  await stateIs('attention');
  await waitFor(() => background.evaluate(async () => Boolean((await chrome.storage.session.get('notificationError')).notificationError)), 'notification error visible');
  assert.equal((await notices()).length, 2);
  assert.deepEqual(errors, []);
  console.log('PASS notification denial is reported, no uncaught browser errors');
  console.log('Browser UI/integration harness passed. Chrome APIs were simulated; real MV3 loading and Windows notifications are separate acceptance checks.');
} finally { await browser.close(); }
