// Chromium offscreen document hosting the sync engine (needs RTCPeerConnection).
import { Engine } from '../engine/engine.js';

const api = globalThis.chrome;
const BG_URL = api.runtime.getURL('background.js');

async function ops(method, args) {
  const res = await api.runtime.sendMessage({ target: 'ops', method, args });
  if (!res?.ok) throw new Error(res?.error || 'ops failed');
  return res.result;
}

const engine = new Engine(ops);
const ready = engine.init();

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || sender.url !== BG_URL || msg?.target !== 'engine') return false;
  ready
    .then(() => engine.command(msg.cmd, msg.args ?? {}))
    .then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});
