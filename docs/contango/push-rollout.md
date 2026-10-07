# Push notifications — rollout handoff

Turns on native iOS push (inbox items + agent chat replies) for a self-hosted
server running the fork image. Design: `docs/superpowers/specs/2026-10-07-push-notifications-design.md`.

Placeholders: `<KEY_ID>` (APNs key id), `<TEAM_ID>` (Apple team id),
`<BUNDLE_ID>` (the iOS app's production bundle id), `<SHA>` (image tag).

## 1. Apple: create the push key (once)

Apple Developer → Certificates, IDs & Profiles → **Keys** → **+** → name it,
tick **Apple Push Notifications service (APNs)** → Continue → Register →
**Download** `AuthKey_<KEY_ID>.p8`. It can be downloaded only once — store it
in the password manager. Note the Key ID shown on the page.

## 2. Image access

The fork's workflow `contango-backend-image` publishes
`ghcr.io/contango-xyz/multica-backend:<SHA>` and `:contango-latest` on every
push to a `contango/**` branch that touches `server/`. GHCR packages start
private. Either:
- make the package public (it contains only the public fork's code), or
- on the server box: `docker login ghcr.io` with a token that has `read:packages`.

## 3. Server box

1. Back up the database first.
2. Copy the key to a root-only path, e.g. `/etc/multica/apns/AuthKey.p8`
   (`chmod 600`), and mount it read-only into the backend container, e.g.
   `- /etc/multica/apns/AuthKey.p8:/run/secrets/apns.p8:ro`.
3. Set in the backend's environment:
   ```
   MULTICA_BACKEND_IMAGE=ghcr.io/contango-xyz/multica-backend
   MULTICA_IMAGE_TAG=<SHA>
   MULTICA_APNS_KEY_PATH=/run/secrets/apns.p8
   MULTICA_APNS_KEY_ID=<KEY_ID>
   MULTICA_APNS_TEAM_ID=<TEAM_ID>
   MULTICA_APNS_ALLOWED_BUNDLE_IDS=<BUNDLE_ID>
   ```
4. Pull and restart the backend. Migrations 564–566 add the `push_device`
   table (additive only).
5. Check: backend log contains `push notifications enabled`; `/health` is OK;
   `push_device` table exists.

## 4. Rollback

Set `MULTICA_IMAGE_TAG` back to the previous upstream tag (or unset the
`MULTICA_APNS_*` variables to keep the image but disable push). The extra
table is harmless to the upstream image.

## 5. Verify end to end

On an iPhone with the new app build: accept the notification prompt, lock the
phone, @mention the user from web → banner within seconds, badge = unread
count, tap opens the issue. An agent chat reply → banner that opens the chat.
Turning "System notifications" off for the workspace on web stops pushes for
that workspace. Signing out of the app stops pushes to that phone.
