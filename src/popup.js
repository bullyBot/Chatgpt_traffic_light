import { LABELS } from './model.js';
const $ = id => document.getElementById(id);
const order = ['attention', 'running', 'error', 'unknown', 'complete', 'idle'];
let lastRender = '';
function element(tag, className, text) {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'getState' });
    if (!state || state.error) throw new Error('暂时无法连接，请重新打开扩展');
    const signature = JSON.stringify(state);
    if (signature === lastRender) return;
    lastRender = signature;
    $('signal').className = `signal ${state.status}`;
    $('summary').textContent = state.tasks.length ? LABELS[state.status] : '等待任务';
    const count = state.tasks.filter(task => task.status === 'attention').length;
    $('summary-detail').textContent = count ? `${count} 个页面等待你的下一步` : state.tasks.length ? '需要你时，这里会亮起黄灯' : '打开页面，让进度一目了然';
    $('count').textContent = `${state.tasks.length} 个页面`;
    $('empty').hidden = Boolean(state.tasks.length);
    $('notifications').checked = state.notificationsEnabled;
    $('error').hidden = !state.notificationError;
    $('error').textContent = state.notificationError;
    const fragment = document.createDocumentFragment();
    for (const task of state.tasks.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))) {
      const button = element('button', `task ${task.status}`, '');
      const top = element('div', 'task-top', '');
      top.append(element('span', 'status-dot', ''), element('span', 'task-title', task.title), element('span', 'task-status', LABELS[task.status]));
      button.append(top, element('p', 'task-reason', task.reason), element('p', 'task-time', `最近检查 ${new Date(task.lastSeen).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`));
      button.title = '打开此任务';
      button.addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'openTask', tabId: task.tabId }); window.close(); });
      fragment.append(button);
    }
    $('tasks').replaceChildren(fragment);
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
}
$('notifications').addEventListener('change', async event => {
  await chrome.runtime.sendMessage({ type: 'setNotifications', enabled: event.target.checked });
  await refresh();
});
$('refresh').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'rescan' }); await refresh(); });
$('open-chat').addEventListener('click', () => chrome.tabs.create({ url: 'https://chatgpt.com/' }));
chrome.storage.onChanged.addListener(() => refresh());
refresh();
setInterval(refresh, 5000);
