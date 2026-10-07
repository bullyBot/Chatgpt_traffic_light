import { visible } from './detector.js';

// Capture UI structure, never message text, input values, URLs or private element IDs.
export function uiDiagnostics(doc) {
  const action = /^(stop|stop generating|interrupt|send|send message|send prompt|submit|submit answer|approve|allow once|good response|bad response|thumbs up|thumbs down|like|dislike|停止|停止生成|中断|发送|发送消息|提交|提交回答|批准|赞|踩|喜欢|不喜欢)$/i;
  function shape(el) {
    return {
      tag: el.tagName.toLowerCase(), classes: [...el.classList].slice(0, 16),
      role: ['button', 'group', 'radiogroup', 'radio', 'textbox', 'dialog', 'status', 'article', 'heading', 'form'].includes(el.getAttribute('role')) ? el.getAttribute('role') : null,
      dataAttributes: el.getAttributeNames().filter(name => name.startsWith('data-')).slice(0, 12),
      markers: Object.fromEntries(['data-testid', 'data-slot', 'data-state', 'data-role', 'data-message-author-role'].map(name => [name, el.getAttribute(name)]).filter(([, value]) => /^[a-z][a-z_-]{0,63}$/i.test(value || ''))),
      visible: visible(el)
    };
  }
  function parents(el) {
    const result = [];
    for (let parent = el.parentElement, depth = 0; parent && parent !== doc.body && depth < 4; parent = parent.parentElement, depth++) {
      result.push({ ...shape(parent), children: [...parent.children].slice(0, 10).map(shape) });
    }
    return result;
  }
  const excluded = 'pre, code, blockquote, nav, aside, [role="navigation"]';
  const buttons = [...doc.querySelectorAll('button, [role="button"]')].filter(el => visible(el) && !el.closest(excluded));
  const editors = [...doc.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(el => visible(el) && !el.closest(excluded));
  return {
    buttonsTotal: buttons.length,
    editors: editors.slice(-3).map(el => ({ ...shape(el), parents: parents(el) })),
    buttons: buttons.slice(-30).map(el => ({
      ...shape(el), disabled: el.matches(':disabled, [aria-disabled="true"]'),
      hasLabel: Boolean(el.getAttribute('aria-label') || el.getAttribute('title')),
      action: [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].map(value => (value || '').trim()).find(value => action.test(value))?.toLowerCase() || 'other',
      icons: [...el.querySelectorAll('svg')].slice(0, 1).map(svg => ({
        classes: [...svg.classList].slice(0, 8),
        paths: [...svg.querySelectorAll('path')].slice(0, 3).map(path => (path.getAttribute('d') || '').slice(0, 1500)),
        shapes: [...svg.querySelectorAll('rect, circle, use')].map(node => node.tagName).slice(0, 6)
      })), parents: parents(el)
    }))
  };
}
