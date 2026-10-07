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
  for (const [input, expected] of [['running', 'running'], ['awaiting_approval', 'attention'], ['completed', 'completed'], ['failed', 'error'], ['cancelled', 'error']]) {
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
