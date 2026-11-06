// Chromium MV3 service worker (Chrome, Edge, Brave, Opera, Vivaldi, Arc, ...).
// Service workers lack RTCPeerConnection, so the engine lives in an offscreen
// document. Chromium forks without the offscreen API fall back to a minimized
// extension window hosting the same page. This worker keeps the privileged APIs.
import { api } from '../shared/api.js';
import { callOps, handlePopupCommand, respond } from './ops.js';

const HOST = 'offscreen.html';
const HOST_URL = api.runtime.getURL(HOST);
let creating = null;

async function hostExists() {
  if (api.runtime.getContexts) {
    const ctx = await api.runtime.getContexts({ documentUrls: [HOST_URL] });
    if (ctx.length) return true;
  }
  // Fallback windows: also catch one that is still loading.
  const tabs = await api.tabs.query({ windowType: 'popup' });
  return tabs.some((t) => (t.url || t.pendingUrl) === HOST_URL);
}

async function createHost() {
  if (api.offscreen?.createDocument) {
    return api.offscreen.createDocument({
      url: HOST, reasons: ['WEB_RTC'], justification: 'Peer-to-peer WebRTC data channel for device sync',
    });
  }
  // Fallback for Chromium forks without chrome.offscreen.
  return api.windows.create({ url: HOST, type: 'popup', state: 'minimized', focused: false });
}

async function ensureEngineHost() {
  if (await hostExists()) return;
  creating ??= createHost().finally(() => { creating = null; });
  await creating;
}

async function engineCall(cmd, args) {
  await ensureEngineHost();
  for (let i = 0; ; i++) {
    try {
      const res = await api.runtime.sendMessage({ target: 'engine', cmd, args });
      if (!res) throw new Error('No response from engine');
      if (!res.ok) throw Object.assign(new Error(res.error), { remote: true });
      return res.result;
    } catch (e) {
      if (e.remote || i >= 15) throw e;
      await new Promise((r) => setTimeout(r, 200)); // engine page still starting
    }
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages are accepted (content scripts/web pages have other URLs).
  if (sender.id !== api.runtime.id || !msg || typeof msg !== 'object') return false;
  if (msg.target === 'ops' && sender.url === HOST_URL) {
    return respond(callOps(msg.method, msg.args), sendResponse);
  }
  if (msg.target === 'bg' && sender.url?.startsWith(api.runtime.getURL('popup.html'))) {
    return respond(handlePopupCommand(msg.cmd, msg.args ?? {}, engineCall), sendResponse);
  }
  return false;
});

api.runtime.onStartup.addListener(() => ensureEngineHost());
api.runtime.onInstalled.addListener(() => ensureEngineHost());
