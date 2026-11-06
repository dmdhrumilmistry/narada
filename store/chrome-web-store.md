# Chrome Web Store listing (copy into the developer dashboard)

The Chrome Web Store API can only upload and publish packages; it can't edit listing
text. Fill these fields once in the dashboard. Later releases only update the package.

## Store listing
**Name:** Narada: P2P Tab & Session Sync (comes from the manifest)

**Summary** (≤132 chars):
> Send selected tabs, and optionally your sign-in, between your own browsers. Encrypted, peer-to-peer, no server.

**Description:** use the text in `store/amo-metadata.json` → `description` (strip the `<b>` tags).

**Category:** Tools · **Language:** English

**Screenshots** (1280×800 or 640×400): take them from `docs/screenshots/`, padded onto a 1280×800 canvas.
**Icon:** `src/icons/icon128.png`.

## Privacy practices tab
**Single purpose:**
> Send the tabs the user selects (optionally with their cookies and site storage) directly to the user's own paired browsers over an end-to-end encrypted peer-to-peer connection.

**Permission justifications:**
| Permission | Justification |
|---|---|
| `tabs` | List the user's open tabs so they can choose which to send, and open tabs received from a paired device. |
| `scripting` | Only when the user opts in: read localStorage/sessionStorage of the selected tab to send, or restore it in a received tab. |
| `notifications` | Notify the user that a paired device sent tabs that are waiting for approval. |
| `offscreen` | Host the WebRTC peer connection, which service workers cannot create. |
| `cookies` (optional) | Only when the user opts in: read cookies for the selected tabs, and set received cookies after the user approves. |
| Host permission `<all_urls>` (optional) | Needed by the cookie and scripting steps above, only for tabs the user selects. Requested at runtime, not at install. |
| Remote code | **No.** All code is bundled in the package. |

**Data usage:** tick **Authentication information** (cookies, only on explicit
user action), **Web history** (tab URLs the user chooses to send) and **Website content**
(site storage, on user action). Then certify:
- [x] I do not sell or transfer user data to third parties, apart from the approved use cases
- [x] I do not use or transfer user data for purposes unrelated to the item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

The data goes only to the user's own paired devices, end-to-end encrypted.

**Privacy policy URL:** `https://github.com/dmdhrumilmistry/narada/blob/main/PRIVACY.md`
