// Keep site-specific selectors here. These are conservative adapters, not an API contract.
const UNTRUSTED = '[data-message-author-role], .markdown, .prose, [data-testid="message-content"], pre, code, blockquote, [contenteditable="true"], textarea';
const STATUS_SELECTORS = '[data-task-status], [data-testid="task-status"], [data-testid="task-status-badge"], [data-testid="run-status"]';
const PENDING_SELECTORS = '[data-testid="approval-request"], [data-testid="request-user-input"], [data-testid="permission-request"]';
const STOP_SELECTORS = '[data-testid="stop-button"], [data-testid="stop-task-button"], [data-testid="interrupt-button"]';
const THINKING_SELECTORS = '[data-testid="thinking-indicator"], [data-testid="thinking-status"], [data-testid="reasoning-status"], [data-testid="reasoning-header"], button[aria-expanded], [role="button"][aria-expanded]';
const normalize = value => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
const statusLabel = value => normalize(value).replace(/^(?:task status|status|任务状态|状态)\s*[:：]\s*/, '').replace(/(?:\.{2,}|…+)\s*/g, ' ').replace(/[.。]+\s*$/, '').trim();
const pending = /^(awaiting[_ -](approval|input|review)|awaiting your (approval|input|review)|waiting for (approval|input|review)|needs (?:your )?review|requires action|等待批准|等待审批|等待输入|等待审阅|需要审阅|需要你处理)$/;
const running = /^(running|in progress|working|queued|thinking|generating|generating response|执行中|进行中|运行中|排队中|正在工作|正在执行|正在思考|思考中|生成中|正在生成)(?:\s*(?:[·•|]|for)?\s*(?:\d+:\d{2}(?::\d{2})?|\d+\s*(?:ms|s|m|h|seconds?|minutes?|hours?|秒|分钟)(?:\s*\d+\s*(?:s|m|秒|分钟))?))?$/;
const completed = /^(completed|complete|done|已完成|任务完成)$/;
const failed = /^(failed|error|cancelled|canceled|失败|出错|已取消)$/;
const approve = /^(approve|allow once|allow for this session|approve once|批准|允许一次|本次允许|允许本次会话|批准一次)$/;
const stopName = /^(stop|stop generating|stop task|interrupt|interrupt task|停止|停止生成|停止任务|中断|中断任务)(?:\s*\((?:esc|escape)\))?$/;

export function visible(element) {
  if (!element || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const win = element.ownerDocument.defaultView;
  for (let node = element; node?.nodeType === 1; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    // Screen-reader announcement nodes are not the visible task status.
    if (['absolute', 'fixed'].includes(style.position) && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1 && (style.overflow === 'hidden' || style.clipPath === 'inset(50%)')) return false;
  }
  // jsdom has no layout; browser-side geometry also excludes hidden responsive copies.
  return /jsdom/i.test(win.navigator.userAgent) || element.getClientRects().length > 0;
}

function safe(element) { return visible(element) && !element.closest(UNTRUSTED); }
function stateForLabel(value) {
  const label = statusLabel(value);
  if (label.length > 120) return 'unrecognized';
  if (pending.test(label)) return 'attention';
  if (running.test(label)) return 'running';
  if (failed.test(label)) return 'error';
  if (completed.test(label)) return 'completed';
  if (/^(loading|加载中|正在加载)$/.test(label)) return 'loading';
  return 'unrecognized';
}
function markerState(element) {
  const attribute = element.getAttribute('data-task-status');
  if (attribute) return stateForLabel(attribute);
  const states = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')].map(stateForLabel);
  return ['attention', 'running', 'error', 'completed', 'loading'].find(state => states.includes(state)) || 'unrecognized';
}
function terminalMarker(element) {
  return markerState(element) === 'completed' && (element.matches(STATUS_SELECTORS) || element.closest('header, [data-testid="task-header"]') || /^(task status|任务状态)\s*[:：]/i.test(element.getAttribute('aria-label') || ''));
}
function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(36);
}

function replyEvidence(doc) {
  const messages = [...doc.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
  const last = messages.at(-1);
  if (!last) return { key: '', finished: false };
  const turn = last.closest('article, [data-testid^="conversation-turn-"]') || last;
  const key = hash((last.getAttribute('data-message-id') || turn.id || '') + ':' + last.textContent);
  const good = [...turn.querySelectorAll('[data-testid="good-response-turn-action-button"]')].some(safe);
  const bad = [...turn.querySelectorAll('[data-testid="bad-response-turn-action-button"]')].some(safe);
  return { key, finished: Boolean(last.textContent.trim() && good && bad) };
}

export function isStopControl(target) {
  const element = target?.closest?.(`${STOP_SELECTORS}, button, [role="button"]`);
  if (!element || !safe(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
  const names = [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent];
  return element.matches(STOP_SELECTORS) || names.some(name => stopName.test(normalize(name)));
}

export function detect(doc, href) {
  const url = new URL(href);
  const isLocal = /^\/local(?:\/.*)?$/.test(url.pathname);
  const main = isLocal ? doc.body : doc.querySelector('main, [role="main"]');
  const isChat = /^\/(c\/[\w-]+|g\/[^/]+(?:\/c\/[\w-]+)?|)$/.test(url.pathname);
  const isTask = isLocal || /^\/(codex|work)\/(tasks?|task)\/[^/]+\/?$/.test(url.pathname);
  const kind = isTask ? 'task' : 'chat';
  const base = { kind, state: 'unknown', reason: isLocal ? '已连接 /local/ 页面，尚未找到明确的任务状态控件' : '尚未识别到受支持的任务状态', completionKey: '', diagnostics: { page: isLocal ? 'local' : isTask ? 'task' : isChat ? 'chat' : 'unsupported', rootFound: Boolean(main), stopControls: 0, statusMarkers: 0, pendingComponents: 0, streamingMessages: 0, thinkingControls: 0, markerSamples: [] } };
  if (!main || (!isChat && !isTask)) return base;

  const reply = isChat ? replyEvidence(doc) : { key: '', finished: false };
  base.completionKey = reply.key;
  const rawMarkers = [...main.querySelectorAll(isLocal ? `${STATUS_SELECTORS}, header [role="status"], [role="status"][aria-live]` : STATUS_SELECTORS)];
  const markers = rawMarkers.filter(el => safe(el) && !el.closest('[role="log"], [data-testid="task-history"]'));
  const markerStates = markers.map(markerState);
  const terminalMarkers = markers.filter(terminalMarker);
  if (isTask && terminalMarkers.length) base.completionKey = 'task:' + hash(url.pathname + ':' + terminalMarkers.map(el => `${el.getAttribute('data-task-id') || el.id || markers.indexOf(el)}:completed`).join('|'));
  const requests = [...main.querySelectorAll(PENDING_SELECTORS)].filter(safe);
  const stops = [...main.querySelectorAll(`${STOP_SELECTORS}, button, [role="button"]`)].filter(isStopControl);
  const thinkingControls = [...main.querySelectorAll(THINKING_SELECTORS)].filter(el => safe(el) && !el.closest('[role="log"], [data-testid="task-history"]') && markerState(el) === 'running');
  // The local UI can render its ongoing thought label as a plain leaf badge.
  // Only the exact ongoing label is accepted; message prose, navigation and history are excluded.
  if (isLocal) for (const el of main.querySelectorAll('span, small')) {
    const label = statusLabel(el.textContent);
    if (!el.children.length && /^(正在思考|思考中|thinking)(?=$|\s)/.test(label) && stateForLabel(label) === 'running' && safe(el) && !el.closest('nav, aside, [role="navigation"], [role="menu"], [role="log"], [data-testid="task-history"], [data-testid="task-list"]')) thinkingControls.push(el);
  }
  const uniqueThinkingControls = [...new Set(thinkingControls)];
  base.diagnostics.thinkingControls = uniqueThinkingControls.length;
  base.diagnostics.stopControls = stops.length;
  base.diagnostics.statusMarkers = markers.length;
  base.diagnostics.rawStatusMarkers = rawMarkers.length;
  base.diagnostics.ignoredStatusMarkers = rawMarkers.length - markers.length;
  // No DOM text or attribute values are copied into diagnostics.
  base.diagnostics.markerSamples = rawMarkers.slice(0, 16).map(el => ({
    source: el.matches(STATUS_SELECTORS) ? 'task-marker' : 'live-region',
    tag: el.tagName.toLowerCase(), visible: visible(el), eligible: markers.includes(el),
    textLength: Math.min((el.textContent || '').trim().length, 10000),
    hasAccessibleLabel: Boolean(el.getAttribute('aria-label') || el.getAttribute('title')),
    recognized: markerState(el)
  }));
  const streaming = [...main.querySelectorAll('[data-message-author-role="assistant"][data-is-streaming="true"]')].filter(el => visible(el) && !el.closest('pre, code, blockquote, [contenteditable="true"]'));
  base.diagnostics.streamingMessages = streaming.length;
  base.diagnostics.pendingComponents = requests.length;
  // A live approval dialog is actionable. Quoted text and old assistant prose are not.
  const dialogs = [...doc.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(safe);
  const approval = dialogs.find(dialog => [...dialog.querySelectorAll('button')].some(button =>
    safe(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && approve.test(normalize(button.textContent || button.getAttribute('aria-label')))));
  const request = requests.find(el => [...el.querySelectorAll('button, input, textarea, select')].some(control => visible(control) && !control.disabled));
  if (markerStates.includes('attention') || approval || request) {
    const source = approval || request;
    const pendingMarker = markers.find(el => markerState(el) === 'attention');
    const label = source?.querySelector('h1, h2, h3, [role="heading"]')?.textContent || pendingMarker?.getAttribute('data-task-status') || pendingMarker?.textContent || '待处理请求';
    return { ...base, state: 'attention', reason: '页面正在等待批准、审阅或回答', attentionKey: hash(label + ':' + (source?.getAttribute('data-testid') || 'status')) };
  }
  if (stops.length || streaming.length || thinkingControls.length || markerStates.includes('running')) {
    return { ...base, state: 'running', reason: '页面显示任务正在执行' };
  }
  if (markerStates.includes('error')) return { ...base, state: 'error', reason: '页面显示任务失败或取消，请查看任务' };
  if (isTask && terminalMarkers.length) {
    return { ...base, state: 'completed', reason: '任务状态显示已完成' };
  }
  if (isChat && reply.finished) return { ...base, state: 'completed', reason: '本条回复出现反馈控件' };
  if (isChat && [...main.querySelectorAll('#prompt-textarea, textarea[data-testid="prompt-textarea"]')].some(visible)) {
    return { ...base, state: 'idle', reason: '聊天输入框已就绪' };
  }
  return base;
}
