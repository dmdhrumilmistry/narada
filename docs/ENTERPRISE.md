# Narada for organizations

Admins can configure Narada centrally. A setting delivered by policy **overrides the
user's choice and is locked** in the popup (shown with 🔒). Settings you don't set stay
under the user's control. Policy changes apply live in Chromium, and at the next restart in Firefox.

Restrictions are enforced on **both ends**. For example, a device whose policy forbids cookies
rejects incoming sign-in data, even if the sending device allows it.

## Settings

| Key | Type | Default | Effect |
|---|---|---|---|
| `allowPairing` | boolean | `true` | Allow pairing new devices. Existing pairs keep working. |
| `allowCookieTransfer` | boolean | `true` | Allow sending and receiving cookies. |
| `allowStorageTransfer` | boolean | `true` | Allow sending and receiving localStorage/sessionStorage. |
| `allowNotes` | boolean | `true` | Allow sending and receiving text notes. |
| `allowAutoOpen` | boolean | `true` | Allow "trusted device" auto-open. Sign-in data never auto-applies. |
| `shareTabList` | boolean | `true` | Let paired devices list this browser's open tabs. |
| `keepHistory` | boolean | `true` | Keep the last 50 received tabs (titles and links only). |
| `relays` | string[] | 5 public relays | Nostr relays for the encrypted handshake (`wss://` only). |
| `stunServers` | string[] | Google STUN | `stun:`/`stuns:` URLs. TURN is intentionally unsupported. |
| `telemetry.enabled` | boolean | `false` | Export logs to OpenTelemetry. |
| `telemetry.endpoint` | string | none | OTLP/HTTP collector base URL (`https://…`). `/v1/logs` is appended. |
| `telemetry.logLevel` | `error`·`warn`·`info`·`debug`·`off` | `info` | Minimum level, for both export and the console. |
| `telemetry.headers` | object | `{}` | Extra request headers, e.g. `Authorization`. Values are never shown to users. |
| `telemetry.resourceAttributes` | object | `{}` | Added to every log, e.g. `deployment.environment`. |

The Chromium build ships the matching JSON schema as `managed_schema.json`.

## Chrome, Edge, Brave and other Chromium browsers

Use the standard `3rdparty` extension policy. Replace `EXTENSION_ID` with Narada's ID from the store.

**Linux** (`/etc/opt/chrome/policies/managed/narada.json`; Chromium uses `/etc/chromium/policies/managed/`):
```json
{
  "3rdparty": {
    "extensions": {
      "EXTENSION_ID": {
        "allowCookieTransfer": false,
        "allowNotes": false,
        "telemetry": {
          "enabled": true,
          "endpoint": "https://otel.example.com",
          "headers": { "Authorization": "Bearer <token>" },
          "resourceAttributes": { "deployment.environment": "prod" }
        }
      }
    }
  }
}
```

**Windows** (Group Policy or Intune). Add registry values under
`HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\EXTENSION_ID\policy`
(Edge: `HKLM\Software\Policies\Microsoft\Edge\3rdparty\extensions\EXTENSION_ID\policy`):
- `allowCookieTransfer` → REG_DWORD `0`
- `relays` → REG_SZ `["wss://relay.example.com"]` (JSON for lists and objects)
- `telemetry` → REG_SZ `{"enabled":true,"endpoint":"https://otel.example.com"}`

**macOS** (Jamf, Intune, Kandji…). Deploy a configuration profile for the
`com.google.Chrome.extensions.EXTENSION_ID` preference domain (Edge: `com.microsoft.Edge.extensions.EXTENSION_ID`):
```xml
<dict>
  <key>allowCookieTransfer</key><false/>
  <key>telemetry</key>
  <dict>
    <key>enabled</key><true/>
    <key>endpoint</key><string>https://otel.example.com</string>
  </dict>
</dict>
```

**Google Admin console:** Devices → Chrome → Apps & extensions → select Narada →
*Policy for extensions*, then paste the JSON object (the inner part above).

To force-install it, use `ExtensionInstallForcelist` (or the admin console) with the Chrome Web Store ID.

## Firefox (and ESR, LibreWolf…)

Use `policies.json` (in `distribution/` next to the Firefox binary, or via the Firefox
ADMX/macOS templates):
```json
{
  "policies": {
    "3rdparty": {
      "Extensions": {
        "narada@dmdhrumilmistry": {
          "allowCookieTransfer": false,
          "telemetry": { "enabled": true, "endpoint": "https://otel.example.com" }
        }
      }
    },
    "ExtensionSettings": {
      "narada@dmdhrumilmistry": {
        "installation_mode": "force_installed",
        "install_url": "https://addons.mozilla.org/firefox/downloads/latest/narada/latest.xpi"
      }
    }
  }
}
```

The `install_url` works once Narada is listed on addons.mozilla.org.

## OpenTelemetry

Narada sends **OTLP/HTTP JSON logs** (`POST <endpoint>/v1/logs`), batched every 5 s.
Failed exports are retried 3 times, then dropped, so logging never blocks syncing.

**What's exported:** event names such as `engine.start`, `pair.started`, `pair.completed`,
`pair.failed`, `peer.connected`, `peer.closed`, `transfer.sent`, `transfer.received`,
`transfer.resolved`, `note.sent`, `note.received`, `policy.blocked`, `policy.reloaded`,
`settings.changed` and `signal.error`. Each has allow-listed attributes: counts, booleans,
statuses, a short peer ID and error messages with anything URL-like removed.
Resource attributes are `service.name=narada-extension`, `service.version`, `browser.name`,
`service.instance.id` (a short device ID), plus your own.

**Never exported:** URLs, page titles, cookies, site storage, note text, relay or STUN addresses.

**Collector setup.** Browser extensions call the collector cross-origin, so enable CORS:
```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins: ["chrome-extension://*", "moz-extension://*"]
          allowed_headers: ["*"]
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [debug]
```
Most hosted OTLP backends (Grafana Cloud, Honeycomb, New Relic, Datadog via the collector…)
work the same way. Put the API key in `telemetry.headers`.

## Verifying

- **Chromium:** open `chrome://policy` → *Reload policies*, then check the extension's entry.
- **Firefox:** open `about:policies`.
- **In Narada:** the Yantra tab shows "🏢 Some settings are managed by your organization", and the locked settings carry 🔒.

The CI pipeline tests real policies in both browsers (`npm run e2e:policy`).
