import { detect, isStopControl } from './detector.js';
import { canonicalUrl } from './model.js';

const agentVersion = '0.2.1';
const existing = globalThis.__chatgptTrafficLight;
if (existing?.active && existing.version === agentVersion) {
  existing.scan();
} else {
  existing?.dispose();
  startObserver();
}

function startObserver() {
  let currentUrl = canonicalUrl(location.href);
  let documentId = crypto.randomUUID();
  let lastSignature = '';
  let lastSent = 0;
  let pendingTimer;
  const listeners = new AbortController();
  const controller = { active: true, version: agentVersion, scan: () => report(false, true), dispose: stop };
  globalThis.__chatgptTrafficLight = controller;

  async function report(cancelled = false, force = false) {
    if (!controller.active) return { ok: false };
    const url = canonicalUrl(location.href);
    if (!url) return { ok: false };
    if (url !== currentUrl) {
      currentUrl = url;
      documentId = crypto.randomUUID();
      lastSignature = '';
    }
    const observation = { ...detect(document, location.href), url, documentId, cancelled, title: document.title.slice(0, 120) };
    observation.diagnostics.observerVersion = agentVersion;
    const signature = JSON.stringify(observation);
    if (!force && signature === lastSignature && observation.state !== 'completed' && Date.now() - lastSent < 15000) return { ok: true };
    lastSignature = signature;
    lastSent = Date.now();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'observation', observation });
      return response || { ok: false };
    } catch (error) {
      lastSignature = '';
      try { if (!chrome.runtime.id || /context invalidated/i.test(error.message)) stop(); }
      catch { stop(); }
      return { ok: false };
    }
  }

  const observer = new MutationObserver(() => {
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => { pendingTimer = null; report(); }, 120);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const interval = setInterval(() => report(), 2000);
  function stop() {
    controller.active = false;
    observer.disconnect(); clearInterval(interval); clearTimeout(pendingTimer);
    listeners.abort();
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* Old extension context is already gone. */ }
  }
  const capture = { capture: true, signal: listeners.signal };
  document.addEventListener('click', event => { if (isStopControl(event.target)) report(true, true); }, capture);
  document.addEventListener('pointerdown', event => { if (isStopControl(event.target)) report(true, true); }, capture);
  document.addEventListener('keydown', event => {
    if (isStopControl(event.target) && ['Enter', ' '].includes(event.key)) report(true, true);
    if (event.key === 'Escape' && [...document.querySelectorAll('button, [role="button"]')].some(isStopControl)) report(true, true);
  }, capture);
  document.addEventListener('visibilitychange', () => report(false, true), { signal: listeners.signal });
  window.addEventListener('pageshow', () => report(false, true), { signal: listeners.signal });
  function onMessage(message, sender, respond) {
    if (message.type === 'scan') {
      report(false, true).then(respond);
      return true;
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);
  report(false, true);
}
