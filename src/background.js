import { aggregate, canonicalUrl, displayedTask, LABELS, transition } from './model.js';

const COLORS = { running: '#ef6461', attention: '#f5bd4f', complete: '#54d69a', idle: '#54d69a', unknown: '#8190a8', error: '#8190a8' };
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
  ['running', 'attention', 'complete'].forEach((lamp, index) => {
    const selected = lamp === status || (lamp === 'complete' && status === 'idle');
    ctx.beginPath(); ctx.arc(size / 2, size * (.19 + .31 * index), size * .125, 0, Math.PI * 2);
    ctx.fillStyle = selected ? COLORS[status] : '#384459'; ctx.fill();
  });
  if (['unknown', 'error'].includes(status)) {
    ctx.fillStyle = COLORS[status]; ctx.font = `bold ${size * .65}px sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(status === 'error' ? '!' : '?', size / 2, size * .74);
  }
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
  return sender.tab?.id !== undefined && sender.frameId === 0 && value &&
    canonicalUrl(value.url) === value.url && canonicalUrl(sender.url) === value.url &&
    typeof value.documentId === 'string' && value.documentId.length <= 100 &&
    ['running', 'attention', 'completed', 'idle', 'unknown', 'error'].includes(value.state) &&
    ['chat', 'task'].includes(value.kind) &&
    ['title', 'reason', 'completionKey', 'attentionKey'].every(key => value[key] === undefined || (typeof value[key] === 'string' && value[key].length <= 500));
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
      const tasks = Object.values(data.records).map(task => displayedTask(task, Date.now()));
      return { tasks, status: aggregate(tasks), notificationsEnabled, notificationError: data.notificationError };
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
    chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] }).then(async tabs => {
      await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'scan' })));
      respond({ ok: true });
    });
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
serial(async () => { const data = await read(); await render(data.records); });
