// Cross-browser extension API shim. Chromium MV3 `chrome.*` returns promises;
// Firefox exposes the promise-based `browser.*` namespace.
export const api = globalThis.browser ?? globalThis.chrome;
export const IS_FIREFOX = typeof globalThis.browser !== 'undefined' && !!globalThis.browser.runtime?.getBrowserInfo;
export const actionApi = () => api.action ?? api.browserAction;
