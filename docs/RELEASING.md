# Releasing Narada

Releases are automated by `.github/workflows/release.yml`. Each release:

1. **Builds and tests** the tagged commit: unit tests, both builds, and `web-ext lint`.
2. **Creates a GitHub Release** with `narada-chromium.zip`, `narada-firefox.zip`,
   `narada-source.zip` and `SHA256SUMS`, plus signed build-provenance attestations
   (verify with `gh attestation verify narada-chromium.zip --repo dmdhrumilmistry/narada`).
3. **Publishes to the Chrome Web Store**: it uploads the package and submits it for review.
4. **Publishes to Firefox Add-ons (AMO)**: it submits a listed version with the source
   archive and reviewer build notes, and syncs the listing text from `store/amo-metadata.json`.

Steps 3 and 4 are skipped with a warning until their credentials are configured, so
GitHub Releases work from day one.

## Cutting a release

**From GitHub (recommended):** go to Actions → **Release** → *Run workflow* (on `main`),
pick `patch`, `minor` or `major`, and run it. The workflow bumps `package.json`, commits
`Release vX.Y.Z` to `main`, tags it, and runs everything above.

**From your machine:**
```bash
git switch main && git pull
npm version patch        # or minor / major: bumps package.json, commits and tags vX.Y.Z
git push --follow-tags   # the tag push triggers the Release workflow
```

The manifest version comes from `package.json`, and the workflow refuses a tag that
doesn't match it. Both stores require each upload to have a higher version than the last.

> If `main` is protected so that Actions can't push to it, use the local flow, or allow
> `github-actions[bot]` to bypass the rule.

## One-time setup

### 1. GitHub environments
In **Settings → Environments**, create `chrome-web-store` and `firefox-addons`.
Adding yourself as a *Required reviewer* on each is recommended, so every store
publish waits for one click of approval.

### 2. Chrome Web Store
1. Register at the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole)
   (one-time US$5 fee) and verify your email.
2. **Create the item manually the first time:** run a release (or `npm run package`),
   then upload `narada-chromium.zip` with **New item**.
3. Fill in the **Store listing** and **Privacy practices** tabs using
   [`store/chrome-web-store.md`](../store/chrome-web-store.md). The privacy policy URL is
   `https://github.com/dmdhrumilmistry/narada/blob/main/PRIVACY.md`. Submit it for review.
4. Note the **extension ID** (from the item URL) and your **publisher ID** (from the
   dashboard URL / Account page).
5. Create OAuth credentials for the Chrome Web Store API by following
   [this guide](https://github.com/fregante/chrome-webstore-upload-keys). It produces a
   client ID, client secret and refresh token.
6. Add them to the `chrome-web-store` environment:

   | Kind | Name | Value |
   |---|---|---|
   | Variable | `CWS_EXTENSION_ID` | extension ID |
   | Variable | `CWS_PUBLISHER_ID` | publisher ID |
   | Secret | `CWS_CLIENT_ID` | OAuth client ID |
   | Secret | `CWS_CLIENT_SECRET` | OAuth client secret |
   | Secret | `CWS_REFRESH_TOKEN` | OAuth refresh token |

From then on, each release uploads the new package and submits it for review. Google
publishes it automatically once it's approved.

### 3. Firefox Add-ons (AMO)
1. Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/) and accept
   the developer agreement.
2. Create API credentials under **Tools → Manage API Keys**
   (`https://addons.mozilla.org/developers/addon/api/key/`).
3. Add them to the `firefox-addons` environment:

   | Kind | Name | Value |
   |---|---|---|
   | Secret | `AMO_JWT_ISSUER` | JWT issuer |
   | Secret | `AMO_JWT_SECRET` | JWT secret |

There's no manual first step. The first release creates the listing (ID
`narada@dmdhrumilmistry`) with the metadata in `store/amo-metadata.json`, and every
release after that adds a version. Afterwards, add screenshots once in the AMO dashboard.

Every release overwrites the AMO summary and description with the text in
`store/amo-metadata.json`, so edit them there, not in the dashboard.

Because the code is bundled, AMO requires the source. The workflow uploads
`narada-source.zip` (the tagged commit) with build instructions for reviewers:
Node.js 22, then `npm ci && npm run build`.

## What reviewers will look at
* **Cookies and `<all_urls>`** are optional permissions, requested only on user action.
  This, plus the explicit approval step on the receiving side, is what keeps the
  extension within both stores' policies. Expect Chrome's "in-depth review", which can
  take a few days.
* **No remote code**: everything is bundled. The only network traffic is WebSocket
  connections to Nostr relays and WebRTC with STUN.
* **Firefox data collection:** the manifest declares `data_collection_permissions: none`,
  because nothing is sent to the developer or any third party.
