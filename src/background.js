import { aggregate, canonicalUrl, displayedTask, LABELS, transition } from './model.js';
import { connectTab, SITES } from './connection.js';

const COLORS = { running: '#54d69a', attention: '#f5bd4f', complete: '#ef6461', idle: '#ef6461', stopped: '#ef6461', error: '#ef6461' };
let queue = Promise.resolve();
function serial(work) {
  const next = queue.then(work);
  queue = next.catch(error => console.error('Traffic light:', error.message));
  return next;
}
async function read() {
  const { records = {}, notices = {}, notificationError = '' } = await chrome.storage.session.get(['records', 'notices', 'notificationError']);
  return { records, notices, notificationError };
}
function icon(status, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#172234';
  ctx.beginPath(); ctx.roundRect(size * .24, 0, size * .52, size, size * .16); ctx.fill();
  ['red', 'yellow', 'green'].forEach((lamp, index) => {
    const selected = lamp === (status === 'running' ? 'green' : status === 'attention' ? 'yellow' : COLORS[status] ? 'red' : null);
    ctx.beginPath(); ctx.arc(size / 2, size * (.19 + .31 * index), size * .125, 0, Math.PI * 2);
    ctx.fillStyle = selected ? COLORS[status] : '#384459'; ctx.fill();
  });
  return ctx.getImageData(0, 0, size, size);
}
async function render(records) {
  const tasks = Object.values(records).map(task => displayedTask(task, Date.now()));
  const status = aggregate(tasks);
  const attentionCount = new Set(tasks.filter(task => task.status === 'attention').map(task => task.url)).size;
  await Promise.all([
    chrome.action.setIcon({ imageData: { 16: icon(status, 16), 32: icon(status, 32) } }),
    chrome.action.setBadgeText({ text: attentionCount ? String(attentionCount) : '' }),
    chrome.action.setBadgeBackgroundColor({ color: COLORS.attention }),
    chrome.action.setTitle({ title: `ChatGPT 任务红绿灯 · ${tasks.length ? LABELS[status] : '等待打开任务页面'}` })
  ]);
}
function validObservation(value, sender) {
  const sourceUrl = canonicalUrl(sender.url);
  return sender.tab?.id !== undefined && sender.frameId === 0 && value &&
    typeof value.url === 'string' && canonicalUrl(value.url) === value.url && sourceUrl && new URL(sourceUrl).origin === new URL(value.url).origin &&
    typeof value.documentId === 'string' && value.documentId.length <= 100 &&
    ['running', 'attention', 'completed', 'idle', 'stopped', 'unknown', 'error'].includes(value.state) &&
    ['chat', 'task'].includes(value.kind) &&
    ['title', 'reason', 'completionKey', 'attentionKey'].every(key => value[key] === undefined || (typeof value[key] === 'string' && value[key].length <= 500));
}

let connectionRun;
async function reconnect() {
  if (connectionRun) return connectionRun;
  connectionRun = (async () => {
    let tabs;
    try { tabs = await chrome.tabs.query({ url: SITES }); }
    catch {
      await chrome.storage.session.set({ connectionError: '无法查找 ChatGPT 页面，请检查扩展的网站访问权限' });
      return { ok: false };
    }
    const results = await Promise.all(tabs.map(async tab => {
      const result = await connectTab(chrome, tab);
      if (!result.ok && canonicalUrl(tab.url)) await serial(async () => {
        const data = await read();
        data.records[tab.id] = {
          ...data.records[tab.id], tabId: tab.id, url: canonicalUrl(tab.url),
          documentId: `unconnected:${tab.id}`, active: false, candidate: null,
          title: tab.title || 'ChatGPT 页面', status: 'unknown', reason: result.reason, lastSeen: Date.now()
        };
        await chrome.storage.session.set({ records: data.records });
        await render(data.records);
      });
      return result;
    }));
    const failed = results.filter(result => !result.ok).length;
    const connectionError = failed ? `${failed} 个页面未连接：${results.find(result => !result.ok).reason}` : tabs.length ? '' : '未发现可连接的 ChatGPT 标签页。请在当前 Chrome 中打开任务，并允许扩展访问 chatgpt.com。';
    await chrome.storage.session.set({ connectionError });
    return { ok: failed === 0 && tabs.length > 0, connected: results.length - failed, found: tabs.length };
  })();
  try { return await connectionRun; } finally { connectionRun = null; }
}
async function observe(observation, sender) {
  if (!validObservation(observation, sender)) return { ok: false };
  const data = await read();
  const tabId = sender.tab.id;
  const { task, events } = transition(data.records[tabId], observation, Date.now());
  task.tabId = tabId;
  data.records[tabId] = task;
  const { notificationsEnabled = true } = await chrome.storage.local.get('notificationsEnabled');
  const pending = [];
  for (const event of events) {
    const identity = `${task.url}|${event}|${event === 'complete' ? task.finishedKey : task.attentionKey}`;
    if (Object.values(data.notices).some(notice => notice.tabId !== tabId && notice.identity === identity && Date.now() - notice.at < 30000)) continue;
    if (!notificationsEnabled) continue;
    const id = crypto.randomUUID();
    data.notices[id] = { identity, tabId, url: task.url, at: Date.now() };
    pending.push({ id, event });
  }
  data.notices = Object.fromEntries(Object.entries(data.notices).filter(([, notice]) => Date.now() - notice.at < 86400000));
  // Persist transitions before side effects; worker restarts cannot replay the same transition.
  await chrome.storage.session.set(data);
  await render(data.records);
  for (const { id, event } of pending) {
    try {
      const permission = await chrome.notifications.getPermissionLevel();
      if (permission !== 'granted') throw new Error('Chrome 通知权限未启用');
      await chrome.notifications.create(id, {
        type: 'basic', iconUrl: 'icons/128.png',
        title: event === 'attention' ? '需要你处理 · ChatGPT' : '任务已完成 · ChatGPT',
        message: task.title, contextMessage: '点击返回任务页面',
        priority: event === 'attention' ? 2 : 0,
        requireInteraction: event === 'attention'
      });
      await chrome.storage.session.set({ notificationError: '' });
    } catch (error) {
      await chrome.storage.session.set({ notificationError: `桌面通知未发送：${error.message}` });
    }
  }
  return { ok: true };
}

async function openTask(tabId, url) {
  if (!canonicalUrl(url)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (canonicalUrl(tab.url) !== url) throw new Error('Task moved');
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch { await chrome.tabs.create({ url }); }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'observation') {
    serial(() => observe(message.observation, sender)).then(respond, () => respond({ ok: false }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type === 'getState') {
    serial(async () => {
      const data = await read();
      const { notificationsEnabled = true } = await chrome.storage.local.get('notificationsEnabled');
      const { connectionError = '' } = await chrome.storage.session.get('connectionError');
      const tasks = Object.values(data.records).map(task => displayedTask(task, Date.now()));
      return { tasks, status: aggregate(tasks), notificationsEnabled, notificationError: data.notificationError, connectionError, version: chrome.runtime.getManifest?.().version || 'development' };
    }).then(respond, () => respond({ error: true }));
    return true;
  }
  if (message.type === 'setNotifications' && typeof message.enabled === 'boolean') {
    chrome.storage.local.set({ notificationsEnabled: message.enabled }).then(() => respond({ ok: true }));
    return true;
  }
  if (message.type === 'openTask') {
    serial(async () => {
      const { records } = await read();
      if (records[message.tabId]) await openTask(message.tabId, records[message.tabId].url);
    }).then(() => respond({ ok: true }));
    return true;
  }
  if (message.type === 'rescan') {
    reconnect().then(respond, () => respond({ ok: false }));
    return true;
  }
});
chrome.notifications.onClicked.addListener(id => {
  serial(async () => {
    const { notices } = await read();
    if (notices[id]) await openTask(notices[id].tabId, notices[id].url);
    await chrome.notifications.clear(id);
  });
});
chrome.tabs.onRemoved.addListener(tabId => serial(async () => {
  const data = await read(); delete data.records[tabId];
  await chrome.storage.session.set(data); await render(data.records);
}));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'complete') reconnect().catch(error => console.error(error.message));
  if (!change.url && !change.discarded && change.status !== 'loading') return;
  serial(async () => {
    const data = await read();
    if (!data.records[tabId]) return;
    if (change.url && canonicalUrl(change.url) !== data.records[tabId].url) delete data.records[tabId];
    else {
      data.records[tabId].status = 'unknown';
      data.records[tabId].reason = '页面正在重新加载或已休眠';
      data.records[tabId].candidate = null;
    }
    await chrome.storage.session.set(data); await render(data.records);
  });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'freshness') serial(async () => {
    const data = await read();
    const tabs = await chrome.tabs.query({});
    const alive = new Set(tabs.map(tab => tab.id));
    for (const id of Object.keys(data.records)) if (!alive.has(Number(id))) delete data.records[id];
    await chrome.storage.session.set(data); await render(data.records);
  });
});
chrome.alarms.create('freshness', { periodInMinutes: .5 });
chrome.runtime.onInstalled.addListener(() => reconnect().catch(error => console.error(error.message)));
chrome.runtime.onStartup.addListener(() => reconnect().catch(error => console.error(error.message)));
serial(async () => { const data = await read(); await render(data.records); }).then(() => reconnect()).catch(error => console.error(error.message));
