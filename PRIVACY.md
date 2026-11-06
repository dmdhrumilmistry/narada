# Narada privacy policy

_Last updated: 2026-11-06_

Narada is a browser extension that sends tabs (and, only if you choose, their
cookies and site storage) **between your own browsers**. It is built so that no one
else, including the developer, receives your data.

## What Narada does not do
* It does not collect, sell or share personal data.
* It has no analytics, telemetry, advertising or tracking.
* It does not run any developer-operated server, and it needs no account.

## What stays on your device
* A device identity key and the keys for devices you pair. These are non-extractable
  WebCrypto keys stored in the extension's local IndexedDB.
* Your settings: device name, relay list, and whether paired devices may see your tab list.
* A history of the last 50 tabs you received (title and link only). You can clear it or
  turn it off in Settings. It never holds cookies, site storage or note text.

Unpairing a device deletes its keys. Uninstalling the extension deletes everything.

## What leaves your device, and to whom
| Data | Sent to | When |
|---|---|---|
| Tab URL, title and pinned state | Your paired device only | When you press Send |
| Cookies and site storage (localStorage/sessionStorage) for the tabs you chose | Your paired device only | Only when you turn on "Keep me signed in" and press Send |
| List of open tab titles and URLs | Your paired device only | When that device asks, and only if "Let my devices see my open tabs" is on |
| Notes (text you type or select) | Your paired device only | When you send a note. The receiver keeps it in memory only, never on disk, and it expires after 15 minutes |

Everything above travels **directly between your browsers** over an
end-to-end encrypted WebRTC connection, and is never sent to the developer or any third party.
On the receiving browser, nothing is opened or imported until you accept it.
The extension does not keep cookies or storage it receives. Pending transfers are held
in memory and expire after 5 minutes.

## Third parties involved in connecting
* **Public Nostr relays** (editable in Settings) carry a short handshake so your
  devices can find each other. These messages are encrypted and signed by throwaway keys.
  Relays can see your IP address and the time of connection, but not the content.
* **Google STUN servers** (`stun.l.google.com`) tell your browser its public address
  so it can connect directly. They see your IP address, but no content.
* Your **paired devices** see your IP address, as with any direct connection.

## Permissions
* `tabs`: list your tabs so you can pick which to send, and open received tabs.
* `scripting`: read or restore site storage for a tab, only when you ask for it.
* `notifications`: tell you when a device sends you tabs.
* `contextMenus` / `menus`: add "Send to device with Narada" to the right-click menu.
* `offscreen` (Chromium only): run the WebRTC connection in the background.
* `cookies` and access to all sites: **optional**. Requested only the first time you
  send or accept sign-in data, to read cookies for the tabs you picked or set them on accept.

## Contact
Questions or concerns: open an issue at https://github.com/dmdhrumilmistry/narada/issues.
