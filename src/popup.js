import { LABELS } from './model.js';
import { usageView } from './usage.js';
const $ = id => document.getElementById(id);
const order = ['attention', 'running', 'error', 'unknown', 'stopped', 'complete', 'idle'];
let lastRender = '';
let usage;
function renderUsage() {
  const view = usageView(usage);
  $('usage-percent').textContent = view.available ? `${Number(view.percent.toFixed(1))}%` : '—';
  $('usage-meter').hidden = !view.available;
  $('usage-meter').value = view.available ? view.percent : 0;
  $('usage-label').textContent = view.available ? '剩余额度' : '尚未确认额度';
  const time = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  $('usage-reset').textContent = view.available ? `重置时间：${time(view.resetAt)}` : view.detail;
  $('usage-updated').textContent = view.available ? `更新于 ${time(view.fetchedAt)} · 当前登录账号的默认额度` : '以官方用量页为准';
}
async function refreshUsage() {
  const button = $('refresh-usage');
  if (button.disabled) return;
  button.disabled = true;
  usage = null;
  renderUsage();
  try { usage = await chrome.runtime.sendMessage({ type: 'getUsage' }); }
  catch { usage = { ok: false, reason: '官方用量读取失败，请重试' }; }
  finally { button.disabled = false; renderUsage(); }
}
$('refresh-usage').addEventListener('click', refreshUsage);
$('open-usage').addEventListener('click', () => chrome.tabs.create({ url: 'https://chatgpt.com/codex/settings/usage' }));
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
    $('summary').textContent = state.tasks.length ? LABELS[state.status] : '等待连接';
    const count = state.tasks.filter(task => task.status === 'attention').length;
    $('summary-detail').textContent = count ? `${count} 个页面等待你的下一步` : !state.tasks.length ? '打开页面，让进度一目了然' : state.status === 'unknown' ? '尚未确认页面状态，请查看连接诊断' : '需要你时，这里会亮起黄灯';
    $('count').textContent = `${state.tasks.length} 个页面`;
    $('empty').hidden = Boolean(state.tasks.length);
    $('notifications').checked = state.notificationsEnabled;
    const error = [state.connectionError, state.notificationError].filter(Boolean).join('；');
    $('error').hidden = !error;
    $('error').textContent = error;
    $('diagnostics').textContent = JSON.stringify({ version: state.version, connection: state.connectionError || '已连接', pages: state.tasks.map(task => ({ state: task.status, signals: task.diagnostics })) }, null, 2);
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
async function reconnectPages() {
  const button = $('refresh');
  button.disabled = true;
  try { await chrome.runtime.sendMessage({ type: 'rescan' }); await refresh(); }
  catch { $('error').textContent = '重新连接失败，请重新加载扩展后再试'; $('error').hidden = false; }
  finally { button.disabled = false; }
}
$('refresh').addEventListener('click', reconnectPages);
$('inspect-ui').addEventListener('click', async () => {
  const button = $('inspect-ui');
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'inspectUI' });
    const area = $('ui-structure');
    area.hidden = false;
    area.value = result?.ok ? JSON.stringify(result.structure, null, 2) : result?.reason || '页面结构读取失败';
    area.focus(); area.select();
  } finally { button.disabled = false; }
});
$('open-chat').addEventListener('click', () => chrome.tabs.create({ url: 'https://chatgpt.com/' }));
chrome.storage.onChanged.addListener(() => refresh());
refresh();
reconnectPages();
refreshUsage();
setInterval(refresh, 5000);
setInterval(renderUsage, 1000);
