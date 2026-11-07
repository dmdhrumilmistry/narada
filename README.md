<p align="center"><img src="src/icons/icon128.png" alt="Narada" width="96"></p>

# Narada: *Narayan Narayan!* Your tabs, across every loka.

In the Bhagavata Purana, **Narada Muni** is the divine sage who wanders between
all the lokas carrying news, veena in hand. **Narada** the extension carries your
tabs (and, if you choose, your logins) between your browsers. It does this
**peer-to-peer**, with no central server in between.

<p align="center">
  <img src="docs/screenshots/send-light.png" alt="Bhejo: pick a device, tick tabs, one clear button" width="230">
  <img src="docs/screenshots/pair-verify.png" alt="Pairing: compare six digits, dark theme" width="230">
  <img src="docs/screenshots/inbox-light.png" alt="Sandesh: approve incoming tabs" width="230">
</p>

* **Works in every Chromium and Firefox browser**, in any combination (Chrome ↔ Firefox,
  Edge ↔ Brave, LibreWolf ↔ Opera…).
* **No central server in the data path.** Free public Nostr relays only carry the
  encrypted handshake. Then the browsers talk directly over WebRTC, and the relay
  sockets close.
* **Google STUN only, no TURN**, so no server ever relays your traffic.
* **End-to-end encrypted and mutually authenticated** with pinned device keys,
  ephemeral ECDH, AES-256-GCM and replay protection, on top of DTLS.
* **Send only the tabs you pick**, optionally with their **cookies and site storage**,
  so you stay logged in. The receiving device must approve every transfer.
* **Quick send:** right-click any page or link → *Send to device*, or press `Alt+Shift+S`
  to send the current tab to the device you used last.
* **Trusted devices:** optionally auto-open plain tabs from a device you trust. Sign-in data
  always waits for approval.
* **Notes:** send text (or right-click a selection) with a one-click Copy on the other side.
  Notes are memory-only and expire after 15 minutes.
* **Received history:** reopen any of the last 50 tabs you received. It keeps titles and
  links only, and you can clear it or turn it off.
* **Configurable and enterprise-ready:** feature switches, custom relays and STUN servers, and
  optional **OpenTelemetry** log export. Organizations can set and lock any setting via
  Chrome/Edge policy, Firefox `policies.json`, or MDM (Intune, Jamf, Google Admin). See
  [`docs/ENTERPRISE.md`](docs/ENTERPRISE.md).
* A friendly **comic-book UI**, toned down so it stays easy to read (see below).

## Supported browsers

| Family | Build | Notes |
|---|---|---|
| Chrome, Edge, Brave, Opera, Vivaldi, Arc, other Chromium ≥ 110 | `dist/chromium` | Uses an offscreen document. Forks without that API automatically get a minimized helper window instead. |
| Firefox, ESR, LibreWolf, Waterfox, Floorp, Zen, other Gecko ≥ 115 | `dist/firefox` | Persistent background page (MV2), so connections aren't suspended. |
| Firefox for Android 120+ | `dist/firefox` | Same add-on (installs from addons.mozilla.org). The popup becomes a full-screen, touch-friendly page. There are no right-click menu, shortcuts, badge or enterprise policy, because Android doesn't offer those APIs. Sync works while Firefox is open. |
| Safari | ✗ | Safari extensions can't run WebRTC in the background. |

Tested end to end: Chromium ↔ Chromium, Chromium ↔ Firefox ESR, and the
no-offscreen fallback. Each run covered pairing, connection, a cookie and storage
transfer, and remote tab listing.

> **Brave / LibreWolf / hardened setups:** WebRTC must be allowed. In Brave, set
> *Settings → Privacy → WebRTC IP handling policy* to anything except
> "Disable non-proxied UDP". In LibreWolf, set `media.peerconnection.enabled = true`.
> Narada shows a warning when WebRTC is unavailable.

## Install (from source)

```bash
npm install
npm run build        # -> dist/chromium (MV3) and dist/firefox (MV2)
npm test             # unit tests
npm run package      # optional: dist/narada-chromium.zip + dist/narada-firefox.zip
```

* **Chromium browsers:** open `chrome://extensions` (or `edge://extensions`,
  `brave://extensions`, `opera://extensions`…), turn on Developer mode, click
  *Load unpacked* and select `dist/chromium`.
* **Firefox browsers:** open `about:debugging#/runtime/this-firefox`, click
  *Load Temporary Add-on…* and select `dist/firefox/manifest.json`. For a
  permanent install, sign the add-on via AMO (`npx web-ext sign`).

## The design

A **comic-book look, kept calm**: ink outlines, halftone paper, speech bubbles and
quick sound-effect bursts (**WHOOSH!** when you send, **ZAP!** when a device
connects, **BANDHAN!** when pairing completes, **SHABASH!** when you accept), sized
so the popup stays easy to read. Narada himself (topknot, tilak, veena) sits in
the corner and comments on what's happening.

* **Sections:** **Bhejo** (send), **Lokas** (devices), **Sandesh** (inbox), **Yantra** (settings).
* **One clear button** always says exactly what will happen ("Send 3 tabs + sign-in to Pixel").
* **Two-step pairing** with large digits to compare.
* **Inbox** names exactly which sites you would be signed in to.
* **Opens where you need it:** straight to Sandesh when something is waiting, or to Lokas when nothing is paired yet.
* Fonts (Bangers, Comic Neue) are bundled. Light and dark themes are included, and `prefers-reduced-motion` is respected.

## Usage

1. **Pair**: on device A, open *Lokas* → *Show a code*. On device B, open
   *Lokas* → *Enter a code*, paste it and click *Join*. Both devices show six
   digits. Tap *Yes, they match* on each.
2. **Send**: in *Bhejo*, choose a device, tick the tabs, and press the
   button. To stay logged in on the other side, open *Keep me signed in* and turn on
   cookies and/or site storage. The first time, the browser asks for that permission.
3. **Approve**: the receiver gets a notification. *Sandesh* shows the tabs and exactly
   which sites you would be signed in to. Nothing is applied until you tap
   *Accept & sign in* (or *Open tabs*). Requests expire after 5 minutes.

## Security model (summary)

| Threat | Mitigation |
|---|---|
| Relay operators / network observers | Signaling is AES-GCM encrypted under keys derived from the pair secret, topics rotate daily, and each Nostr event is signed by a fresh ephemeral key. Data never touches relays. |
| Leaked or guessed pairing code | 256-bit one-time secret, 10-minute expiry, single use, plus SAS comparison before the pair is saved. |
| Signaling MITM / malicious relay | Mutual ECDSA signatures with pinned keys, a session handshake bound to the DTLS fingerprints, and replay windows with nonces. |
| Compromised session key | Ephemeral ECDH per connection gives forward secrecy, and keys are separate per direction. |
| Replay/reorder/tamper on channel | AES-GCM with strictly increasing 64-bit sequence numbers. Any failure closes the connection. |
| Malicious/buggy peer payloads | Strict validation: http(s) URLs only, cookies must domain-match the tab, the storage origin must match (and is re-checked in-page), plus size and count limits. |
| Silent credential import | Every transfer carrying cookies or site storage needs explicit approval, even from a trusted device. Only plain tabs can auto-open, and only from devices you mark as trusted. There is no "pull cookies" request, so credentials only move when the sender pushes them. |
| Over-broad permissions | `cookies` and `<all_urls>` are optional and only requested when needed. Incognito is not allowed. There are no content scripts. |
| Key theft from disk | Identity and pair keys are non-extractable WebCrypto keys stored in IndexedDB. Cookies are never persisted by the extension. |
| XSS in extension UI | Strict CSP, bundled fonts and assets only, no remote code, no `innerHTML`. |

Full design: [`docs/PLAN.md`](docs/PLAN.md). Website and user docs: https://dmdhrumilmistry.github.io/narada/ (source in `site/`, deployed by `.github/workflows/pages.yml`).

### Known limitations
* Without TURN, some network pairs (for example both behind symmetric NAT or strict
  firewalls) cannot connect. The *Lokas* panel shows the last connection problem.
* Site storage covers `localStorage` and `sessionStorage`. IndexedDB and caches are not synced.
* Firefox may close the popup while it shows a permission prompt. Reopen it and repeat the action.

## Releasing

Releases are automated: run **Actions → Release** (pick patch/minor/major), or push a
`vX.Y.Z` tag. A release tests the code, publishes a GitHub Release with
provenance-attested zips, and submits to the **Chrome Web Store** and **Firefox Add-ons**.
For one-time store setup, see [`docs/RELEASING.md`](docs/RELEASING.md).
Privacy policy: [`PRIVACY.md`](PRIVACY.md), published at https://dmdhrumilmistry.github.io/narada/privacy.html.

## Tests

CI (`.github/workflows/ci.yml`) runs on every push and pull request:
1. **Unit tests, build & lint**: `npm test`, both builds, `web-ext lint` for Firefox,
   and the packaged zips uploaded as artifacts.
2. **E2E with real browsers**: Chromium ↔ Chromium and Chromium ↔ Firefox ESR pair over
   the public Nostr relays, connect over WebRTC, check that the relay sockets close,
   then transfer a tab with an HttpOnly cookie and localStorage and verify both arrived.

Locally:

```bash
npm test                                  # unit tests (crypto, pairing, secure channel, validators)
npm run e2e:prepare                       # build + test copies with permissions pre-granted
npm run e2e:chromium                      # two Chromium profiles over real public relays
FIREFOX_BIN=/path/to/firefox GECKODRIVER=/path/to/geckodriver npm run e2e:firefox   # Chromium ↔ Firefox
```
The E2E scripts need Playwright with Chromium (`PLAYWRIGHT=/path/to/playwright` if
it is installed globally). Behind an egress proxy, set `HTTP_PROXY_HOSTPORT=host:port`
for the Firefox run.

## Project layout

```
src/shared       API shim, constants, validators
src/engine       crypto, IndexedDB store, Nostr pool, signaling, pairing,
                 secure channel, WebRTC peer, engine orchestration
src/background   browser ops (tabs/cookies/storage) + per-browser entry points
src/offscreen    Chromium engine host page (offscreen document or fallback window)
src/popup        comic UI
src/assets       Narada mascot (SVG; icons are rendered from it by scripts/make-icons.mjs)
build.mjs        bundles with esbuild, copies fonts, writes per-browser manifests
test/            unit tests; test/e2e real-browser tests
```

Fonts: [Bangers](https://github.com/googlefonts/bangers) and
[Comic Neue](https://github.com/crozynski/comicneue), both SIL Open Font License,
bundled in `fonts/` with their licenses.
