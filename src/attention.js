// Text requests are deliberately narrow and only checked on the latest known assistant reply.
const EXCLUDED = 'pre, code, blockquote, button, [role="button"], [role="toolbar"], textarea, [contenteditable="true"]';
const directive = /^(?:请(?:你|先|再|分别|直接)?|麻烦你?|需要你)(?:把|将)?\s*(?:提供|补充|告诉我|告知|确认|选择|回答|回复|粘贴|贴出|贴上|贴一下|上传|发送|发来|审阅|批准|授权|复制)/i;
const english = /^(?:please\s+(?:provide|share|paste|upload|send|confirm|choose|select|answer|reply|review|approve)|(?:i\s+need|i'm\s+waiting\s+for)\s+your\s+(?:input|answer|confirmation|approval|response))/i;
const conditional = /^(?:如果|若|如需|如有|例如|比如|示例|可选|你可以|您可以|不需要|无需|if\b|for example\b|optionally\b)/i;

export function explicitReplyRequest(element) {
  const copy = element.cloneNode(true);
  for (const node of copy.querySelectorAll(EXCLUDED)) node.remove();
  let blocks = [...copy.querySelectorAll('p, li')].filter(node => !node.querySelector('p, li'));
  if (!blocks.length) blocks = [copy];
  return blocks.slice(-6).map(node => node.textContent.replace(/\s+/g, ' ').trim()).find(text =>
    text.length <= 1000 && !conditional.test(text) && (directive.test(text) || english.test(text))) || '';
}

export function semanticInputRequest(root, latestMessage, visible) {
  const excluded = 'pre, code, blockquote, .markdown, .prose, nav, aside, [data-message-author-role="user"]';
  const submit = /^(submit|submit answer|submit answers|answer|提交|提交回答|提交答案|确认选择)$/i;
  for (const card of root.querySelectorAll('form, [role="group"], [role="radiogroup"]')) {
    if (!visible(card) || card.closest(excluded)) continue;
    const message = card.closest('[data-message-author-role]');
    if (message && (message !== latestMessage || message.getAttribute('data-message-author-role') !== 'assistant')) continue;
    const heading = card.querySelector('legend, h1, h2, h3, [role="heading"]');
    if (!heading || !visible(heading)) continue;
    const input = [...card.querySelectorAll('input[type="radio"], input[type="checkbox"], textarea, select, [role="radio"]')].find(control =>
      visible(control) && !control.matches(':disabled, [aria-disabled="true"]') && !control.closest(excluded));
    const action = [...card.querySelectorAll('button, [role="button"]')].find(control =>
      visible(control) && !control.matches(':disabled, [aria-disabled="true"]') && !control.closest(excluded) &&
      [control.getAttribute('aria-label'), control.getAttribute('title'), control.textContent].some(name => submit.test((name || '').trim())));
    if (input && action) return { element: card, label: heading.textContent.trim() };
  }
  return null;
}
