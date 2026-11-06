// Firefox MV2 persistent background page: hosts both the engine (WebRTC works
// here) and the privileged ops. Persistent so sockets/peers are not suspended.
import { api } from '../shared/api.js';
import { Engine } from '../engine/engine.js';
import { callOps, handlePopupCommand, respond } from './ops.js';
import { setupQuickSend } from './quick.js';

const engine = new Engine(callOps);
const ready = engine.init();
const engineCall = async (cmd, args) => { await ready; return engine.command(cmd, args); };
setupQuickSend(engineCall);
api.storage.onChanged.addListener((_changes, area) => {
  if (area === 'managed') engineCall('reloadConfig').catch(() => {});
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || msg?.target !== 'bg') return false;
  if (!sender.url?.startsWith(api.runtime.getURL('popup.html'))) return false;
  return respond(handlePopupCommand(msg.cmd, msg.args ?? {}, engineCall), sendResponse);
});
