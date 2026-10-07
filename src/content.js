import { detect, isStopControl } from './detector.js';
import { canonicalUrl } from './model.js';

let currentUrl = canonicalUrl(location.href);
let documentId = crypto.randomUUID();
let lastSignature = '';
let lastSent = 0;
let pendingTimer;
let stopped = false;

function report(cancelled = false, force = false) {
  if (stopped) return;
  const url = canonicalUrl(location.href);
  if (!url) return;
  if (url !== currentUrl) {
    currentUrl = url;
    documentId = crypto.randomUUID();
    lastSignature = '';
  }
  const observation = { ...detect(document, location.href), url, documentId, cancelled, title: document.title.slice(0, 120) };
  const signature = JSON.stringify(observation);
  // Repeat completed observations to confirm stability; heartbeat all other states.
  if (!force && signature === lastSignature && observation.state !== 'completed' && Date.now() - lastSent < 15000) return;
  lastSignature = signature;
  lastSent = Date.now();
  try {
    chrome.runtime.sendMessage({ type: 'observation', observation }).catch(() => {
      if (!chrome.runtime?.id) stop();
    });
  } catch { stop(); }
}

const observer = new MutationObserver(() => {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => { pendingTimer = null; report(); }, 120);
});
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
const interval = setInterval(() => report(), 2000);
function stop() { stopped = true; observer.disconnect(); clearInterval(interval); clearTimeout(pendingTimer); }
document.addEventListener('click', event => { if (isStopControl(event.target)) report(true, true); }, true);
document.addEventListener('pointerdown', event => { if (isStopControl(event.target)) report(true, true); }, true);
document.addEventListener('keydown', event => {
  if (isStopControl(event.target) && ['Enter', ' '].includes(event.key)) report(true, true);
  // Escape can stop generation. Suppress completion conservatively while a stop control exists.
  if (event.key === 'Escape' && [...document.querySelectorAll('main button, [role="main"] button')].some(isStopControl)) report(true, true);
}, true);
document.addEventListener('visibilitychange', () => report(false, true));
window.addEventListener('pageshow', () => report(false, true));
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'scan') report(false, true);
});
report(false, true);
