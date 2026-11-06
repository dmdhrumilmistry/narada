// Chromium MV3 service worker. Service workers lack RTCPeerConnection, so the
// engine lives in an offscreen document; this worker keeps the privileged APIs.
import { api } from '../shared/api.js';
import { callOps, handlePopupCommand, respond } from './ops.js';

const OFFSCREEN = 'offscreen.html';
let creating = null;

async function ensureOffscreen() {
  const url = api.runtime.getURL(OFFSCREEN);
  const ctx = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (ctx.length) return;
  creating ??= api.offscreen
    .createDocument({ url: OFFSCREEN, reasons: ['WEB_RTC'], justification: 'Peer-to-peer WebRTC data channel for device sync' })
    .finally(() => { creating = null; });
  await creating;
}

async function engineCall(cmd, args) {
  await ensureOffscreen();
  for (let i = 0; ; i++) {
    try {
      const res = await api.runtime.sendMessage({ target: 'engine', cmd, args });
      if (!res) throw new Error('No response from engine');
      if (!res.ok) throw Object.assign(new Error(res.error), { remote: true });
      return res.result;
    } catch (e) {
      if (e.remote || i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 200)); // offscreen still starting
    }
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages are accepted (content scripts/web pages have other URLs).
  if (sender.id !== api.runtime.id || !msg || typeof msg !== 'object') return false;
  if (msg.target === 'ops' && !sender.tab && sender.url === api.runtime.getURL(OFFSCREEN)) {
    return respond(callOps(msg.method, msg.args), sendResponse);
  }
  if (msg.target === 'bg' && sender.url?.startsWith(api.runtime.getURL('popup.html'))) {
    return respond(handlePopupCommand(msg.cmd, msg.args ?? {}, engineCall), sendResponse);
  }
  return false;
});

api.runtime.onStartup.addListener(() => ensureOffscreen());
api.runtime.onInstalled.addListener(() => ensureOffscreen());
