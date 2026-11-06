# Narada: Design & Implementation Plan

> **Why "Narada"?** In the Bhagavata Purana, Narada Muni is the divine sage who wanders
> between all the lokas (worlds) carrying news, veena in hand, chanting
> "Narayan Narayan". Narada the extension carries your tabs between your browsers.

Peer-to-peer browser sync for every Chromium-based and Firefox-based browser. Devices find each other
through public Nostr relays (signaling only) and then talk directly over a
WebRTC data channel. NAT traversal uses only Google's public STUN servers.
There is **no TURN server and no central server** in the data path once the
handshake is done.

## 1. Goals

| # | Goal |
|---|------|
| G1 | Pair two browsers (Chrome/Edge/Brave/Firefox, any combination) with a one-time code. |
| G2 | Connect paired devices automatically over WebRTC (Google STUN only). |
| G3 | Use free public Nostr relays only for the handshake (offer/answer). Relays see only encrypted, unlinkable blobs. |
| G4 | Let the user pick specific tabs and send them to a device, optionally **with cookies and site storage** (localStorage + sessionStorage), so the session carries over. |
| G5 | Let the user browse a paired device's open tabs and open them locally. |
| G6 | Apply security best practices throughout (see §4). |

Non-goals (v1): bookmarks/history sync, IndexedDB/service-worker storage sync,
TURN fallback (it would put a server in the data path), mobile browsers.

## 2. Architecture

```
               ┌───────────── popup (UI) ─────────────┐
               │ pairing · devices · send · approve   │
               └──────────────┬───────────────────────┘
                              │ runtime messages (target:"bg")
┌─────────────────────────────▼─────────────────────────────────────┐
│ background                                                        │
│  Chromium: MV3 service worker  ──►  offscreen document (WEB_RTC)  │
│  Firefox : MV2 persistent background page (engine + ops together) │
│                                                                   │
│  ops (privileged browser APIs)     engine (network + crypto)      │
│   tabs / cookies / scripting        identity & pair store (IDB)   │
│   notifications / badge             Nostr relay pool (signaling)  │
│                                     WebRTC peer + secure channel  │
└───────────────────────────────────────────────────────────────────┘
```

On Chromium forks that lack `chrome.offscreen`, the service worker hosts the
same engine page in a minimized extension window instead. A Web Lock
(`navigator.locks`) guarantees that exactly one engine instance runs.

Why the split: Chromium service workers have no `RTCPeerConnection`, so the
engine runs in an offscreen document (reason `WEB_RTC`). Offscreen documents
cannot use `tabs`/`cookies`, so those stay in the service worker ("ops") and
the engine reaches them via runtime messages. Firefox has no offscreen API and
MV3 event pages are suspended when idle (which would kill WebSockets and
WebRTC), so Firefox uses an MV2 persistent background page that hosts both.

### Modules

| Path | Role |
|------|------|
| `src/shared/` | browser API shim, constants, input validators |
| `src/engine/crypto.js` | WebCrypto helpers: HKDF, AES-GCM, ECDSA/ECDH P-256, SAS |
| `src/engine/store.js` | IndexedDB key/value store (holds non-extractable `CryptoKey`s) |
| `src/engine/nostr.js` | NIP-01 event signing (BIP-340 via `@noble/curves`), relay pool |
| `src/engine/signaling.js` | Encrypted, authenticated, replay-protected envelopes over Nostr |
| `src/engine/pairing.js` | Pairing protocol |
| `src/engine/secure-channel.js` | App-layer authenticated encryption over the data channel |
| `src/engine/peer.js` | RTCPeerConnection lifecycle |
| `src/engine/engine.js` | Orchestration and command API |
| `src/background/ops.js` | Collect/apply tabs, cookies and storage |
| `src/background/chrome-bg.js`, `firefox-bg.js` | Entry points and message routing |
| `src/popup/` | UI |
| `build.mjs` | esbuild bundle and per-browser manifests → `dist/chromium`, `dist/firefox` |

## 3. Protocols

### 3.1 Device identity
* On first run each device generates an **ECDSA P-256** key pair with a
  **non-extractable** private key, stored as a `CryptoKey` in IndexedDB.
* `deviceId = hex(SHA-256(rawPublicKey))[0..32]`.

### 3.2 Pairing (one-time code + SAS)
1. Device A creates a random 256-bit secret `S` and shows the code
   `NRD1-<base64url(S)>`. It expires after 10 min and works only once.
2. Both sides derive from `S` with HKDF: a rendezvous topic (a Nostr `#p` tag
   value) and an AES-256-GCM key. Relays only see random hex and ciphertext.
3. B → A `hello {pubB, nameB, nonceB}`
   A → B `welcome {pubA, nameA, nonceA, sigA(T)}`
   B → A `confirm {sigB(T)}`
   where `T = SHA-256("narada-pair-v1" ‖ pubA ‖ pubB ‖ nonceA ‖ nonceB)`.
4. Both show a 6-digit **Short Authentication String** derived from `T`. The
   user checks that the two devices show the same number. Only then is the pair
   saved: the peer's public key is pinned, and the pair key is
   `HKDF(S, salt=T, "pair-secret")`, imported as a non-extractable HKDF key.

### 3.3 Session establishment
* Rendezvous topic and encryption key for a pair are derived per UTC day from
  the pair key: `HKDF(pairKey, salt=day, …)`. This rotates them daily so relay
  observers can't link sessions over time. Devices listen on day−1, day and day+1.
* Non-trickle ICE: the offer/answer carries every candidate, so only two relay
  messages are needed. Each Nostr event is signed by a fresh **ephemeral** Nostr
  key, so it reveals no long-term identity.
* Envelopes contain `{type, sid, ts, nonce, body}`, AES-GCM encrypted with
  AAD bound to the topic. Receivers drop anything older than 120 s, any
  nonce they've already seen, and their own echoes.
* Glare (both sides offer at once) is resolved by deviceId order: the lower
  deviceId is "polite" and yields.
* ICE servers: `stun:stun.l.google.com:19302` and `stun1..4.l.google.com`.
  There is **no TURN**. Some symmetric NAT pairs will not connect, which is
  an accepted trade-off for having no relay server.
* Once the data channel is authenticated, that pair's relay subscription is
  dropped. When nothing else needs signaling, all relay sockets close, so
  no server is involved after the handshake.

### 3.4 Secure channel (defense in depth on top of DTLS)
1. Each side sends `auth1 {ephemeral ECDH P-256 pub, nonce}`.
2. `H = SHA-256("narada-sess-v1" ‖ offerer(id,eph,nonce) ‖ answerer(id,eph,nonce) ‖ offererDTLSfp ‖ answererDTLSfp)`.
   Including the DTLS fingerprints from the SDP *binds the app-layer handshake
   to the transport* (channel binding).
3. Each side sends `auth2 {ECDSA_identity(H)}`, which is checked against the
   **pinned** peer key.
4. Keys: `HKDF(ECDH ‖ HKDF(pairKey,H,"sess-psk"), salt=H, "k:"+senderId)`,
   one key per direction. This gives forward secrecy (ephemeral ECDH) and
   requires knowing the pair secret.
5. Frames: AES-256-GCM, IV = 64-bit sequence counter. The receiver requires
   `seq == last+1` (strict replay/reorder protection on the ordered channel).
   Large messages are fragmented into 32 KiB chunks, with a 16 MiB hard limit.
6. Any message before authentication completes, or any decrypt or sequence
   failure, closes the connection. Heartbeat every 15 s, with a 45 s timeout.

### 3.5 Application messages
* `tabs.list.req/res`: open tabs (title + URL only). Served only if the user
  has "Allow paired devices to see my open tabs" enabled.
* `transfer {id, tabs[]}`: each tab is `{url, title, pinned, cookies?, storage?}`.
  The receiver **queues it for explicit user approval**. Nothing is applied
  automatically.
* `transfer.ack {id, status}`.
* There is deliberately **no "pull cookies" request**. Credentials only move
  when the sending user explicitly pushes them.

### Browser support matrix

| Browser family | Build | Engine host | Verified |
|---|---|---|---|
| Chrome, Edge, Brave, Opera, Vivaldi, Arc… (Chromium ≥ 110) | `dist/chromium` (MV3) | offscreen document; minimized window if the offscreen API is missing | Chromium ↔ Chromium E2E, plus the no-offscreen fallback |
| Firefox, Firefox ESR, LibreWolf, Waterfox, Floorp, Zen… (Gecko ≥ 115) | `dist/firefox` (MV2) | persistent background page | Chromium ↔ Firefox ESR E2E; `web-ext lint` 0 errors |
| Safari | not supported | no WebRTC in Safari extension backgrounds | n/a |

If WebRTC is disabled (for example LibreWolf with `media.peerconnection.enabled=false`),
the engine detects it and the UI explains how to turn it back on.

### UI
The popup has a toned-down comic-book look: ink outlines, halftone paper, speech
bubbles, and small, quick sound-effect bursts, with a cartoon Narada mascot. The
sections are Bhejo, Lokas, Sandesh and Yantra. A single sticky action button spells
out the action, pairing takes two steps with large SAS digits, and the inbox lists
which sites accepting would sign you in to. The fonts are Bangers and Comic Neue
(SIL OFL, bundled). Light and dark themes are included, and `prefers-reduced-motion`
is respected.

## 4. Security practices

* **Least privilege**: required permissions are `tabs`, `storage`,
  `notifications`, `scripting` (+`offscreen` on Chromium). `cookies` and
  `<all_urls>` host access are *optional* and requested at runtime only when the
  user first sends or accepts cookies/storage.
* `incognito: "not_allowed"`: private-window data is never touched.
* **Strict CSP** for extension pages. There are no content scripts, no remote
  code, no `eval`, and no `innerHTML` with untrusted data (only `textContent`).
* Message routing checks `sender.id === runtime.id` and rejects tab/content-script senders.
* All peer input is schema-validated:
  * Only `http(s)` URLs are accepted (≤ 8 KiB), with at most 50 tabs.
  * Cookies must domain-match the tab's host, and values are capped in size and count.
  * The storage origin must equal the tab's origin, and the injected setter re-checks `location.origin`.
* Cookies and storage are **never persisted** by the extension. Pending
  transfers live in memory only and expire after 5 minutes. Secrets are never logged.
* Keys: identity and pair keys are non-extractable `CryptoKey`s, randomness comes
  from `crypto.getRandomValues`, and only standard primitives are used
  (P-256, HKDF-SHA256, AES-256-GCM, BIP-340).
* Relays: only `wss://` URLs are accepted, inbound messages are size-capped,
  event ids and signatures are verified, and the user can edit the relay list.
* UI warnings: cookies are login credentials, so the sender is warned before
  sending them, and the receiver sees exactly which sites will get cookies and storage.
* Unpairing deletes the pinned key and pair key immediately.

## 5. Default public relays
`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`,
`wss://relay.nostr.band`, `wss://nostr.mom` (editable in Settings).

## 6. Build, test, release
* `npm run build` produces `dist/chromium` (MV3) and `dist/firefox` (MV2).
* `npm run e2e:prepare && npm run e2e:chromium` / `npm run e2e:firefox` run real
  browser-to-browser tests over the public relays (see README).
* `npm test` runs Node unit tests for crypto, pairing transcript/SAS, the secure
  channel (round-trip, replay, tamper, chunking) and validators.
* Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → `dist/chromium`;
  Firefox: `about:debugging` → Load Temporary Add-on → `dist/firefox/manifest.json`.

## 7. Implementation order
1. Scaffolding: build, manifests, shared constants/validators.
2. Crypto + store + tests.
3. Nostr pool + signaling envelopes.
4. Pairing protocol + SAS UI.
5. Peer connection + secure channel + tests.
6. Ops: collect/apply tabs, cookies, storage.
7. Popup UI: devices, send, approvals, remote tabs, settings.
8. Docs (README, threat model summary).
