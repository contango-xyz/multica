# iOS App Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push that works for every TestFlight user, taps and links that land on the right screen, EAS cloud builds with OTA updates that offer a restart, and a native project that rebuilds without hand edits.

**Architecture:** Small, pure, unit-tested helpers in `apps/mobile/lib/` carry every decision (push environment, re-registration timing, push → screen, web link → mobile route, update prompt); hooks and `app.config.ts` wire them to Expo APIs. EAS (Contango's Expo org) builds and submits; EAS Update serves OTA bundles to a `production` channel. Apple/Expo/ops steps that need humans are collected into one checklist and come last.

**Tech Stack:** Expo SDK 57, expo-router, expo-notifications, expo-application, expo-updates (new), EAS Build/Submit/Update, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-ios-foundation-design.md`

## Global Constraints

- iOS only. Rules in `apps/mobile/AGENTS.md` bind (add native packages with `pnpm exec expo install`; generated `ios/` is not source; `scripts/ios-run.sh` for local runs).
- Public repo: no server hostname, Apple team id or bundle id in committed files. They come from env vars: existing `EXPO_BUNDLE_IDENTIFIER_PROD`, `EXPO_APPLE_TEAM_ID`, `EXPO_PUBLIC_API_URL`/web URL vars (check `.env.production` naming), plus new `EXPO_ASSOCIATED_DOMAIN` (host only). Locally in git-ignored `.env.production.local`; on EAS in the EAS `production` environment (OTA updates read only the EAS environment).
- The EAS project id / updates URL may be committed.
- OTA behaviour: when an update has downloaded, tell the user and offer to restart; if dismissed, it applies on the next normal launch.
- Push registration environment: entitlement value if present; no embedded profile ⇒ `production`.
- No server/ops push changes (already configured). Push payload fields may be added only if routing needs them.
- Commit subjects end with `(contango)`; signed commits.

## Review Focus

1. **Notification permission denied or later revoked** → no crash, no registration, no error loop; re-enabling in iOS Settings registers on the next foreground (Task 1 test: denied ⇒ no API call; foreground after grant ⇒ registers).
2. **APNs token rotation / reinstall** → the new token reaches the server on the next start or foreground; the old row ages out (Task 1 test: different token than stored ⇒ registers and stores the new one).
3. **Universal link while logged out or on another workspace** → after login the user lands on the linked screen, not the default tab; another workspace switches to it (Task 3 test for the mapping; manual check in Task 7).
4. **Push or link for an unknown/new inbox type or an unmapped web path** → inbox of that workspace, never a dead tap (Task 2 and Task 3 tests).
5. **OTA update downloaded while the user is typing a comment** → the prompt never discards input on its own; "Later" keeps the user in place (Task 4 test: dismiss ⇒ no reload).

---

### Task 1: Push registration works on TestFlight and stays fresh

**Files:**
- Create: `apps/mobile/lib/push-environment.ts`, `apps/mobile/lib/push-environment.test.ts`
- Modify: `apps/mobile/data/push-registration.ts`, `apps/mobile/lib/use-push-notifications.ts`

**Interfaces:**
- Produces: `resolvePushEnvironment(entitlement: string | null): "sandbox" | "production"`; `shouldReRegister(lastRegisteredAt: number | null, now: number): boolean` with `PUSH_REFRESH_MS = 24 * 60 * 60 * 1000`; `registerForPush(): Promise<void>` unchanged signature.

- [ ] **Step 1: Failing tests** (`push-environment.test.ts`, `// @vitest-environment node`):
  - `resolvePushEnvironment("development")` → `"sandbox"`; `("production")` → `"production"`; `(null)` → `"production"` (TestFlight/App Store builds have no embedded profile).
  - `shouldReRegister(null, 0)` → `true`; `(0, PUSH_REFRESH_MS - 1)` → `false`; `(0, PUSH_REFRESH_MS)` → `true`.
- [ ] **Step 2: Run** `cd apps/mobile && pnpm vitest run lib/push-environment.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the helpers. In `push-registration.ts`: drop the `if (!env || !bundleId) return` early exit for env (keep it for `bundleId`), use `resolvePushEnvironment(env)`. A simulator still fails at `getDevicePushTokenAsync` and is caught (keep the catch, keep the log line). Record `lastRegisteredAt` (module variable) on success; export `registerForPushIfStale(now = Date.now())` that calls `registerForPush()` when `shouldReRegister` says so.
- [ ] **Step 4: Wire foreground refresh** in `use-push-notifications.ts`: subscribe to `AppState` `change`; on `"active"` call `registerForPushIfStale()`. Remove the subscription on unmount.
- [ ] **Step 5: Tests** for the Review Focus 1–2 lines in a new `data/push-registration.test.ts` (mock `expo-notifications`, `expo-application`, `expo-secure-store`, `@/data/api` the way `data/api.test.ts` mocks modules): permission denied ⇒ `api.registerPushDevice` not called; entitlement `null` ⇒ called with `environment: "production"`; a token different from the stored one ⇒ registers and stores the new token.
- [ ] **Step 6: Run** `pnpm vitest run lib/push-environment.test.ts data/push-registration.test.ts` → PASS; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 7: Commit** `fix(mobile): register TestFlight builds for production push and refresh daily (contango)`.

### Task 2: Every push lands on the right screen

**Files:**
- Modify: `apps/mobile/lib/push-routing.ts`, its test file (find with `ls apps/mobile/lib/push-routing*.test.ts`; create `push-routing.test.ts` if absent)
- Read only: `server/internal/push/dispatcher.go`, `server/internal/push/text.go`, `packages/core/types/inbox*.ts` (inbox type union), `apps/mobile/lib/inbox-display.ts` (`getInboxNavigationTarget`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `pushTarget(data: PushData): PushTarget` — same signature; behaviour completed below.

- [ ] **Step 1: Inventory.** List every push the server sends (`kind: "inbox"` with each inbox `type`; `kind: "chat"`) and the fields each carries (`workspace_slug`, `item_id`, `issue_id`, `comment_id`, `session_id`). Write the list as a table in the test file header comment.
- [ ] **Step 2: Failing tests** — one `it` per inbox type from the core union: with `issue_id` ⇒ `/[workspace]/issue/[id]` (+ `highlight` when `comment_id`); autopilot types ⇒ `/[workspace]/inbox/[id]`; each must equal what `getInboxNavigationTarget` returns for the same item (parity with tapping the inbox row). An unknown `type` without `issue_id` ⇒ `/[workspace]/inbox`. Chat ⇒ `/[workspace]/chat` with `chatSessionId`. A payload for workspace `b` routes with `workspace: "b"` regardless of the current workspace.
- [ ] **Step 3: Run** `pnpm vitest run lib/push-routing.test.ts` → the gaps fail.
- [ ] **Step 4: Fix `pushTarget`** to satisfy them (delegate to `getInboxNavigationTarget` where it already encodes the rule, instead of a second copy). If a server push lacks a field routing needs (e.g. `workspace_slug` for some kind), add it in the dispatcher with a Go test in `server/internal/push/dispatcher_test.go`.
- [ ] **Step 5: Cross-workspace check**: read `app/(app)/[workspace]/_layout.tsx`; confirm navigating to another workspace's route makes it current (as the in-app workspace switcher does). If not, route through the same switch call the switcher uses, with a test on the helper that decides it.
- [ ] **Step 6: Run** mobile tests, typecheck, lint (+ `cd server && go test ./internal/push/` if touched) → PASS. **Commit** `fix(mobile): route every push kind to its screen (contango)`.

### Task 3: Universal links open the app on the right screen

**Files:**
- Create: `apps/mobile/lib/universal-links.ts`, `apps/mobile/lib/universal-links.test.ts`, `apps/mobile/app/+native-intent.tsx`, `apps/mobile/scripts/print-aasa.mjs`
- Modify: `apps/mobile/app.config.ts` (`ios.associatedDomains`), `apps/mobile/app.config.test.ts`

**Interfaces:**
- Produces: `mobilePathForWebPath(pathWithQuery: string): string`; `AASA_PATHS: string[]` (exported from `universal-links.ts`, used by the script).

- [ ] **Step 1: Failing tests** for `mobilePathForWebPath` (web routes are in `apps/web/app/[workspaceSlug]/(dashboard)/`; mobile routes in `apps/mobile/app/(app)/[workspace]/`):
  - `/acme/issues/MUL-1` → `/acme/issue/MUL-1`; `/acme/issues/MUL-1#comment-c1` → `/acme/issue/MUL-1?highlight=c1` if the web uses that anchor (check), else drop the hash.
  - `/acme/inbox` → `/acme/inbox`; `/acme/inbox?issue=MUL-1` → `/acme/issue/MUL-1`.
  - `/acme/chat` → `/acme/chat`; `/acme/projects/p1` → `/acme/project/p1`; `/acme/my-issues` → `/acme/my-issues`.
  - Unmapped workspace path `/acme/usage` → `/acme/inbox`. Non-workspace paths (`/`, `/login`, `/desktop/x`, `/api/x`) → `/`.
  - App-scheme paths already in mobile form (`/acme/issue/MUL-1`) pass through unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the mapper; `AASA_PATHS` lists the web path patterns the mapper handles (`/*/issues/*`, `/*/inbox`, `/*/inbox?*`… use Apple's `components` format) and excludes `/desktop/*`, `/api/*`, `/login`.
- [ ] **Step 4: `app/+native-intent.tsx`**: export `redirectSystemPath({ path })` returning `mobilePathForWebPath` of the incoming path for `https` links (leave `multica://` paths unchanged). Review Focus 3: confirm with the existing auth gate (`app/index.tsx`, `(auth)` layout) that a logged-out start keeps the target after login; if the gate drops it, store the pending path and replay it after login, with a test on the helper.
- [ ] **Step 5: Config**: `ios.associatedDomains: process.env.EXPO_ASSOCIATED_DOMAIN ? [\`applinks:${process.env.EXPO_ASSOCIATED_DOMAIN}\`] : []` for the production variant only; test in `app.config.test.ts` (set → present; unset → empty).
- [ ] **Step 6: `scripts/print-aasa.mjs`**: reads `EXPO_APPLE_TEAM_ID` and `EXPO_BUNDLE_IDENTIFIER_PROD` and prints the `apple-app-site-association` JSON (`applinks.details[].appIDs = ["<team>.<bundle>"]`, `components` from `AASA_PATHS`). Run it with example values to show output.
- [ ] **Step 7: Run** tests/typecheck/lint → PASS. **Commit** `feat(mobile): open our server's links in the app (contango)`.

### Task 4: OTA updates that offer a restart

**Files:**
- Create: `apps/mobile/lib/ota-update.ts`, `apps/mobile/lib/ota-update.test.ts`, `apps/mobile/lib/use-ota-update-prompt.ts`
- Modify: `apps/mobile/package.json` (via `pnpm exec expo install expo-updates`), `apps/mobile/app.config.ts` (`updates`, `runtimeVersion`), `apps/mobile/app/_layout.tsx` (mount the hook), `apps/mobile/locales/*` (strings, per the app's i18n pattern)

**Interfaces:**
- Produces: `checkAndPromptForUpdate(deps: { isEnabled: boolean; check(): Promise<{ isAvailable: boolean }>; fetch(): Promise<{ isNew: boolean }>; prompt(onRestart: () => void): void; reload(): Promise<void>; log(msg: string, err?: unknown): void }): Promise<void>`; `useOtaUpdatePrompt(): void`.

- [ ] **Step 1: Failing tests** (`ota-update.test.ts`, node env, fake deps): disabled ⇒ nothing called; not available ⇒ no fetch, no prompt; available + fetched new ⇒ `prompt` called once; prompt's restart callback ⇒ `reload`; prompt dismissed (callback not invoked) ⇒ no `reload` (Review Focus 5); `check` throws ⇒ `log` called, no throw.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `checkAndPromptForUpdate`; `useOtaUpdatePrompt` calls it on mount and on `AppState` `"active"` (at most once per 30 min), with `Updates.isEnabled`, `Updates.checkForUpdateAsync`, `Updates.fetchUpdateAsync`, `Updates.reloadAsync`, and `prompt` = `Alert.alert(title, message, [{ text: later, style: "cancel" }, { text: restart, onPress }])`. Copy: title "Update ready", message "Restart Multica to use the latest version.", buttons "Later" / "Restart" (follow the app's i18n and copy rules).
- [ ] **Step 4: Config**: `runtimeVersion: { policy: "fingerprint" }`; `updates: { url: "https://u.expo.dev/<projectId>" , checkAutomatically: "ON_LOAD" }` with the project id read from `extra.eas.projectId` (filled in Task 6; until then leave updates disabled when the id is absent so local builds work). Test in `app.config.test.ts`.
- [ ] **Step 5: Run** tests/typecheck/lint → PASS. **Commit** `feat(mobile): OTA updates with a restart prompt (contango)`.

### Task 5: Native project rebuilds without hand edits; EAS config

**Files:**
- Create: `apps/mobile/eas.json`; config plugins under `apps/mobile/plugins/` only for fixes proven still needed
- Modify: `apps/mobile/app.config.ts` (register plugins), `apps/mobile/README.md` (EAS build section)

- [ ] **Step 1: Prove what SDK 57 still needs.** `APP_ENV=production pnpm exec expo prebuild --clean --platform ios`, then an unsigned Release build: `xcodebuild -workspace ios/Multica.xcworkspace -scheme Multica -configuration Release -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO build`. For each old fix (pod deployment-target floor, app min iOS 16, `ENABLE_USER_SCRIPT_SANDBOXING = NO` for Archive, SceneDelegate/UIScene — note `app.config.ts` already enables scene support), record needed / not needed with the evidence (error text or clean build). Also run `xcodebuild … archive -archivePath /tmp/multica.xcarchive CODE_SIGNING_ALLOWED=NO` for the Archive-only issue.
- [ ] **Step 2: Encode** each still-needed fix as a config plugin (or `expo-build-properties` option) with a short comment naming the error it prevents; re-run Step 1 from a clean prebuild → build and archive succeed with no manual edits.
- [ ] **Step 3: `eas.json`**: `build.production` = `{ "distribution": "store", "channel": "production", "autoIncrement": true, "env": { "APP_ENV": "production" }, "ios": { "image": <latest image with an Xcode App Store Connect accepts; pin it> } }`; `submit.production.ios` reads the App Store Connect app id from the EAS environment (no committed ids). `cli.appVersionSource: "remote"`.
- [ ] **Step 4: Validate** `pnpm exec eas config --platform ios --profile production` (works without login? if not, note it for Task 6) and `pnpm vitest run app.config.test.ts`. **Commit** `build(mobile): reproducible iOS project and EAS config (contango)`.

### Task 6: Owner checklist, ops instructions and release docs

**Files:**
- Create: `docs/contango/ios-release.md`
- Modify: `docs/contango/PATCHES.md` (new entry for the iOS foundation)

- [ ] **Step 1: Write `ios-release.md`** (placeholders only): (a) owner/Apple: App Store Connect API key (Admin or Account Holder) for EAS Submit, Associated Domains capability on the app id; (b) Expo: owner gets access to Contango's Expo org, runs `pnpm exec eas init` in `apps/mobile` (commits the project id), sets EAS `production` environment variables (list every name from Global Constraints, values from `.env.production.local`), `eas credentials` to create the distribution certificate/profile; (c) admin-box agent prompt: public Cloudflare tunnel route for `<server host>` serving only `/.well-known/apple-app-site-association` (content from `node apps/mobile/scripts/print-aasa.mjs`, `Content-Type: application/json`, no redirect), everything else 404 publicly, VPN DNS unchanged, verify with `curl https://app-site-association.cdn-apple.com/a/v1/<server host>`; (d) release: `eas build -p ios --profile production --auto-submit`; OTA: `eas update --channel production --message "<what>"`; rollback: `eas update:republish` / `eas update:rollback`.
- [ ] **Step 2: PATCHES.md** entry (files ours vs upstream, drop-when). **Commit** `docs(contango): iOS release runbook (contango)`.

### Task 7: First EAS build, TestFlight, end-to-end check (owner + controller, manual)

- [ ] Owner completes Task 6 (a)–(c); admin-box agent confirms the association file through Apple's CDN URL.
- [ ] `eas build -p ios --profile production --auto-submit`; owner installs from TestFlight.
- [ ] Checks (record pass/fail): (1) server shows a `production` push_device row for the owner's iPhone; (2) inbox push and chat-reply push arrive; taps open the issue / chat, including cold start and a push for another workspace; (3) an issue link tapped in Slack and in the GitHub app opens that issue in the app (also while logged out → after login); (4) publish a visible JS-only change with `eas update --channel production`; the app shows "Update ready", Restart shows the change, Later keeps the user in place and the change appears on next launch; (5) `expo prebuild --clean` + EAS build used no hand edits.
- [ ] Failures go back to the owning task as fixes; then push the branch and fast-forward `contango/main` with the owner's OK.
