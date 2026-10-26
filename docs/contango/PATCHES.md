# Contango patches on upstream multica

Every change our fork carries on top of upstream `multica-ai/multica`, one entry per patch.
Read this before each rebase onto a new upstream tag: for every entry, check the upstream release
notes for the same fix and drop the patch when its "Drop when" holds.

**Base:** upstream `v0.7.0` (rebased 2026-10-23 from `v0.6.1` via `v0.6.5`). Branch `contango/main`.

Commits are named by subject, not hash: hashes change on every rebase. Find one with
`git log --oneline v0.7.0..contango/main --grep '<subject words>'`.

## Rules

- Every fork commit's subject ends in `(contango)`, so `git log --grep '(contango)'` lists them.
  Patches 1–6 predate the rule and are matched by subject below.
- A new patch gets an entry here in the same PR.
- Fork migrations keep their own filenames. Migration versions are the whole filename stem
  (`564_push_device`), so ours can share a number with upstream's. A fork migration that has run in
  production can never be dropped, only followed by a new migration.

## Rebase checklist

1. `git fetch upstream --tags`, read the release notes since the base above.
2. Go through each entry below: is it fixed or replaced upstream? Drop it, or note the overlap.
3. `git rebase <tag>` on a new `contango/rebase-<tag>` branch; record the conflicts in "Last rebase".
4. Lockfile: resolve with upstream's, then regenerate under the 4-day release age. Put
   `minimumReleaseAge: 5760` (and, only for packages upstream itself pinned and we don't ship, a
   `minimumReleaseAgeExclude` list) in `pnpm-workspace.yaml` temporarily — list settings don't work as
   `--config` flags — run `pnpm install --lockfile-only`, revert the yaml, and check that
   `pnpm install --frozen-lockfile` passes. Stop the rebase if pnpm errors; don't commit upstream's
   lockfile as-is, it lacks our mobile packages.
5. `go test ./...` against a scratch Postgres — a clean rebase can still break our tests; also migrate a DB at the old `contango/main` schema up
   to the new one (the production path).
6. Update **Base** and "Last rebase" here.

## Patches

### 1. iOS push notifications (server + mobile)

- **What:** native APNs push for inbox items and chat replies. `push_device` table,
  `POST/DELETE /api/push/devices`, APNs token-auth client, dispatcher that follows the desktop
  notification preferences; skips devices silent for 30 days and IM-channel chats. Mobile registers,
  routes taps (once per tap across workspace switches), syncs the badge. Inert unless
  `MULTICA_APNS_*` is set.
- **Commits:** `docs: design for iOS push notifications …` through
  `fix(mobile): handle each notification tap once across workspace switches` (14 commits), and
  `feat(server): richer push text — ticket id + what happened, issue title as subtitle` (CTG-823).
- **Touches:** `server/internal/push/*` (ours), `server/cmd/server/{main,router}.go`,
  `server/internal/handler/handler.go`, `server/pkg/db/queries/push_device.sql`, `apps/mobile/*`,
  `apps/mobile/package.json` (`expo-application`, `expo-notifications`), `pnpm-lock.yaml`.
- **Migrations:** `564_push_device`, `565_push_device_token_index`, `566_push_device_user_index`
  (applied in production 2026-10-07; permanent). Upstream also uses 564–566, so
  `server/internal/migrations/migrations_lint_test.go` exempts these three stems from
  `TestMigrationNumericPrefixesAreUnique` (commit `test(migrations): exempt the fork's push_device
  migrations from the unique-prefix lint (contango)`). Number new fork migrations after upstream's
  highest to avoid adding to that list.
- **Also carries:** `.github/workflows/contango-backend-image.yml` (builds
  `ghcr.io/contango-xyz/multica-backend:<sha7>` on every `contango/**` push) and
  `docs/contango/push-rollout.md`.
- **Upstream status:** none as of v0.7.0 (no APNs or device push).
- **Drop when:** upstream ships mobile push. Then migrate our `push_device` rows or drop the table
  in a new migration.

### 2. Saved issue views on mobile

- **What:** the mobile Issues tab shows "All" plus the workspace's saved views (web order, server-side
  filters via `POST /api/issues/table/rows`), collapsible status sections remembered per view; view
  pins open the Issues tab; More→Issues retired.
- **Commits:** `docs(mobile): design for showing saved issue views on mobile` through
  `feat(mobile): collapsible status sections on the Issues tab, remembered per view` (13 commits),
  including `refactor(core): move pure view-bar prefs into a client-free module`.
- **Touches:** `apps/mobile/app/(app)/[workspace]/(tabs)/my-issues.tsx` (rewritten),
  `apps/mobile/data/*`, `packages/core` view-bar prefs.
- **Upstream status:** none as of v0.7.0.
- **Drop when:** upstream mobile shows saved views.

### 3. Mobile export-compliance declaration

- **What:** `ITSAppUsesNonExemptEncryption = false`, so each TestFlight build skips the export
  compliance question.
- **Commit:** `chore(mobile): declare exempt-only encryption (skip per-build export compliance)`.
- **Upstream status:** none. **Drop when:** upstream declares it in `app.config.ts`.

### 4. An agent's answer to a human who named it does not wake the squad leader (CTG-839)

- **What:** an untagged agent reply under a live human comment that mentions that agent no longer
  falls back to waking the assigned squad's leader. Narrow on purpose: worker→leader replies under a
  comment that did not name the worker still wake the leader.
- **Commits:** `fix(server): an agent's untagged answer to a human who named it does not wake the
  squad leader`; refined by `fix(server): an agent's reply to a bot member's post still wakes the
  squad leader (contango)` — members in `MULTICA_BOT_USER_IDS` (comma-separated UUIDs, e.g.
  multica-bot posting pr-watch prompts) count as automation, not people.
- **Touches:** `server/internal/handler/comment.go`, `contango_bot_members.go`,
  `contango_agent_reply_to_member_test.go`.
- **Config:** `MULTICA_BOT_USER_IDS` in the backend env on ops.
- **Upstream status:** upstream did not touch `comment.go` in v0.6.2–v0.7.0.
- **Drop when:** upstream stops the squad-leader fallback for replies to a human who addressed the
  agent, and has a notion of bot members.

### 5. @mentions in a completion-fallback comment start their targets (CTG-281)

- **What:** when a run posts nothing itself, completion posts its final output as a comment. That
  comment skipped the create-time trigger path, so its @agent / @squad mentions woke nobody (22 of 35
  such handoffs in 14 days). `TaskService.FallbackCommentPosted` now dispatches them with the same
  guards as a posted comment. An untagged final message still starts nobody.
- **Commit:** `fix(server): explicit @mentions in a run's completion-fallback comment start their
  targets`.
- **Touches:** `server/internal/handler/daemon.go`, `handler.go` (wiring line next to
  `taskSvc.PRSnapshotsEnabled`), `server/internal/service/task.go` (`TaskService` field).
- **Upstream status:** not fixed as of v0.7.0 (conflicted with upstream's `PRSnapshotsEnabled`
  addition only).
- **Drop when:** upstream's fallback comment goes through the mention trigger path.

### 6. PR review and comment webhooks refresh the PR snapshot

- **What:** `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` and
  `issue_comment` on a PR enqueue the same snapshot refresh as CI events. That bumps the PR row's
  `updated_at`, which our pr-watch uses to see approvals and comments within a minute.
- **Commit:** `feat(server): review and PR-comment webhooks trigger the PR snapshot refresh
  (contango)`.
- **Touches:** `server/internal/handler/github.go`. Needs those events enabled on the GitHub App.
- **Upstream status:** v0.6.4 rewrote snapshot fetching (#9332, no Contents permission needed) but
  still ignores review/comment events.
- **Drop when:** upstream refreshes on review events.

### 7. Refuse a wakeup that waits for the run creating it

- **What:** wakeup capture ignores the registering run's own events, so an event wakeup filtered on
  that run could only fire at expiry (all 12 such wakeups in two weeks fired at the 6h timeout). It
  is now rejected with `ErrWakeupInput` and a reason.
- **Commit:** `fix(server): refuse a wakeup that waits for the run creating it (contango)`.
- **Touches:** `server/internal/service/issue_wakeup.go`.
- **Upstream status:** v0.6.2–v0.7.0 wakeup fixes (#9066, #9069, #9202, #9039) don't cover it.
- **Drop when:** upstream rejects it, or lets a run's own completion satisfy the wakeup.

### 8. A Codex preamble before tool calls is not the run's output

- **What:** on the v2 item protocol, a turn that narrates ("I'll check …"), runs tools and ends
  without a `final_answer` reported the preamble as `Result.Output`. Commentary-phase messages no
  longer feed the fallback, and a tool item started after the last message clears it
  (`onToolActivity`). Legacy `agent_message` protocol unchanged.
- **Commit:** `fix(agent): a Codex preamble before tool calls is not the run's output (contango)`.
- **Touches:** `server/pkg/agent/codex.go` (`codexClient` fields, item/started and agent message
  handlers). Daemon code, so it ships in the fork CLI, not the backend image.
- **Upstream status:** not fixed. v0.6.2's #9020 (`excludeTurns` on resume) and #8934 (Guardian 429
  circuit) are separate fixes in the same file.
- **Drop when:** upstream's Result.Output fallback ignores commentary / pre-tool messages.

### 9. Issue dependencies ("blocked by")

- **What:** "issue X is blocked by issue Y" as data, so the board and its automation can rank the
  critical path instead of reading blockers out of comment prose (owner, 2026-10-25). One edge per
  pair in the existing `issue_dependency` table, always `type = 'blocked_by'`; "blocks" is the same
  edge read from the other side. API: `GET/POST /api/issues/{id}/dependencies` (body
  `{"blocked_by": "<uuid or CTG-N>"}`) and `DELETE /api/issues/{id}/dependencies/{blockerId}`.
  Both issues must be in the workspace; self-edges are 400 and cycles 409. Add and remove are
  idempotent, bump the issue revision and write a `dependency_added` / `dependency_removed`
  activity. `GET /api/issues/{id}` and `GET /api/issues` carry `blocked_by` and `blocks`
  (`id, identifier, number, title, status`). CLI: `multica issue dependency list|add|remove
  <issue> [--blocked-by <issue>]`. Web UI: patch 10.
- **Commit:** `feat(server): issue dependencies — blocked-by API, CLI and issue fields (contango)`.
- **Touches:** `server/pkg/db/queries/issue_dependency.sql` (ours) and its generated code,
  `server/internal/handler/contango_issue_dependency{,_test}.go` (ours),
  `server/internal/handler/issue.go` (`IssueResponse` fields, `GetIssue`, `ListIssues`),
  `server/cmd/server/router.go`, `server/cmd/multica/cmd_issue_dependency{,_test}.go` (ours),
  `server/cmd/migrate/main.go` (cleanup entry).
- **Migrations:** `593_issue_dependency_edge_unique` (unique index on
  `(issue_id, depends_on_issue_id, type)`, concurrent). The table and its cascading foreign keys
  come from upstream's `001_init`, so deleting an issue removes its edges.
- **Upstream status:** none as of v0.7.0: the table has existed since `001_init` with no queries,
  API or CLI.
- **Drop when:** upstream ships issue relations; migrate the edges to its model first.

### 10. Issue dependencies in the web app, and the dependency graph

- **What:** the web UI for patch 9 (owner, 2026-10-25: "a chart/graph, and a ref on each card").
  The issue sidebar shows "Blocked by" and "Blocks" sections (status icon, identifier, title,
  link), each hidden while empty. Board cards and list rows show "Blocked by N" / "Blocks N" pills
  counting open issues only, with the identifiers in a native tooltip. A workspace page
  `/{slug}/dependencies` (sidebar, under Projects) draws every open issue on a blocked-by edge as a
  layered left-to-right graph, blockers on the left, coloured by status, with the "Critical path"
  number property as a badge and nodes at 3 or more outlined; filters hide done/cancelled (on by
  default) and show only the critical path. Read-only: edges are still edited with the CLI/API.
  Server: `GET /api/issues/dependency-graph` returns `{nodes, edges}` in one call (nodes carry
  `critical_path`, read from the workspace property named "Critical path"; edges are
  `{from: blocker, to: blocked}`). Fork CI builds `ghcr.io/contango-xyz/multica-web`. Web only:
  the desktop router has no `dependencies` route, so the shared sidebar entry has no desktop page.
- **Commits:** `feat(server): workspace dependency graph endpoint (contango)`, `feat(views):
  issue dependency sections, card markers and graph page (contango)`, `ci: build the web image
  from contango branches (contango)`.
- **Touches:** ours: `packages/views/issues/components/issue-dependencies{,.test}.tsx`,
  `packages/views/dependencies/`, `apps/web/app/[workspaceSlug]/(dashboard)/dependencies/`,
  `.github/workflows/contango-web-image.yml`. Upstream files: `packages/core/types/{issue,api,
  index}.ts`, `packages/core/api/{schemas,client}.ts`, `packages/core/issues/queries.ts`,
  `packages/core/paths/{paths,route-icons,tab-subject,reserved-slugs,consistency.test}.ts`,
  `packages/core/diagnostics/diagnostic-context.ts`, the workspace-paths mocks in
  `packages/views/{search,layout}/*.test.tsx`,
  `packages/views/issues/components/{issue-detail,board-card,list-row}.tsx`,
  `packages/views/layout/{app-sidebar,route-icon-components}.tsx`,
  `packages/views/search/search-command.tsx`, `packages/views/editor/utils/link-handler.ts`,
  `packages/views/package.json`, `packages/views/locales/*/{issues,layout}.json`,
  `apps/web/proxy.ts`, `server/internal/handler/reserved_slugs.json`, plus the server files of
  patch 9 (`issue_dependency.sql`, `contango_issue_dependency{,_test}.go`, `router.go`).
- **Migrations:** none. **Lockfile:** unchanged (the graph is hand-rolled SVG).
- **Upstream status:** none as of v0.7.0.
- **Drop when:** patch 9 is dropped, or upstream ships an issue relations UI.

### 11. Desktop build for macOS (own app id, push, update feed)

- **What:** a signed, notarized arm64 desktop app with its own app id, APNs push (registration after
  login, click routing, one banner per event), our server's web links opening in the app, and a
  generic update feed on our server, and a per-browser web setting that hands workspace links to the
  app (`multica://open?path=`). Server accepts macOS push devices. Build and release steps:
  `docs/contango/desktop-release.md`.
- **Commits:** `feat(server): accept macOS push devices` through `chore(desktop): fork release
  publish script`; web link handoff: `feat(desktop): open multica://open?path= links in the app
  (contango)` through `docs(contango): web link handoff`; native click reporting: `build(desktop):
  native push-click addon for fork builds (contango)` and the `fix(desktop)` commits after it.
- **Touches:** ours: `apps/desktop/scripts/contango-{build,publish}*`,
  `apps/desktop/build/entitlements.contango.template.plist`,
  `apps/web/platform/desktop-handoff.ts`,
  `apps/web/components/{desktop-handoff,open-in-desktop-setting}.tsx`,
  `apps/desktop/native/push-click/**` (N-API addon reporting APNs notification clicks),
  `apps/desktop/src/main/push-click{,.test}.ts`, `apps/desktop/scripts/push-click-smoke.mjs`.
  Upstream files: desktop main process (push registration, link handling, `web-link.ts`, push-click
  wiring in `src/main/index.ts`), `apps/desktop/package.json` (`node-gyp` devDependency, used only by
  the fork build), `apps/desktop/electron-builder.yml` (`!native/**` in `files`), web handoff wiring
  (`apps/web/app/[workspaceSlug]/{layout,(dashboard)/settings/page}.tsx`, `packages/views/locales/*/settings.json` `desktop.open_in_app`),
  `packages/core` (push device API, `beforeLogout` hook),
  `server/internal/handler` push-device handlers.
- **Migrations:** `594_push_device_platform_macos` (adds `macos` to the platform check).
  **Lockfile:** `node-gyp` for `apps/desktop` (`apps/desktop/package.json` also gains the
  `contango:build` script).
- **Migration numbering:** upstream `main` (after v0.7.0) has `593_runtime_profile_add_devin`,
  which shares 593 with patch 9's `593_issue_dependency_edge_unique`. The runner keys
  `schema_migrations` by the whole filename stem, so both apply, but
  `TestMigrationNumericPrefixesAreUnique` will fail on the next rebase. Resolution then: keep our
  filename (it may have run in production) and add `593_issue_dependency_edge_unique` to
  `contangoMigrationStems` in `server/internal/migrations/migrations_lint_test.go`; do the same for
  `594_push_device_platform_macos` once upstream claims 594.
- **Upstream status:** none as of v0.7.0.
- **Drop when:** upstream ships desktop push and a first-party macOS distribution.

### 12. iOS app foundation (EAS builds, OTA, universal links, push routing)

- **What:** reproducible iOS builds on EAS for TestFlight (pinned Xcode 27 image, remote build
  numbers, `production` environment), OTA updates with a restart prompt, universal links into the app
  from our server's web links, APNs registration that survives permission changes and token rotation,
  and push/link routing to the linked screen. Release steps: `docs/contango/ios-release.md`.
- **Commits:** `fix(mobile): register TestFlight builds for production push and refresh daily
  (contango)` through `build(mobile): pin node and pnpm for EAS builds (contango)`.
- **Touches:** ours: `docs/contango/ios-release.md`, `apps/mobile/eas.json`,
  `apps/mobile/scripts/print-aasa.mjs`, `apps/mobile/lib/{universal-links,push-environment,ota-update}*`,
  `apps/mobile/lib/use-ota-update-prompt.ts`, `apps/mobile/app/+native-intent.tsx`,
  `apps/mobile/data/auth-store.test.ts`. Upstream files: `apps/mobile/app.config.ts` (associated
  domains, EAS updates, production project id and upstream-URL guard) and its test,
  `apps/mobile/README.md` (EAS section), `apps/mobile/app/_layout.tsx`,
  `apps/mobile/app/(app)/_layout.tsx`, `apps/mobile/app/(auth)/verify.tsx`,
  `apps/mobile/app/(app)/[workspace]/(tabs)/chat.tsx`, `apps/mobile/data/auth-store.ts`,
  `apps/mobile/data/push-registration*`, `apps/mobile/lib/{push-routing*,use-push-notifications.ts}`,
  `apps/mobile/locales/*/common.json`, `apps/mobile/package.json` (`expo-updates`),
  `packages/core/package.json` (`./paths/reserved-slugs` export).
- **Migrations:** none. **Lockfile:** `expo-updates` for `apps/mobile`.
- **Config outside the repo:** EAS `production` environment variables (see the runbook); the public
  Cloudflare route for the association file. `ascAppId` (in `eas.json`) and the production EAS
  project id (`EAS_PROJECT_ID_PROD` in `app.config.ts`) live in the repo.
- **Upstream status:** none as of v0.7.0.
- **Drop when:** upstream ships its own iOS distribution with universal links and OTA, and we move to it.

## Last rebase

**2026-10-23, v0.6.5 → v0.7.0** (branch `contango/rebase-v0.7.0`). Only `pnpm-lock.yaml`
conflicted. Upstream pins `electron 44.9.3` (desktop, which we don't ship), under 4 days old at the
time, so it was the one exclusion from the release-age gate. The rebase was clean but broke patch 5's
test: upstream's runtime-ownership check on daemon routes (MUL-8154) 404s a daemon token without an
owner, so the test now uses `newOwnerDaemonRequest` like upstream's own tests.

**2026-10-22, v0.6.1 → v0.6.5** (branch `contango/rebase-v0.6.5`). Conflicts:

- `my-issues.tsx` (patch 2): Expo SDK 57 moved `useIsFocused` to `expo-router`; kept ours with
  their import.
- `apps/mobile/package.json` + `pnpm-lock.yaml` (patch 1): bumped `expo-application` to `~57.0.3`
  and `expo-notifications` to `~57.0.23` (57.0.24 was under the 4-day release age).
- `handler.go`, `task.go` (patch 5): both sides added a line/field; kept both.
- `codex.go` (patch 8): both sides added `codexClient` fields; kept both.
