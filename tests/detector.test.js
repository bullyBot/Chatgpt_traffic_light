import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { detect, isStopControl } from '../src/detector.js';

function scan(html, path = '/c/test') {
  const dom = new JSDOM(`<main>${html}</main>`, { url: `https://chatgpt.com${path}` });
  try { return detect(dom.window.document, dom.window.location.href); }
  finally { dom.window.close(); }
}
const reply = '<article><div data-message-author-role="assistant" data-message-id="reply">结果</div><button data-testid="good-response-turn-action-button">Good response</button><button data-testid="bad-response-turn-action-button">Bad response</button></article>';
test('recognizes visible stop controls as running', () => {
  assert.equal(scan('<button data-testid="stop-button">停止</button>').state, 'running');
});
test('old assistant prose, code samples and quoted approval buttons never trigger yellow', () => {
  for (const tag of ['<div data-message-author-role="assistant">', '<pre>', '<blockquote>']) {
    const close = tag.startsWith('<div') ? '</div>' : tag === '<pre>' ? '</pre>' : '</blockquote>';
    assert.equal(scan(`${tag}<div role="dialog"><button>Approve</button></div><span data-task-status="awaiting_approval"></span>${close}`).state, 'unknown');
  }
  assert.equal(scan('<p>任务完成，请审阅。Running. Completed.</p>').state, 'unknown');
});
test('visible actionable approval dialogs notify; disabled and hidden dialogs do not', () => {
  assert.equal(scan('<div role="dialog"><h2>批准操作</h2><button>允许一次</button></div>').state, 'attention');
  for (const dialog of [
    '<div role="dialog" hidden><button>Approve</button></div>',
    '<div style="display:none"><div role="dialog"><button>Approve</button></div></div>',
    '<div role="dialog"><button disabled>Approve</button></div>',
    '<div role="dialog"><button aria-disabled="true">Approve</button></div>'
  ]) assert.equal(scan(dialog).state, 'unknown');
});
test('explicit user-input widget triggers yellow without reading the answer', () => {
  assert.equal(scan('<section data-testid="request-user-input"><h2>选择部署环境</h2><input><button>提交</button></section>').state, 'attention');
});
test('attention takes priority over a still-visible running control', () => {
  assert.equal(scan('<button data-testid="stop-button">Stop</button><div role="dialog"><button>Approve</button></div>').state, 'attention');
});
test('feedback controls qualify a final reply; a reply or Copy button alone does not', () => {
  assert.equal(scan(reply).state, 'completed');
  assert.equal(scan('<article><div data-message-author-role="assistant">结果</div><button data-testid="copy-turn-action-button">Copy</button></article>').state, 'unknown');
  assert.equal(scan(reply + '<button data-testid="stop-button">Stop</button>').state, 'running');
});
test('the newest incomplete reply prevents an older complete reply from looking finished', () => {
  assert.equal(scan(reply + '<article><div data-message-author-role="assistant">进行中…</div></article>').state, 'unknown');
});
test('task status adapters recognize explicit states on task detail pages', () => {
  for (const [input, expected] of [['running', 'running'], ['awaiting_approval', 'attention'], ['completed', 'completed'], ['failed', 'error'], ['cancelled', 'stopped'], ['已停止', 'stopped']]) {
    assert.equal(scan(`<span data-testid="task-status">${input}</span>`, '/codex/tasks/task_1').state, expected);
  }
});
test('task lists, login pages and unrecognized paths remain unknown', () => {
  for (const path of ['/codex', '/auth/login', '/unsupported']) assert.equal(scan('<span data-task-status="completed"></span>', path).state, 'unknown');
});
test('hidden completed markers cannot finish a task', () => {
  assert.equal(scan('<span data-task-status="completed" hidden></span>', '/codex/tasks/task_1').state, 'unknown');
});
test('a ready composer reports idle and cancellation recognizes nested click targets', () => {
  assert.equal(scan('<div id="prompt-textarea" contenteditable="true"></div>', '/').state, 'idle');
  const dom = new JSDOM('<button data-testid="stop-button"><span id="target">Stop</span></button>');
  assert.ok(isStopControl(dom.window.document.getElementById('target')));
  dom.window.close();
});
test('observations contain no chat text or question text', () => {
  const result = scan(reply.replace('结果', 'Sensitive content 1234567'));
  assert.equal(JSON.stringify(result).includes('Sensitive content'), false);
});
test('/local/ task pages support visible Stop and Interrupt controls', () => {
  for (const html of ['<button>Stop</button>', '<button aria-label="Interrupt (Esc)"><svg></svg></button>', '<button title="中断"><span>■</span></button>']) {
    const result = scan(html, '/local/');
    assert.equal(result.state, 'running');
    assert.equal(result.kind, 'task');
    assert.equal(result.diagnostics.page, 'local');
  }
});
test('/local/ also works without a main element and ignores quoted stop buttons', () => {
  const dom = new JSDOM('<div id="root"><button aria-label="Stop task">■</button></div>', { url: 'https://chatgpt.com/local/' });
  assert.equal(detect(dom.window.document, dom.window.location.href).state, 'running');
  dom.window.close();
  assert.equal(scan('<div data-message-author-role="assistant"><button>Stop</button></div>', '/local/').state, 'unknown');
});
test('/local/ includes a task stop control in a footer outside main', () => {
  const dom = new JSDOM('<main><p>Task output</p></main><footer><button aria-label="Interrupt">■</button></footer>', { url: 'https://chatgpt.com/local/' });
  assert.equal(detect(dom.window.document, dom.window.location.href).state, 'running');
  dom.window.close();
});
test('/local/ requires explicit live completion or approval signals', () => {
  assert.equal(scan('<p>Completed. Waiting for approval.</p>', '/local/').state, 'unknown');
  assert.equal(scan('<header><div role="status" aria-live="polite">Working</div></header>', '/local/').state, 'running');
  assert.equal(scan('<header><div role="status" aria-live="polite">Completed</div></header>', '/local/').state, 'completed');
  assert.equal(scan('<div role="dialog"><button>Approve</button></div>', '/local/').state, 'attention');
});
test('/local/ keeps existing completed markers in its baseline while another task runs', () => {
  const old = '<div data-task-status="completed" id="old-task"></div>';
  const active = scan(old + '<button>Interrupt</button>', '/local/');
  const after = scan(old, '/local/');
  assert.equal(active.state, 'running');
  assert.equal(active.completionKey, after.completionKey);
  assert.ok(active.completionKey);
});
test('twelve status nodes with a visible 正在思考 label are running without a Stop button', () => {
  const empty = '<div role="status" aria-live="polite"></div>'.repeat(11);
  const result = scan(empty + '<div role="status" aria-live="polite">正在思考</div>', '/local/');
  assert.equal(result.state, 'running');
  assert.equal(result.diagnostics.statusMarkers, 12);
  assert.equal(result.diagnostics.stopControls, 0);
  assert.equal(result.diagnostics.markerSamples.filter(sample => sample.recognized === 'running').length, 1);
});
test('ongoing thinking labels support ellipses, timers and accessible-label-only status', () => {
  for (const value of ['正在思考…', '正在思考...', '正在思考 · 12秒', 'Working… 1m 23s', 'Thinking...']) {
    assert.equal(scan(`<span data-testid="task-status">${value}</span>`, '/local/').state, 'running', value);
  }
  assert.equal(scan('<div role="status" aria-live="polite" aria-label="正在思考"></div>', '/local/').state, 'running');
  assert.equal(scan('<button aria-expanded="true">正在思考…</button>', '/local/').state, 'unknown');
  assert.equal(scan('<header><span>正在思考…</span></header>', '/local/').state, 'unknown');
});
test('old thinking summaries, prose and loading indicators cannot imply running or completion', () => {
  for (const value of ['已思考 12 秒', '思考了 12 秒', 'Loading...', 'Completed 2 of 5 steps', '正在思考如何完成这个任务']) {
    assert.equal(scan(`<div role="status" aria-live="polite">${value}</div>`, '/local/').state, 'unknown', value);
  }
  assert.equal(scan('<p>正在思考</p>', '/local/').state, 'unknown');
  assert.equal(scan('<div role="log"><div role="status" aria-live="polite">正在思考</div></div>', '/local/').state, 'unknown');
  assert.equal(scan('<div data-message-author-role="assistant"><button aria-expanded="true">正在思考</button></div>', '/local/').state, 'unknown');
  assert.equal(scan('<div class="markdown"><span>正在思考</span></div>', '/local/').state, 'unknown');
  assert.equal(scan('<nav><span>正在思考</span></nav>', '/local/').state, 'unknown');
  assert.equal(scan('<span>已思考 12 秒</span>', '/local/').state, 'unknown');
});
test('screen reader announcements and generic completion toasts are not task completion', () => {
  const result = scan('<div role="status" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden">Completed</div>', '/local/');
  assert.equal(result.state, 'unknown');
  assert.equal(result.diagnostics.rawStatusMarkers, 1);
  assert.equal(result.diagnostics.ignoredStatusMarkers, 1);
  assert.equal(scan('<div role="status" aria-live="polite">Completed</div>', '/local/').state, 'unknown');
});
test('explicit streaming attributes are running while quoted streaming samples are ignored', () => {
  assert.equal(scan('<div data-message-author-role="assistant" data-is-streaming="true">partial result</div>').state, 'running');
  assert.equal(scan('<pre><div data-message-author-role="assistant" data-is-streaming="true">sample</div></pre>').state, 'unknown');
});
test('expanded marker diagnostics do not contain raw text, labels, task IDs or credentials', () => {
  const result = scan('<div data-task-id="private-task-id" role="status" aria-live="polite" aria-label="secret-value">private output secret-value</div>', '/local/');
  const output = JSON.stringify(result.diagnostics);
  assert.equal(output.includes('secret-value'), false);
  assert.equal(output.includes('private output'), false);
  assert.equal(output.includes('private-task-id'), false);
  assert.equal(result.diagnostics.markerSamples[0].recognized, 'unrecognized');
});

const localReply = '<section><div class="markdown">本轮完整结果</div><div><button aria-label="Good response">赞</button><button aria-label="Bad response">踩</button></div></section>';
test('completed local reply ignores historical user thinking bubble and ambiguous Stop', () => {
  const result = scan('<div><span>正在思考</span></div>' + localReply + '<button aria-label="Stop">■</button>', '/local/');
  assert.equal(result.state, 'completed');
  assert.equal(result.diagnostics.finishedReply, true);
  assert.equal(result.diagnostics.thinkingControls, 0);
  assert.equal(result.diagnostics.stopControls, 0);
  assert.equal(result.diagnostics.stopSamples[0].eligible, false);
});
test('invisible, non-interactive and media Stop controls cannot imply running', () => {
  for (const html of [
    '<div style="opacity:0"><button data-testid="stop-button">Stop</button></div>',
    '<button style="pointer-events:none" data-testid="stop-button">Stop</button>',
    '<section data-testid="audio-player"><button>Stop</button></section>',
    '<button hidden data-testid="stop-button">Stop</button>'
  ]) {
    assert.equal(scan(html, '/local/').state, 'unknown');
    assert.equal(scan(localReply + html, '/local/').state, 'completed');
  }
});
test('strong task controls and composer Stop take priority over an old final reply', () => {
  for (const html of ['<button data-testid="stop-button">Stop</button>', '<button aria-label="Interrupt (Esc)">■</button>', '<button>停止生成</button>', '<form><button>Stop</button></form>']) {
    assert.equal(scan(localReply + html, '/local/').state, 'running');
  }
  assert.equal(scan(reply + '<button>Stop</button>').state, 'running');
  assert.equal(scan('<span data-testid="thinking-indicator">正在思考…</span>', '/local/').state, 'running');
});
test('feedback on older turns, quoted controls or a lone action does not end the latest local reply', () => {
  for (const html of [localReply + '<section><div class="markdown">新回复尚未完成</div></section>', '<div class="markdown">代码示例<button aria-label="Good response">赞</button><button aria-label="Bad response">踩</button></div>', '<section><div class="markdown">结果</div><button aria-label="Good response">赞</button></section>', reply + '<div data-message-author-role="user">新问题</div>']) {
    assert.equal(scan(html, '/local/').state, 'unknown');
  }
});
test('final local feedback overrides a stale generic thinking announcement, but not typed execution', () => {
  assert.equal(scan(localReply + '<div role="status" aria-live="polite">正在思考</div>', '/local/').state, 'completed');
  assert.equal(scan(localReply + '<div data-task-status="running"></div>', '/local/').state, 'running');
});
test('a Stop button can override a parent pointer-events:none and still represent execution', () => {
  const html = '<form style="pointer-events:none"><button aria-label="Stop" style="pointer-events:auto">■</button></form>';
  for (const path of ['/c/test', '/local/']) {
    const result = scan(html, path);
    assert.equal(result.state, 'running');
    assert.equal(result.diagnostics.stopSamples[0].blockedReason, null);
  }
  const blocked = scan('<form><button aria-label="Stop" style="pointer-events:none">■</button></form>');
  assert.equal(blocked.state, 'unknown');
  assert.equal(blocked.diagnostics.stopSamples[0].blockedReason, 'pointer-disabled');
});
test('reply footers can be siblings of authored messages without an article wrapper', () => {
  const html = '<section><div data-message-author-role="assistant">结果</div><div><button aria-label="喜欢">赞</button><button aria-label="不喜欢">踩</button></div></section>';
  for (const path of ['/c/test', '/local/']) {
    const result = scan(html, path);
    assert.equal(result.state, 'completed');
    assert.equal(result.diagnostics.reply.scopedGood, true);
    assert.equal(result.diagnostics.reply.scopedBad, true);
  }
  assert.equal(scan(html + '<section><div data-message-author-role="assistant">新回复</div></section>').state, 'unknown');
});
test('nested prose and markdown wrappers form one local reply and find its nearby feedback', () => {
  const html = '<section><div><div class="prose"><div class="markdown">结果</div></div></div><footer><button title="Thumbs up">赞</button><button title="Thumbs down">踩</button></footer></section>';
  const result = scan(html, '/local/');
  assert.equal(result.state, 'completed');
  assert.equal(result.diagnostics.reply.replyBodies, 1);
  assert.equal(scan(html + '<section><div class="prose"><div class="markdown">下一轮部分结果</div></div></section>', '/local/').state, 'unknown');
});
test('visible ready Send and a custom editor establish idle without claiming completion', () => {
  const html = '<form><div contenteditable="true" role="textbox"></div><button aria-label="发送消息" disabled>↑</button><button aria-label="Stop" hidden>■</button></form>';
  for (const path of ['/c/test', '/local/']) {
    const result = scan(html, path);
    assert.equal(result.state, 'idle');
    assert.equal(result.diagnostics.composer.readyEditors, 1);
    assert.equal(result.completionKey, '');
    assert.equal(scan(html + '<button data-testid="stop-button">Stop</button>', path).state, 'running');
    assert.equal(scan(html + '<div role="dialog"><button>Approve</button></div>', path).state, 'attention');
  }
});
test('generic forms, hidden Send buttons and request editors cannot imply idle', () => {
  for (const html of ['<form><textarea></textarea><button>Search</button></form>', '<form><textarea></textarea><div style="opacity:0"><button aria-label="Send">↑</button></div></form>', '<div role="dialog"><form><textarea></textarea><button aria-label="Send">↑</button></form></div>', '<form data-testid="request-user-input"><textarea></textarea><button aria-label="Send">↑</button></form>']) {
    assert.notEqual(scan(html, '/local/').state, 'idle');
  }
});
test('reply and composer diagnostics disclose structure without body text or editor content', () => {
  const result = scan('<section><div class="markdown">PRIVATE_REPLY</div><button aria-label="Good response">PRIVATE_LABEL</button><button aria-label="Bad response">PRIVATE_LABEL</button></section><form><textarea>PRIVATE_INPUT</textarea><button aria-label="Send">↑</button></form>', '/local/');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(result.diagnostics.reply.bodyFound, true);
  assert.equal(result.diagnostics.composer.readyEditors, 1);
});
test('feedback appearing in another wrapper cannot turn the same old reply into fresh completion evidence', () => {
  const before = '<section id="turn"><div data-message-author-role="assistant"><div class="markdown">已有结果</div></div><button aria-label="Good response" hidden>赞</button><button aria-label="Bad response" hidden>踩</button></section><button data-testid="stop-button">Stop</button>';
  const after = before.replaceAll(' hidden', '').replace('<button data-testid="stop-button">Stop</button>', '');
  assert.equal(scan(before).state, 'running');
  assert.equal(scan(after).state, 'completed');
  assert.equal(scan(before).completionKey, scan(after).completionKey);
  const inside = '<div data-message-author-role="assistant" id="reply">已有结果<button aria-label="Good response">赞</button><button aria-label="Bad response">踩</button></div>';
  assert.equal(scan(inside).completionKey, scan(inside.replace('<button aria-label="Good response">赞</button><button aria-label="Bad response">踩</button>', '')).completionKey);
  assert.equal(scan('<div data-message-author-role="assistant"><button aria-label="Good response">赞</button><button aria-label="Bad response">踩</button></div>').state, 'unknown');
});
test('latest finished assistant reply explicitly asking for input or review turns yellow', () => {
  for (const text of ['请提供这两个按钮的 HTML，贴到这里。', '请你补充运行日志。', '请确认是否可以发布。', '请审阅这个修改。', 'Please paste the error log.']) {
    const result = scan(reply.replace('结果', `<p>${text}</p>`));
    assert.equal(result.state, 'attention', text);
    assert.equal(result.diagnostics.attentionSource, 'reply-request');
    assert.ok(result.attentionKey);
  }
  assert.equal(scan(reply.replace('结果', '<p>请提供运行日志。</p>') + '<button data-testid="stop-button">Stop</button>').state, 'running');
});
test('conditional advice, quotes, old asks and user messages never become text-based yellow', () => {
  for (const text of ['如果还有问题，请提供日志。', '例如，请确认是否发布。', '你可以选择其中一种。', '任务已完成。', '<pre>请提供日志。</pre>', '<blockquote>请你补充日志。</blockquote>']) {
    assert.equal(scan(reply.replace('结果', text)).state, 'completed', text);
  }
  const ask = reply.replace('结果', '<p>请提供日志。</p>');
  assert.equal(scan(ask + reply.replace('结果', '信息已收到')).state, 'completed');
  assert.equal(scan(ask + '<div data-message-author-role="user">请提供日志</div>').state, 'unknown');
  assert.equal(scan('<section><div class="markdown">请提供日志。</div><button aria-label="Good response">赞</button><button aria-label="Bad response">踩</button></section>', '/local/').state, 'completed');
});
test('an actionable question form without test IDs triggers yellow, including latest assistant cards', () => {
  const card = '<form><fieldset><legend>请选择环境</legend><input type="radio"><button>提交回答</button></fieldset></form>';
  for (const html of [card, `<div data-message-author-role="assistant">${card}</div>`]) {
    const result = scan(html, '/local/');
    assert.equal(result.state, 'attention');
    assert.equal(result.diagnostics.attentionSource, 'input-card');
  }
  for (const html of [`<pre>${card}</pre>`, `<div class="markdown">${card}</div>`, card.replace('<fieldset>', '<fieldset disabled>'), card.replace('<button>', '<button disabled>'), `<div data-message-author-role="assistant">${card}</div><div data-message-author-role="assistant">已经处理</div>`]) {
    assert.notEqual(scan(html, '/local/').state, 'attention');
  }
});
test('request diagnostics and notification keys never expose question or reply text', () => {
  const result = scan(reply.replace('结果', '<p>请提供 PRIVATE_SECRET 日志。</p>'));
  assert.equal(result.state, 'attention');
  assert.equal(JSON.stringify(result).includes('PRIVATE_SECRET'), false);
});
test('typed input widgets within the latest assistant turn are active; historical or quoted widgets are not', () => {
  const card = '<section data-testid="request-user-input"><h2>选择环境</h2><input type="radio"><button>回答</button></section>';
  const turn = `<div data-message-author-role="assistant">${card}</div>`;
  assert.equal(scan(turn).state, 'attention');
  assert.notEqual(scan(turn + '<div data-message-author-role="assistant">已解决</div>').state, 'attention');
  assert.notEqual(scan(`<div data-message-author-role="assistant"><pre>${card}</pre></div>`).state, 'attention');
});
