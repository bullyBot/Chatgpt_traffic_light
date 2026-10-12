// Injected in the isolated world of a logged-in ChatGPT tab. Keep this function
// self-contained: Chrome serializes it without module imports or closures.
export async function readUsageInPage() {
  if (location.origin !== 'https://chatgpt.com') return { ok: false, reason: '请打开并登录 chatgpt.com 后重试' };
  async function get(path, headers = {}) {
    return fetch(path, { headers, credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
  }
  function failure(status) {
    return { ok: false, reason: status === 401 ? '登录已失效，请重新登录 ChatGPT' : status === 403 ? '当前账号或页面无法读取用量，请查看官方用量页' : status === 429 ? '请求过于频繁，请稍后刷新额度' : `官方用量暂时无法读取（HTTP ${status}）` };
  }
  try {
    const sessionResponse = await get('/api/auth/session');
    if (!sessionResponse.ok) return failure(sessionResponse.status);
    const session = await sessionResponse.json();
    if (typeof session.accessToken !== 'string' || !session.accessToken) return { ok: false, reason: '请先登录 ChatGPT，再刷新额度' };
    // The token is used only here; never return, log or persist it.
    const response = await get('/backend-api/wham/usage', { Authorization: `Bearer ${session.accessToken}` });
    if (!response.ok) return failure(response.status);
    const payload = await response.json();
    // Do not mistake weekly or additional model limits for the Codex 5h window.
    const limits = [payload.rate_limit?.primary_window, payload.rate_limit?.secondary_window];
    const window = limits.find(value => value?.limit_window_seconds === 18000);
    if (!window) return { ok: false, reason: '官方未返回此账号的 5 小时额度，请查看官方用量页' };
    const used = window.used_percent;
    const resetAt = window.reset_at * 1000;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100 || typeof window.reset_at !== 'number' || !Number.isFinite(resetAt) || resetAt <= 0 || resetAt > 8640000000000000) {
      return { ok: false, reason: '官方用量数据格式已变化，请查看官方用量页' };
    }
    // Only quota fields cross into the extension; no account IDs or session data.
    return { ok: true, remainingPercent: 100 - used, resetAt, fetchedAt: Date.now() };
  } catch {
    return { ok: false, reason: '官方用量读取失败或超时，请稍后重试' };
  }
}

export async function loadUsage(api) {
  try {
    const tabs = await api.tabs.query({ url: 'https://chatgpt.com/*' });
    const supported = tabs.filter(tab => {
      try { return new URL(tab.url).origin === 'https://chatgpt.com' && !tab.discarded; } catch { return false; }
    });
    const active = await api.tabs.query({ active: true, currentWindow: true, url: 'https://chatgpt.com/*' });
    const tab = supported.find(tab => active.some(item => item.id === tab.id)) || supported[0];
    if (!tab) return { ok: false, reason: '请打开并登录 ChatGPT 页面，再刷新额度' };
    const results = await api.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: readUsageInPage });
    return results?.[0]?.result || { ok: false, reason: '页面未返回官方用量，请重试' };
  } catch {
    return { ok: false, reason: '无法连接 ChatGPT 页面，请检查扩展的网站访问权限' };
  }
}

export function usageView(usage, now = Date.now()) {
  if (!usage?.ok) return { available: false, detail: usage?.reason || '正在读取官方额度…' };
  if (now >= usage.resetAt) return { available: false, detail: '已到重置时间，请刷新额度' };
  if (now - usage.fetchedAt >= 300000) return { available: false, detail: '额度数据已过期，请刷新' };
  return { available: true, percent: usage.remainingPercent, resetAt: usage.resetAt, fetchedAt: usage.fetchedAt };
}
