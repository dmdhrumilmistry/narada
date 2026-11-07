// Platform detection. Firefox for Android lacks some desktop APIs (context menus,
// keyboard shortcuts, badges, windows, pinned tabs, enterprise policy), so callers
// check here and degrade gracefully instead of throwing.
import { api } from './api.js';

export const isAndroidUA = (ua = globalThis.navigator?.userAgent ?? '') => /Android/i.test(ua);

let cached;
export async function isAndroid() {
  if (cached === undefined) {
    try { cached = (await api.runtime.getPlatformInfo()).os === 'android'; } catch { cached = isAndroidUA(); }
  }
  return cached;
}
