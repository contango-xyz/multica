# Fork desktop build: push, click routing, link handling

Date: 2026-10-09. Status: draft for review.

## Why

The stock desktop app (upstream 0.7.0) has three problems for us:

1. Notifications exist only while the app runs. The renderer builds them from
   its WebSocket, so a quit app or a sleeping Mac gets nothing.
2. Clicking a notification only brings the app forward. Main creates an
   Electron `Notification` in a local variable; once it is garbage collected
   the click handler is gone and macOS just activates the app.
3. Ticket links clicked in Slack or other apps open the browser. The app only
   claims `multica://`.

The notification text is also poorer than iOS since the server-built
"`<ID> · <who> <did what>` / issue title / detail" layout shipped.

## Goal

One fork build of the desktop app, installed from a DMG served by our server,
that:

- receives APNs pushes like the phone, including when the app is not running;
- opens the right inbox item or chat when a notification is clicked;
- can be chosen by a link router (Choosy) for `https://<our server>/...` links
  and opens the matching screen;
- updates itself from a feed on our server.

Out of scope: web image changes, Windows/Linux, Intel Macs, upstreaming.

## Design

### 1. Identity and signing

- New bundle id under our Apple team (e.g. `<reverse-domain>.multica.desktop`),
  not upstream's `ai.multica.desktop`. Needed because APNs and the provisioning
  profile are tied to an App ID we own.
- Signed with a Developer ID Application certificate, notarized with
  notarytool (electron-builder already has `notarize: true`).
- A Developer ID provisioning profile for that App ID with Push Notifications
  enabled, embedded via `mac.provisioningProfile`. Entitlements add
  `com.apple.developer.aps-environment = production`, the application
  identifier and the team identifier.
- Product name stays "Multica". Users delete the upstream app first: both
  claim `multica://`.
- Default server URL baked in at build time, so a fresh install needs no
  `~/.multica/desktop.json`. An existing file still wins.
- arm64 only.

### 2. Push on macOS

App side (main process):

- After login, call Electron's `pushNotifications.registerForAPNSNotifications()`
  and send the token to the existing `POST /api/push/devices` with
  `platform: "macos"`, the bundle id and `environment: "production"`.
  Unregister on logout (existing `DELETE`).
- Clicks: a click while running arrives through Electron's notification
  events; a click that launches the app arrives in the `ready` event's
  `launchInfo`. Both feed the existing main→renderer routing:
  `kind: inbox` → the inbox page focused on the issue (what `inbox:open` does
  today), `kind: chat` → that chat.
- While the device is registered, the renderer's local notification path is
  off, so nothing shows twice. If registration fails, local notifications
  stay on (current text) with the click fix from section 3.

Server side:

- `push_device` accepts `platform` `ios` or `macos`.
- The desktop bundle id joins `MULTICA_APNS_ALLOWED_BUNDLE_IDS`. Same `.p8`
  key: APNs keys are team-wide; the topic is the device's bundle id, which
  the sender already uses per device.
- No change to what is sent: Mac and phone get the same title, subtitle,
  body, thread id, badge and data.

### 3. Local notification click fix

Keep each shown `Notification` in a set until it is clicked or closed, so
its click handler survives. Small and upstreamable on its own.

### 4. Opening web links in the app

- Declare `http`/`https` in `CFBundleURLTypes` (electron-builder
  `protocols`) so macOS link routers list the app. The app does not ask to
  become the default browser.
- `open-url` with an `https` URL whose host is our server: strip the origin
  and navigate the active workspace tab to that path (desktop routes match web
  paths). Any other `http(s)` URL goes to the default browser.
- Choosy rule (user side): our server host → Multica.

### 5. Updates and distribution

- `publish` becomes electron-builder's `generic` provider pointing at
  `https://<our server>/desktop/`. The updater code stays as is.
- Ops serves that directory as static files: DMG, update ZIP, blockmap,
  `latest-mac.yml`. VPN-only like the rest of the server.
- Versions are `<upstream>-contango.<n>` (e.g. `0.7.0-contango.1`), with the
  updater set to accept that prerelease channel. A rebase on a newer
  upstream resets n.
- Builds run on the owner's Mac (certificate in the login keychain), not in
  CI: the fork is public and we keep the certificate off GitHub. A script
  builds, signs, notarizes and uploads to ops.

## Risks, checked first

A spike before any feature work proves the chain end to end with a
throwaway build:

1. Developer ID + provisioning profile + `aps-environment` signs, notarizes
   and launches.
2. `registerForAPNSNotifications` returns a token on a Developer ID build.
3. A push sent with the existing server key reaches the Mac with the app
   quit, and clicking it launches the app with the payload in `launchInfo`.

If 2 or 3 fails, we drop section 2 and still ship 3, 4 and 5 (local
notifications with server-like text where the renderer has the data).

## Testing

- Go: handler tests for `platform: macos`. The dispatcher is unchanged.
- Desktop: unit tests for URL→route mapping and payload→route mapping;
  test that notifications are retained until click/close.
- Manual E2E on the owner's Mac: install the DMG, log in, quit the app, get a
  comment → banner with the new text; click → opens the item. App running →
  one banner, not two. Slack link via Choosy → opens the issue. Publish
  `contango.2` → the installed app updates.

## What the owner does

- Create the Developer ID Application certificate and the push-enabled
  Developer ID provisioning profile (Apple Developer portal, ~10 minutes).
- Create an app-specific password for notarization.
- Delete the upstream app and install ours; add the Choosy rule.
