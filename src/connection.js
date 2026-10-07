export const SITES = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

// Scan first to preserve an existing observer and its run/completion baseline.
export async function connectTab(api, tab) {
  if (tab.discarded) return { ok: false, reason: '页面已休眠，请打开此标签页后重试' };
  try {
    const response = await api.tabs.sendMessage(tab.id, { type: 'scan' });
    if (response?.ok) return { ok: true, injected: false };
  } catch { /* Existing tabs may not have a content script after installation. */ }
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const response = await api.tabs.sendMessage(tab.id, { type: 'scan' });
    if (response?.ok) return { ok: true, injected: true };
    return { ok: false, reason: '页面脚本未返回状态，请刷新该页面后重新连接' };
  } catch (error) {
    const permission = /permission|cannot access|not allowed|missing host|extensions gallery/i.test(error.message || '');
    return { ok: false, reason: permission ? '没有此页面的访问权限，请在扩展的“网站访问权限”中允许 ChatGPT' : '页面暂时无法连接，请刷新该页面后重试' };
  }
}
