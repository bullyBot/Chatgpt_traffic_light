import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { uiDiagnostics } from '../src/ui-diagnostics.js';

test('UI inspection supplies controls and parent structure without private texts, values, IDs or links', () => {
  const dom = new JSDOM('<main><section class="reply-turn"><div>PRIVATE_BODY</div><button id="PRIVATE_ID" aria-label="PRIVATE_LABEL" data-session="PRIVATE_TOKEN"><svg><path d="M1 2h3"></path></svg>PRIVATE_BUTTON</button></section><form><textarea placeholder="PRIVATE_HINT">PRIVATE_DRAFT</textarea><button aria-label="发送">↑</button></form><a href="https://example.com/PRIVATE_URL">PRIVATE_LINK</a></main>');
  try {
    const result = uiDiagnostics(dom.window.document);
    assert.equal(result.editors.length, 1);
    assert.equal(result.buttons.length, 2);
    assert.equal(result.buttons[0].action, 'other');
    assert.deepEqual(result.buttons[0].icons[0].paths, ['M1 2h3']);
    assert.equal(result.buttons[1].action, '发送');
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
    assert.ok(result.buttons[0].parents.some(parent => parent.classes.includes('reply-turn')));
  } finally { dom.window.close(); }
});
