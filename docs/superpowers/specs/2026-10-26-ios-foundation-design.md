# iOS App Foundation (fork) — Design

## Intent

The iOS app is the owner's remote control for keeping agents moving while away from the desk: a notification says an agent needs something, a tap lands on exactly that thing, and the owner unblocks it (comment, status change, or a chat with an agent). Secondary: a glance at what is in flight and what is stuck, and chatting with agents to add cards or nudge work. The rest of the team uses the app too, through TestFlight.

Success, in the owner's words: the app is good enough that, when away from the keyboard, the owner can keep the ball rolling efficiently. This document covers the **foundation** that everything else depends on. Two later projects build on it and are out of scope here: (2) the fork's dependency features on mobile (blocked-by on each issue, the global dependency graph), and (3) general app improvements from the owner's list.

## Why now

- Push is dead for every TestFlight user. Root cause (verified in code): `apps/mobile/data/push-registration.ts` gives up when `Application.getIosPushNotificationServiceEnvironmentAsync()` returns null. That function reads `embedded.mobileprovision` (`expo-application` `EXProvisioningProfile.m`), which TestFlight / App Store builds do not contain. Only a development-signed build installed directly ever registered (the owner's phone, sandbox, 2026-10-07); after a TestFlight build replaced it, push stopped.
- The last TestFlight build is from the 0.6.1 era; the code in this repo is already on v0.7.0 + fork patches (the app lives in the monorepo), so only the build is stale.
- Every fix currently needs a full TestFlight round, and the last local build needed hand patches to generated `ios/` files (Xcode 27) that are lost on every `expo prebuild --clean`.

## Goals

1. **Push works for every TestFlight user and keeps working.**
   - Registration treats "no embedded provisioning profile, not a simulator" as `production` instead of skipping.
   - Registration keeps running on every app start (it already does) and additionally when the app returns to the foreground after a long time (owner's desktop app refreshes daily; same idea), so the server's 30-day `last_seen_at` filter never drops an active phone.
   - Logout keeps unregistering first (existing behaviour).
2. **A tap opens the right screen**, for every push kind the server sends (inbox item types including mentions, comments, assignments, autopilot notices; agent chat replies), including a push for a workspace other than the current one, from cold start, background and foreground. The existing mapping (`apps/mobile/lib/push-routing.ts`, `use-push-notifications.ts`) is the starting point; verify each server push kind against it (`server/internal/push/dispatcher.go`, `text.go`) and fix gaps.
3. **Links open in the app.** Links to our server (from Slack, the GitHub app, Mail, etc.) open the matching screen in the app via iOS universal links, for the paths the app has screens for (issues, inbox, chat, at least); other paths stay in the browser.
   - Apple fetches `https://<server host>/.well-known/apple-app-site-association` through its CDN, from the public internet. The server is VPN-only. Decided approach: the existing Cloudflare tunnel publicly serves **only** that one path for the server's hostname (everything else 404 from outside); inside the VPN the hostname keeps resolving to the internal server. The ops side (tunnel route, public DNS for the hostname, serving the file) is done by the owner's admin-box agent from instructions this project produces.
   - The association file contains only the app identifier (team id + bundle id) and the allowed paths.
4. **Builds on EAS, under Contango's Expo organization** (decided by the owner): cloud builds, automatic upload to TestFlight (EAS Submit). No more manual Xcode archiving on the owner's Mac.
5. **OTA updates via EAS Update.** JS/asset changes reach installed apps without TestFlight. Behaviour (decided by the owner): when an update has downloaded, the app **tells the user and offers to restart**; if dismissed, the update applies on the next normal launch.
6. **Reproducible native project.** The Xcode-27 era fixes that lived only in generated `ios/` either become permanent (config / config plugins / expo-build-properties) or are shown to be unnecessary on the current Expo SDK (57) with the chosen EAS build image. Fixes previously needed (from the 2026-10-07 build): pod targets' iOS deployment target floor; app minimum iOS raised to 16 (expo-router UIAction subtitle); `ENABLE_USER_SCRIPT_SANDBOXING = NO` for Archive; a `SceneDelegate` + `UIApplicationSceneManifest` because iOS-27-SDK apps must adopt UIScene (crash at launch without it). Each must be re-checked against SDK 57 rather than copied blindly.
7. **A new TestFlight build** carrying all of the above, which becomes the base that OTA updates target.

## Non-goals

- Android (the team has no Android app).
- New product features (dependency views, general improvements) — projects 2 and 3.
- Self-hosting an update server.
- Changing the server's push payloads beyond what tap routing strictly needs.

## Anti-goals

- Silent failure: push registration or OTA that fails without any trace. A failure must at least be visible in logs/diagnostics the owner or an agent can read.
- An OTA update that can brick the app: updates must only reach builds with a matching native runtime, and a broken update must be recoverable (EAS rollback / republish).
- Leaking internal values into the public repo: the server hostname, Apple team id and bundle id stay out of committed files (today they live in git-ignored env files; on EAS they live in EAS environment variables / secrets).
- Exposing anything besides the association file through the public tunnel.

## Constraints

- Public repo (contango-xyz/multica): no internal hostnames, team id, bundle ids, Expo project ids that reveal the org name are acceptable only if unavoidable (prefer env-driven config).
- Apple: team "Distributed Consulting" (paid), app id `<bundle id>` already exists with Push; the owner is not the Account Holder — creating an App Store Connect API key and adding the Associated Domains capability may need the Account Holder or an Admin. Testers need app access in App Store Connect and the company VPN.
- OTA updates read only the EAS environment's variables (lesson from Contango's other app, gui-native): build-time env in `eas.json` profiles does not apply to updates.
- Mobile rules in `apps/mobile/AGENTS.md` apply.
- Builds must not require the owner's Mac.

## Decided by the owner

- Foundation first, then dependency features, then general improvements.
- EAS for builds and updates, Contango's Expo organization.
- OTA: prompt to restart, apply on next launch if dismissed.
- Universal links via a public-only-for-AASA route on the existing Cloudflare tunnel.
- iOS only.

## Facts (answers to the builder check)

- **The TestFlight app** is the production variant: `APP_ENV=production` with `EXPO_BUNDLE_IDENTIFIER_PROD` set to the existing App Store Connect app's bundle id (the owner's value, kept in git-ignored env / EAS environment variables; not `ai.multica.mobile`). The same value goes into the association file, the Associated Domains entitlement and EAS Submit. Staging and dev variants stay local-only (no EAS profiles) — *controller's call*.
- **Server push config is already done**: ops holds the APNs `.p8` key (one key serves both environments), team id, and `MULTICA_APNS_ALLOWED_BUNDLE_IDS` includes the iOS bundle id. The server sends to `api.push.apple.com` or the sandbox host per device row (`server/internal/push/apns.go`). No server/ops push change is in scope.
- **Credentials and Apple/Expo steps come last in the plan**: do all credential-independent work first (push fix, tap routing, config plugins, OTA code, association-file content), then the owner's checklist (Contango Expo org access + `eas init`, App Store Connect API key for EAS Submit, Associated Domains capability on the app id, distribution credentials via EAS), then the first EAS build — *controller's call*.
- **Committed config**: `eas.json`, EAS workflows (if used) and the EAS project id / updates URL may be committed — the project id is an opaque UUID and the fork is public under the same organization anyway. No secrets, hostnames, team id or bundle id in committed files — *controller's call*.
- **Unknown push kinds / inbox types**: fall back to the inbox screen of the payload's workspace (never a dead tap). Adding fields to the server's push payload is allowed when routing needs them (the server is ours) — *controller's call*.
- **A link to a workspace the user is not in**: open it in the app and let the app's normal no-access handling show — *controller's call*.
- **Scene support**: `app.config.ts` already sets scene support; the builder verifies which of the old Xcode-27 fixes are still needed rather than re-adding them.
- **Releases**: one `production` update channel for the TestFlight build; OTA publishing by a manual command run by the owner or an agent with EAS access; no staging channel for now — *controller's call*.

## Left to the builder

- `runtimeVersion` policy (fingerprint vs app version) — pick the one that makes "native change ⇒ new runtime" automatic and safe.
- Update channels/branches layout (e.g. one `production` channel for TestFlight), and how a release is triggered (manual command vs EAS workflow).
- The exact foreground re-registration trigger and interval.
- How the restart prompt looks (match the app's existing UI patterns and copy rules).
- The exact universal-link path list, and how links map to screens (reuse expo-router's routing; the mobile app's routes differ from web paths — map web paths to mobile screens).
- Whether to pin the EAS Xcode image to avoid Xcode-27 issues, as long as App Store Connect accepts the SDK.
- The ops instruction text for the admin-box agent (tunnel route, DNS, file content) and the owner's Apple-portal checklist (API key, Associated Domains).

## Done when

- A fresh TestFlight install on the owner's phone registers a `production` push device on the server, receives pushes for inbox items and chat replies, and each tap opens the right screen (including another workspace and cold start).
- A link to an issue on our server tapped in Slack or the GitHub app opens that issue in the app.
- A JS-only change published with EAS Update reaches the TestFlight app, which offers a restart and shows the change afterwards.
- `expo prebuild --clean` + an EAS build produces a working app with no hand edits.
