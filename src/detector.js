// Keep site-specific selectors here. These are conservative adapters, not an API contract.
const UNTRUSTED = '[data-message-author-role], .markdown, .prose, [data-testid="message-content"], pre, code, blockquote, [contenteditable="true"], textarea';
const STATUS_SELECTORS = '[data-task-status], [data-testid="task-status"], [data-testid="task-status-badge"], [data-testid="run-status"]';
const PENDING_SELECTORS = '[data-testid="approval-request"], [data-testid="request-user-input"], [data-testid="permission-request"]';
const STOP_SELECTORS = '[data-testid="stop-button"], [data-testid="stop-task-button"], [data-testid="interrupt-button"]';
const THINKING_SELECTORS = '[data-testid="thinking-indicator"], [data-testid="thinking-status"], [data-testid="reasoning-status"], [data-testid="reasoning-header"]';
const normalize = value => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
const statusLabel = value => normalize(value).replace(/^(?:task status|status|任务状态|状态)\s*[:：]\s*/, '').replace(/(?:\.{2,}|…+)\s*/g, ' ').replace(/[.。]+\s*$/, '').trim();
const pending = /^(awaiting[_ -](approval|input|review)|awaiting your (approval|input|review)|waiting for (approval|input|review)|needs (?:your )?review|requires action|等待批准|等待审批|等待输入|等待审阅|需要审阅|需要你处理)$/;
const running = /^(running|in progress|working|queued|thinking|generating|generating response|执行中|进行中|运行中|排队中|正在工作|正在执行|正在思考|思考中|生成中|正在生成)(?:\s*(?:[·•|]|for)?\s*(?:\d+:\d{2}(?::\d{2})?|\d+\s*(?:ms|s|m|h|seconds?|minutes?|hours?|秒|分钟)(?:\s*\d+\s*(?:s|m|秒|分钟))?))?$/;
const completed = /^(completed|complete|done|已完成|任务完成)$/;
const failed = /^(failed|error|失败|出错)$/;
const stopped = /^(stopped|cancelled|canceled|已停止|已取消)$/;
const approve = /^(approve|allow once|allow for this session|approve once|批准|允许一次|本次允许|允许本次会话|批准一次)$/;
const stopName = /^(stop|stop generating|stop task|interrupt|interrupt task|停止|停止生成|停止任务|中断|中断任务)(?:\s*\((?:esc|escape)\))?$/;
const MEDIA = 'audio, video, [data-testid*="audio"], [data-testid*="read-aloud"], [data-testid*="voice"], [aria-label="Audio player"], [aria-label="音频播放器"]';
const COMPOSER = 'form, [data-testid="composer"], [data-testid="task-controls"]';

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
  if (stopped.test(label)) return 'stopped';
  if (failed.test(label)) return 'error';
  if (completed.test(label)) return 'completed';
  if (/^(loading|加载中|正在加载)$/.test(label)) return 'loading';
  return 'unrecognized';
}
function markerState(element) {
  const attribute = element.getAttribute('data-task-status');
  if (attribute) return stateForLabel(attribute);
  const states = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')].map(stateForLabel);
  return ['attention', 'running', 'stopped', 'error', 'completed', 'loading'].find(state => states.includes(state)) || 'unrecognized';
}
function terminalMarker(element) {
  return markerState(element) === 'completed' && (element.matches(STATUS_SELECTORS) || element.closest('header, [data-testid="task-header"]') || /^(task status|任务状态)\s*[:：]/i.test(element.getAttribute('aria-label') || ''));
}
function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(36);
}

const REPLY_BODIES = '.markdown, .prose, [data-testid="message-content"]';
const GOOD_LABEL = /^(good response|thumbs up|like|like response|赞|点赞|好评|喜欢|喜欢此回复|评价不错|赞此回复)$/;
const BAD_LABEL = /^(bad response|thumbs down|dislike|dislike response|踩|点踩|差评|不喜欢|不喜欢此回复|评价不好|踩此回复)$/;
function feedbackKind(button) {
  if (!visible(button) || button.closest('pre, code, blockquote, .markdown, .prose, [data-message-author-role="user"], [contenteditable="true"], textarea')) return null;
  const names = [button.getAttribute('aria-label'), button.getAttribute('title')].map(normalize);
  if (button.matches('[data-testid="good-response-turn-action-button"]') || names.some(name => GOOD_LABEL.test(name))) return 'good';
  if (button.matches('[data-testid="bad-response-turn-action-button"]') || names.some(name => BAD_LABEL.test(name))) return 'bad';
  return null;
}
function replyEvidence(doc, allowLocalFallback) {
  const messages = [...doc.querySelectorAll('[data-message-author-role]')].filter(visible);
  const bodies = [...doc.querySelectorAll(REPLY_BODIES)].filter(el => visible(el) && !el.closest('pre, code, blockquote, form, nav, aside, [data-message-author-role="user"]'));
  // Nested prose/markdown wrappers are one body, rather than multiple replies.
  const outerBodies = bodies.filter(el => !bodies.some(other => other !== el && other.contains(el)));
  const feedback = [...doc.querySelectorAll('button, [role="button"]')].map(button => ({ button, kind: feedbackKind(button) })).filter(item => item.kind);
  const latestMessage = messages.at(-1);
  const role = latestMessage?.getAttribute('data-message-author-role');
  const diagnostics = { authoredMessages: messages.length, replyBodies: outerBodies.length, latestRole: ['assistant', 'user'].includes(role) ? role : 'none', feedbackGood: feedback.filter(item => item.kind === 'good').length, feedbackBad: feedback.filter(item => item.kind === 'bad').length, bodyFound: false, scopedGood: false, scopedBad: false, scopeDepth: 0 };
  const result = { key: '', finished: false, diagnostics };
  if (latestMessage && role !== 'assistant') return result;
  const last = latestMessage || (allowLocalFallback ? outerBodies.at(-1) : null);
  if (!last) return result;
  diagnostics.bodyFound = true;
  for (let scope = last, depth = 0; scope && scope !== doc.body && depth <= 8; scope = scope.parentElement, depth++) {
    // A scope containing another message can borrow old feedback, so stop here.
    if (messages.some(message => message !== last && scope.contains(message)) || (!latestMessage && outerBodies.some(body => body !== last && scope.contains(body)))) break;
    const scoped = feedback.filter(item => scope.contains(item.button));
    diagnostics.scopedGood = scoped.some(item => item.kind === 'good');
    diagnostics.scopedBad = scoped.some(item => item.kind === 'bad');
    diagnostics.scopeDepth = depth;
    if (diagnostics.scopedGood && diagnostics.scopedBad) break;
  }
  const body = last.matches(REPLY_BODIES) ? last : [...last.querySelectorAll(REPLY_BODIES)].find(visible);
  let text;
  if (body) text = body.textContent;
  else {
    const copy = last.cloneNode(true);
    for (const control of copy.querySelectorAll('button, [role="button"], [role="toolbar"]')) control.remove();
    text = copy.textContent;
  }
  // Feedback appearing or moving must not make an old reply look like a new one.
  result.key = hash((last.getAttribute('data-message-id') || last.id || '') + ':' + text);
  result.finished = Boolean(text.trim() && diagnostics.scopedGood && diagnostics.scopedBad);
  return result;
}

function stopBlockedReason(element) {
  if (!element || !visible(element)) return 'hidden';
  if (element.closest(UNTRUSTED)) return 'message-content';
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') return 'disabled';
  if (element.closest(MEDIA)) return 'media';
  const win = element.ownerDocument.defaultView;
  if (win.getComputedStyle(element).pointerEvents === 'none') return 'pointer-disabled';
  if (!opaque(element)) return 'transparent';
  const names = [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent];
  return element.matches(STOP_SELECTORS) || names.some(name => stopName.test(normalize(name))) ? null : 'not-stop';
}
export function isStopControl(target) {
  return stopBlockedReason(target?.closest?.(`${STOP_SELECTORS}, button, [role="button"]`)) === null;
}

function opaque(element) {
  const win = element.ownerDocument.defaultView;
  for (let node = element; node?.nodeType === 1; node = node.parentElement) {
    if (win.getComputedStyle(node).opacity === '0') return false;
  }
  return true;
}

function composerEvidence(main) {
  const editors = [...main.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(el => visible(el) && !el.disabled && !el.readOnly && !el.closest('[role="dialog"], [role="alertdialog"], [data-message-author-role], .markdown, .prose, pre, code, nav, aside'));
  const names = /^(send|send message|send prompt|发送|发送消息|发送提示|发送提示词)$/;
  const readyEditors = editors.filter(editor => {
    // Existing supported ChatGPT editor retains its explicit idle signal.
    if (editor.matches('#prompt-textarea, textarea[data-testid="prompt-textarea"]')) return true;
    const form = editor.closest(COMPOSER);
    if (!form || form.matches(PENDING_SELECTORS)) return false;
    return [...form.querySelectorAll('button, [role="button"]')].some(button => safe(button) && opaque(button) && (button.matches('[data-testid="send-button"]') || [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent].some(value => names.test(normalize(value)))));
  });
  return { editors: editors.length, readyEditors: readyEditors.length };
}

function strongStop(element) {
  return element.matches(STOP_SELECTORS) || [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
    .some(name => stopName.test(normalize(name)) && !/^(stop|停止)(?:\s*\((?:esc|escape)\))?$/.test(normalize(name)));
}

export function detect(doc, href) {
  const url = new URL(href);
  const isLocal = /^\/local(?:\/.*)?$/.test(url.pathname);
  const main = isLocal ? doc.body : doc.querySelector('main, [role="main"]');
  const isChat = /^\/(c\/[\w-]+|g\/[^/]+(?:\/c\/[\w-]+)?|)$/.test(url.pathname);
  const isTask = isLocal || /^\/(codex|work)\/(tasks?|task)\/[^/]+\/?$/.test(url.pathname);
  const kind = isTask ? 'task' : 'chat';
  const base = { kind, state: 'unknown', reason: isLocal ? '已连接 /local/ 页面，尚未找到明确的任务状态控件' : '尚未识别到受支持的任务状态', completionKey: '', diagnostics: { page: isLocal ? 'local' : isTask ? 'task' : isChat ? 'chat' : 'unsupported', rootFound: Boolean(main), stopControls: 0, statusMarkers: 0, pendingComponents: 0, streamingMessages: 0, thinkingControls: 0, finishedReply: false, runningSources: [], markerSamples: [] } };
  if (!main || (!isChat && !isTask)) return base;

  const reply = isChat || isLocal ? replyEvidence(doc, isLocal) : { key: '', finished: false };
  base.diagnostics.finishedReply = reply.finished;
  base.diagnostics.reply = reply.diagnostics || null;
  const composer = composerEvidence(main);
  base.diagnostics.composer = composer;
  base.completionKey = reply.key;
  const rawMarkers = [...main.querySelectorAll(isLocal ? `${STATUS_SELECTORS}, header [role="status"], [role="status"][aria-live]` : STATUS_SELECTORS)];
  const markers = rawMarkers.filter(el => safe(el) && !el.closest('[role="log"], [data-testid="task-history"]'));
  const markerStates = markers.map(markerState);
  const terminalMarkers = markers.filter(terminalMarker);
  if (isTask && terminalMarkers.length) base.completionKey = 'task:' + hash(url.pathname + ':' + terminalMarkers.map(el => `${el.getAttribute('data-task-id') || el.id || markers.indexOf(el)}:completed`).join('|'));
  const requests = [...main.querySelectorAll(PENDING_SELECTORS)].filter(safe);
  const stopCandidates = [...main.querySelectorAll(`${STOP_SELECTORS}, button, [role="button"]`)].filter(el => el.matches(STOP_SELECTORS) || [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].some(name => stopName.test(normalize(name))));
  const stops = stopCandidates.filter(el => isStopControl(el) && !(isLocal && reply.finished && !strongStop(el) && !el.closest(COMPOSER)));
  base.diagnostics.stopSamples = stopCandidates.slice(0, 8).map(el => ({
    typed: el.matches(STOP_SELECTORS), strong: strongStop(el), visible: visible(el),
    actionable: isStopControl(el), media: Boolean(el.closest(MEDIA)),
    inComposer: Boolean(el.closest(COMPOSER)), eligible: stops.includes(el),
    blockedReason: stopBlockedReason(el)
  }));
  const thinkingControls = [...main.querySelectorAll(THINKING_SELECTORS)].filter(el => safe(el) && !el.closest('[role="log"], [data-testid="task-history"]') && markerState(el) === 'running');
  base.diagnostics.thinkingControls = thinkingControls.length;
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
  const explicitRunningMarkers = markers.filter(el => markerState(el) === 'running' && (el.matches(STATUS_SELECTORS) || el.closest('header, [data-testid="task-header"]')));
  if (stops.length) base.diagnostics.runningSources.push('stop-control');
  if (streaming.length) base.diagnostics.runningSources.push('streaming-message');
  if (thinkingControls.length) base.diagnostics.runningSources.push('thinking-widget');
  if (explicitRunningMarkers.length) base.diagnostics.runningSources.push('task-status');
  const weakRunning = markerStates.includes('running') && !explicitRunningMarkers.length;
  if (weakRunning && !reply.finished) base.diagnostics.runningSources.push('live-region');
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
  if (base.diagnostics.runningSources.length) {
    return { ...base, state: 'running', reason: '检测到实时执行控件或状态' };
  }
  if (markerStates.includes('stopped')) return { ...base, state: 'stopped', reason: '页面显示任务已停止或取消' };
  if (markerStates.includes('error')) return { ...base, state: 'error', reason: '页面显示任务失败，请查看任务' };
  if (isTask && terminalMarkers.length) {
    return { ...base, state: 'completed', reason: '任务状态显示已完成' };
  }
  if ((isChat || isLocal) && reply.finished) return { ...base, state: 'completed', reason: '最新回复已出现赞/踩反馈控件' };
  if ((isChat || isLocal) && composer.readyEditors) {
    return { ...base, state: 'idle', reason: '消息输入区已就绪，未检测到执行或待处理信号' };
  }
  return base;
}
