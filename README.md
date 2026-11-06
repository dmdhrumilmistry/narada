# WebSync

WebSync is a peer-to-peer browser sync extension for **Chromium** (Chrome, Edge,
Brave…) and **Firefox**. You pick tabs and send them to another of your devices,
optionally **with their cookies and site storage**, so you stay logged in.

* **No central server in the data path.** Free public Nostr relays carry only the
  encrypted handshake. After that, data goes directly between browsers over a
  WebRTC data channel, and the relay sockets are closed.
* **NAT traversal uses Google public STUN only.** There is no TURN, so no server
  ever relays your traffic.
* **End-to-end encrypted and mutually authenticated:** pinned device keys, ephemeral
  ECDH, AES-256-GCM, and replay protection on top of DTLS.

See [`docs/PLAN.md`](docs/PLAN.md) for the full design, protocols and security
practices.

## Install (from source)

```bash
npm install
npm run build        # -> dist/chrome (MV3) and dist/firefox (MV2)
npm test             # unit tests (crypto, pairing, secure channel, validators)
npm run package      # optional: zip both builds
```

* **Chromium:** open `chrome://extensions`, turn on Developer mode, click
  *Load unpacked* and select `dist/chrome`.
* **Firefox:** open `about:debugging#/runtime/this-firefox`, click
  *Load Temporary Add-on…* and select `dist/firefox/manifest.json`.

## Usage

1. **Pair**: on device A go to *Devices* and click *Create pairing code*. Copy the
   code to device B (via a channel you trust), paste it and click *Join*. Both
   devices show a 6-digit number. Confirm on each device that the numbers match.
2. **Send tabs**: open *Send*, choose a connected device, tick the tabs you want, and
   optionally tick *Include cookies* / *Include site storage*. The browser
   asks for cookie/site access the first time.
3. **Approve**: the receiving device gets a notification. Under *Incoming* it
   shows exactly which tabs, cookie domains and storage items arrived. Nothing
   is applied until you click *Accept*. Requests expire after 5 minutes.
4. **Browse remote tabs**: in *Devices*, click *Tabs* on a connected device to list
   its open tabs and open any of them locally. You can turn sharing of your own
   tab list off in Settings.

## Security model (summary)

| Threat | Mitigation |
|---|---|
| Relay operators / network observers | Signaling is AES-GCM encrypted under keys derived from the pair secret, topics rotate daily, and each Nostr event is signed by a fresh ephemeral key. Data never touches relays. |
| Leaked or guessed pairing code | 256-bit one-time secret, 10-minute expiry, single use, plus SAS comparison before the pair is saved. |
| Signaling MITM / malicious relay | Mutual ECDSA signatures with pinned keys, a session handshake bound to the DTLS fingerprints, and replay windows with nonces. |
| Compromised session key | Ephemeral ECDH per connection gives forward secrecy, and keys are separate per direction. |
| Replay/reorder/tamper on channel | AES-GCM with strictly increasing 64-bit sequence numbers. Any failure closes the connection. |
| Malicious/buggy peer payloads | Strict validation: http(s) URLs only, cookies must domain-match the tab, the storage origin must match (and is re-checked in-page), plus size and count limits. |
| Silent credential import | Every incoming transfer needs explicit approval. There is no "pull cookies" request, so credentials only move when the sender pushes them. |
| Over-broad permissions | `cookies` and `<all_urls>` are optional and only requested when needed. Incognito is not allowed. There are no content scripts. |
| Key theft from disk | Identity and pair keys are non-extractable WebCrypto keys stored in IndexedDB. Cookies are never persisted by the extension. |
| XSS in extension UI | Strict CSP, no remote code, no `innerHTML`, only `textContent`. |

### Known limitations
* Without TURN, some network pairs (for example both behind symmetric NAT or strict
  corporate firewalls) cannot connect. This is the price of having no relay server.
* Site storage covers `localStorage` and `sessionStorage`. IndexedDB and service-worker
  caches are not synced.
* Firefox uses Manifest V2 with a persistent background page, because Firefox MV3
  event pages get suspended and would drop the peer connection.
* Firefox may close the popup when it shows a permission prompt. Reopen it and
  repeat the action.

## Project layout

```
src/shared       API shim, constants, validators
src/engine       crypto, IndexedDB store, Nostr pool, signaling, pairing,
                 secure channel, WebRTC peer, engine orchestration
src/background   browser ops (tabs/cookies/storage) + per-browser entry points
src/offscreen    Chromium offscreen document hosting the engine
src/popup        UI
build.mjs        bundles with esbuild and writes per-browser manifests
```
