# iOS push notifications — design

Status: approved in conversation 2026-10-07, pending written-spec review.
Branch: `contango/push-notifications` (fork `contango-xyz/multica`), stacked on
`contango/mobile-saved-views` (v0.6.1 + saved views).

## Goal

The iOS app notifies the user when something needs them: every new inbox item (the same items the
desktop app shows OS notifications for) and every finished agent reply in the user's chat sessions,
with the app icon badge showing the unread inbox count. Tapping a notification opens the matching
screen.

Success: on a TestFlight build on a locked iPhone, an @mention made on web produces a banner within a
few seconds, the badge shows the unread count, and tapping opens the issue; an agent finishing a chat
reply produces a banner that opens that chat.

## Decisions

- **Triggers:** inbox items + chat replies only. No custom-property ("Needs me") rule — agents already
  @mention the responsible human.
- **Transport:** the server talks to Apple Push Notification service (APNs) directly, token-based auth
  with a `.p8` key. No Expo push relay, no third party sees notification content.
- **Server:** our own backend image built from the fork; push is inert unless configured.
- **Scope:** iOS only.

## Behaviour

**Inbox push.** On every `inbox:new` bus event whose item has `recipient_type = "member"`: push to every
enabled device of that user.
- Title: the inbox item's `title`; body: its `body` (same fields the desktop banner uses, see
  `packages/core/realtime/use-realtime-sync.ts` `handleInboxNew`). Truncate body to 180 characters.
- Payload data: `{ kind: "inbox", workspace_slug, item_id, issue_id?, comment_id? }`.
- Notification preferences need no extra handling: muted groups never create inbox items
  (`notification_listeners.go` `isNotifMuted`).

**Chat push.** On every `chat:done` bus event: push to the chat session's owner when the finished turn
produced an assistant message. If the event payload lacks the owner or message text, the dispatcher
loads the session and its newest assistant message by id (sqlc) before sending.
- Title: the agent's name; body: the first line of the assistant message, truncated to 180 characters.
- Payload data: `{ kind: "chat", workspace_slug, session_id }`.
- `thread-id` = session id so iOS groups a conversation.

**Badge.** Every push carries `badge` = the recipient's unread inbox count across workspaces, computed
with the same query as `GET /api/inbox/unread-summary` (`CountUnreadInboxByWorkspace`, summed). The app
also sets the badge from `useInboxUnreadCount` whenever it is foregrounded, so reading items clears it.

**Taps.** `kind: "inbox"` → the same destination as tapping the inbox row on mobile
(`lib/inbox-display.ts` `getInboxNavigationTarget`), switching workspace by slug if needed.
`kind: "chat"` → that chat session.

**Foreground.** Banners show while the app is open, except a chat push for the chat session currently on
screen.

## Server (Go, `server/`)

**Table `push_device`** (new migration; no foreign keys; each index in its own
`CREATE INDEX CONCURRENTLY` migration file per repo rules):
`id uuid pk, user_id uuid not null, platform text not null ('ios'), token text not null,
bundle_id text not null, environment text not null ('sandbox'|'production'), created_at, last_seen_at,
disabled_at timestamptz null`. Unique index on `token`; index on `user_id`. sqlc queries: upsert by
token (re-assigns user, clears `disabled_at`, bumps `last_seen_at`), list enabled by user, delete by
(user, token), disable by token. Account deletion cleanup deletes the user's rows in application code
where other per-user rows are cleaned.

**Endpoints** (authenticated, user-scoped, not workspace-scoped):
- `POST /api/push/devices` `{ platform:"ios", token, bundle_id, environment }` → 204. Validates platform,
  environment, non-empty token ≤ 200 chars.
- `DELETE /api/push/devices/{token}` → 204; only deletes the caller's own row (another user's token →
  204 no-op, no information leak).

**Sender** (`server/internal/push/`):
- `Sender` interface `Send(ctx, device, notification) (result, error)`; APNs implementation using
  token-based auth (ES256 JWT from the `.p8` key, cached ~50 min) over HTTP/2 to
  `api.push.apple.com` or `api.sandbox.push.apple.com` per device environment, `apns-topic` = the
  device's `bundle_id`, `apns-push-type: alert`, `apns-priority: 10`. Implement with the standard
  library + `golang-jwt` if already a dependency; otherwise a small vetted APNs client — decided in the
  plan after checking `go.mod`.
- APNs 410 or `BadDeviceToken`/`Unregistered` → disable that token. Other errors → log and drop (no
  retry queue).
- **Dispatcher** subscribes to `inbox:new` and `chat:done` on the event bus at startup (same pattern as
  `integrations/wecom/outbound.go`), builds the notification, and hands sending to a bounded worker
  goroutine pool (buffered channel; when full, drop with a warning) so bus publishers never block.
  Per-send timeout 10 s.

**Config** (env, all required to enable push; absent → dispatcher not registered, endpoints still
accept registrations): `MULTICA_APNS_KEY_PATH` (or `MULTICA_APNS_KEY` PEM contents),
`MULTICA_APNS_KEY_ID`, `MULTICA_APNS_TEAM_ID`. The topic comes from each device's `bundle_id`;
`MULTICA_APNS_ALLOWED_BUNDLE_IDS` (comma list) restricts which bundle ids may register.

## Mobile (`apps/mobile`)

- Add `expo-notifications` via `pnpm exec expo install expo-notifications`; config plugin entry in
  `app.config.ts` so prebuild writes the `aps-environment` entitlement (`production` for Release builds).
- After login: request permission once (iOS prompt); on grant, `getDevicePushTokenAsync()` (raw APNs
  token, not an Expo token) and `POST /api/push/devices` with `environment` = `sandbox` for Debug builds,
  `production` otherwise, and the running bundle id. Re-register on every app start and when the token
  changes. Logout → `DELETE` before clearing auth.
- Response handler maps payload → route (pure function, tested); foreground handler suppresses only the
  currently open chat session (pure predicate, tested).
- Badge: set from the unread count when foregrounded.

## Build and deploy

- New workflow `.github/workflows/contango-backend-image.yml` (fork only): on push to
  `contango/**` branches and manual dispatch, build `Dockerfile` for linux/amd64 and push
  `ghcr.io/contango-xyz/multica-backend:<short-sha>` and `:contango-latest`. Upstream workflows unchanged.
- Rollout on the server box (handoff document, executed by the user or the box's admin agent):
  set `MULTICA_BACKEND_IMAGE`/tag to ours, add the APNs env vars and mount the `.p8` key read-only,
  ensure the box can pull the image (make the package public or add a pull token), restart backend,
  confirm migrations applied and `/health` OK.
- User prerequisites: create an APNs key (Apple Developer → Keys → Apple Push Notifications service),
  note key id; Push capability gets enabled on the App ID when Xcode signs with the new entitlement.

## Error handling

- Push not configured → no sending, no errors at startup beyond one info log.
- APNs unreachable/timeouts → logged per send, notification dropped; app state unaffected.
- Registration while logged out / malformed body → 401 / 400. Permission denied on device → no
  registration, app works normally.
- Stale tokens are disabled on APNs rejection; re-registration re-enables.

## Testing

- Go: endpoint tests with `testutil` fixtures (register, re-register same token by another user moves
  ownership, unregister own vs other's, validation, auth). Dispatcher tests with a fake `Sender`:
  inbox item → push to all enabled devices of the member recipient only; agent recipient ignored;
  chat done → owner only; badge = summed unread count; payload fields; 410 disables the token; no
  config → not registered; full queue drops without blocking the publisher.
- Mobile vitest: payload → route mapping (issue, comment highlight, inbox-only types, chat, unknown →
  null), foreground suppression predicate, API client register/unregister calls.
- Device: TestFlight build on a locked iPhone — @mention from web → banner, badge, tap opens issue;
  agent chat reply → banner opens chat; open that chat, trigger another reply → no banner.

## Out of scope

Android; per-device mute/settings screen; a "Needs me" property rule; notification actions (reply,
approve); retry queue for failed sends; web/desktop changes.
