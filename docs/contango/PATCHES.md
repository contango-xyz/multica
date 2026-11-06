# Contango patches on upstream multica

Every change our fork carries on top of upstream `multica-ai/multica`, one entry per patch.
Read this before each rebase onto a new upstream tag: for every entry, check the upstream release
notes for the same fix and drop the patch when its "Drop when" holds.

**Base:** upstream `v0.8.1` (rebased 2026-11-06 from `v0.7.0`). Branch `contango/main`.

Commits are named by subject, not hash: hashes change on every rebase. Find one with
`git log --oneline v0.8.1..contango/main --grep '<subject words>'`.

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
  highest (616 at v0.8.1) to avoid adding to that list.
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
- **Upstream status:** half fixed in v0.7.2 by MUL-8240 (#9521, `codexOutputSelection`): a message
  labelled with any phase other than `final_answer` (e.g. `commentary`) no longer becomes the output.
  Since the v0.8.1 rebase our patch is only the other half: `onToolActivity` →
  `codexOutputSelection.observeToolActivity()` forgets an unlabelled preamble once a tool item starts
  after it.
- **Drop when:** upstream's fallback also ignores an unlabelled message followed by tool activity.

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
  `/{slug}/dependencies` (a row at the bottom of the Work panel) draws every open issue on a blocked-by edge as a
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
  `packages/views/layout/route-icon-components.tsx`, `packages/views/layout/panels/work-panel.tsx`
  (the Dependencies row; upstream's rail replaced `app-sidebar.tsx` in v0.8.0),
  `packages/core/paths/spaces.ts` (`dependencies` belongs to the Work space),
  `packages/views/search/use-root-model.ts` (palette keywords),
  `packages/views/editor/utils/link-handler.ts`,
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
- **Migration numbering:** upstream v0.8.1 also has `593_runtime_profile_add_devin` and
  `594_agent_task_process_cleanup_index`. The runner keys `schema_migrations` by the whole filename
  stem, so both apply; `593_issue_dependency_edge_unique` and `594_push_device_platform_macos` are in
  `contangoMigrationStems` (`migrations_lint_test.go`).
- **Upstream status:** none as of v0.7.0.
- **Drop when:** upstream ships desktop push and a first-party macOS distribution.

### 12. Download page offers the fork's desktop build (opt-in)

- **What:** when the web server has `MULTICA_DESKTOP_FEED_URL` (runtime env, absolute feed base),
  `/download` offers the macOS DMG and version read from `<base>/contango-mac.yml` instead of
  upstream's GitHub release, and the Help menu's "Desktop app" link points at `/download`. Feed
  failure or unset env keeps upstream behaviour. Only bare `.dmg` file names under the base are
  accepted; the page then shows only that Mac build (no upstream links or other platforms).
  Optional `MULTICA_DESKTOP_FEED_DIR` reads the yml from a mounted copy of the feed directory
  instead of over HTTP (ops: the container cannot reach the VPN host); links stay under the URL.
- **Touches:** ours: `apps/web/features/landing/utils/desktop-feed{,.test}.ts`. Upstream files:
  `apps/web/features/landing/utils/github-release{,.test}.ts`,
  `apps/web/app/(landing)/download/download-client{,.test}.tsx`, `apps/web/app/layout.tsx`,
  `apps/web/components/web-providers.tsx`, `packages/core/config/index.ts` (`desktopDownloadUrl`),
  `packages/views/layout/help-launcher{,.test}.tsx`, `packages/views/layout/account-menu.tsx` (the
  account menu's download item, new upstream in v0.8.0).
- **Upstream status:** none as of v0.7.0.
- **Drop when:** upstream offers a configurable download source.

### 13. Daemon owner allowlist

- **What:** with `MULTICA_DAEMON_ALLOWED_EMAILS` set (comma-separated, backend env), every
  `/api/daemon/*` request whose authenticated owner isn't on the list gets 403, so only those
  accounts can register, heartbeat or claim with a runtime. People can't bring their own desktop
  daemon. Unset or empty keeps upstream behaviour. Decisions are cached per user until restart.
- **Touches:** ours: `server/internal/middleware/daemon_owner_allowlist{,_test}.go`. Upstream file:
  `server/cmd/server/router.go` (one `r.Use` in the `/api/daemon` route).
- **Upstream status:** none as of v0.7.0.
- **Drop when:** upstream can restrict who registers runtimes in a workspace.

### 14. Smart inbox: signals API and the flagged smart view

- **What:** generic "signal" inbox entries raised by an external feeder (the ops job in
  claude-sandbox), and a Smart/Classic inbox view on web. Spec and contract:
  [SMART-INBOX.md](SMART-INBOX.md). Inbox type `signal`, `details` = `{key, group, summary,
  actions, rank}`. `POST /api/inbox/signals` (upsert by workspace + recipient + key, push on
  create and on re-raise) and `POST /api/inbox/signals/resolve` (archive, no push); workspace
  owner/admin, human credentials only (PAT/JWT; agent task tokens refused). Flag:
  `MULTICA_SMART_INBOX_EMAILS` (backend env, comma-separated); recipients not on it get 204 and
  nothing is stored. `/api/me` gains `smart_inbox` for the current user; the web shows the
  smart view only with that and a `?smart-inbox=1` opt-in (remembered in localStorage,
  `?smart-inbox=0` clears it). New realtime event `inbox:updated` for silent changes.
  Per-group push preferences `signal_<group>` (default on, `fyi` off).
- **Touches:** ours: `server/internal/handler/inbox_signal{,_test}.go`,
  `server/pkg/db/queries/inbox_signal.sql` (+ generated), `packages/core/inbox/smart{,.test}.ts`,
  `packages/core/inbox/smart-filter-store{,.test}.ts`,
  `packages/views/inbox/components/{smart-inbox,smart-inbox-list,smart-dashboard,inbox-entry}{,.test}.tsx`,
  `e2e/smart-inbox{,-desktop}.spec.ts`. Upstream files: `server/cmd/server/{router,listeners}.go`,
  `server/cmd/migrate/main.go` (concurrent-index cleanup entry), `server/internal/handler/{handler,auth,notification_preference}.go`,
  `server/internal/push/{dispatcher,text}.go` (+ tests), `server/pkg/protocol/events.go`,
  `packages/core/{types/inbox,types/workspace,types/events,api/schemas}.ts`, `packages/core/package.json`
  (exports), `packages/views/inbox/components/{index.ts,inbox-page.tsx,inbox-detail-label.tsx,inbox-list-item.tsx}`
  (the last: signals render with the system sender),
  `packages/core/inbox/queries.ts` (a group shows its newest non-signal row),
  `packages/core/inbox/filter-store.ts` (`inboxRowKey`: signals key on their own id),
  `packages/core/inbox/smart-fold{,.test}.ts` (ours: one Smart row per card; since v0.8.1 the
  smart list uses upstream's shared list-column width, no wider pane of its own),
  `packages/views/inbox/components/{inbox-page,inbox-list,inbox-display}` (smart two-pane mode, row key),
  `server/pkg/db/queries/{inbox,inbox_archive}.sql` (archived group representative skips signals),
  `packages/views/locales/*/inbox.json`, `apps/mobile/components/inbox/detail-label.tsx` +
  `apps/mobile/locales/*/inbox.json` (compile-only: the new type's label), `e2e/fixtures.ts`.
- **Migrations:** `607_inbox_signal_key_index` (unique partial expression index on
  `inbox_item (workspace_id, recipient_id, details->>'key') WHERE type = 'signal' AND
  details->>'resolved_at' IS NULL`). Upstream v0.8.1 also has `607_inbox_item_section`;
  ours is in `contangoMigrationStems`.
- **Upstream status:** none.
- **Drop when:** upstream ships an external-notification API with per-entry actions; until then
  permanent (the index may have run in production).

### 15. GitHub pull request reviews are stored

- **What:** the `pull_request_review` webhook (submitted / edited / dismissed) upserts the review
  into `github_pull_request_review` on every mirrored row of its PR (one per workspace bound to the
  installation): reviewer login and type (User/Bot), state (APPROVED / CHANGES_REQUESTED /
  COMMENTED / DISMISSED), commit, submitted time. Pending reviews are not stored. A dismissal is
  final: a late or replayed delivery never revives it. The PR snapshot refresh (which every
  `pull_request` opened/synchronize/reopened event, CI event and review event already enqueues)
  also lists the PR's reviews (`GET /repos/{o}/{r}/pulls/{n}/reviews`, one extra Pull-requests read
  per refresh) and upserts them in the same head-guarded write, so PRs that had reviews before this
  patch are backfilled on their next refresh; a failed reviews call skips only the reviews. Nothing
  new in the UI or API yet.
- **Touches:** ours: `server/internal/integrations/ghsnapshot/reviews{,_db_test}.go`,
  `server/pkg/db/queries/github_review.sql` (+ generated), `server/internal/handler/github_review_test.go`.
  Upstream files: `server/internal/handler/github.go` (event switch + handler),
  `server/internal/integrations/ghsnapshot/{snapshot,refresh}.go` (+ `rest_snapshot_test.go`),
  `server/pkg/db/queries/{workspace,workspace_delete}.sql` (cleanup; the table has no FK),
  `server/internal/handler/workspace_delete_manifest_test.go`, `server/cmd/migrate/main.go`.
- **Migrations:** `608_github_pull_request_review` (table, no PK/FK like
  `github_pull_request_check_run`) and `609_github_pull_request_review_unique_index` (unique
  `(pull_request_id, github_review_id)`, CONCURRENTLY; also serves per-PR lookups). Upstream v0.8.1 also has `608_task_usage_credits`; ours is in
  `contangoMigrationStems` (upstream skipped 609). The review id is
  unique per mirrored PR row, not globally, because one installation can feed several workspaces.
- **GitHub App:** needs the **Pull request review** event (already required by patch 6) and
  **Pull requests: Read** (already granted). No new permission.
- **Upstream status:** none.
- **Drop when:** upstream mirrors reviews.

### 16. Issue origin from a comment via the CLI (`--from-comment`, `set-source`)

- **What:** agents can record where a card came from. `multica issue create --from-comment <uuid>`
  (`POST /api/issues` with `source_comment_id`) and `multica issue set-source <issue> --from-comment
  <uuid> [--force]` (`POST /api/issues/{id}/source-context`) capture upstream's source-context
  snapshot from any comment in the workspace without making the card a sub-issue. Agent callers stamp
  `origin_task_id`. See [ISSUE-ORIGIN.md](ISSUE-ORIGIN.md).
- **Touches:** ours: `server/internal/handler/issue_source_link{,_test}.go`,
  `server/internal/service/source_context_link.go`, `server/cmd/multica/cmd_issue_source_test.go`,
  `docs/contango/ISSUE-ORIGIN.md`. Upstream files: `server/internal/handler/issue.go`
  (`CreateIssueRequest.source_comment_id`, wiring in `CreateIssue`), `server/internal/service/issue.go`
  (the source lock/verify block moved verbatim into `lockAndVerifySourceContext`; new
  `IssueCreateParams.SourceContextOriginTaskID`), `server/cmd/server/router.go` (one route),
  `server/cmd/multica/cmd_issue.go` (flag + command), `cmd_issue_test.go` (test flag),
  `packages/views/issues/components/issue-detail{,.test}.tsx`: upstream assumed the source issue is
  the parent; now the badge takes the parent role only when `source_issue.id == parent_issue_id`, and
  the ordinary parent line stays otherwise.
- **Migrations:** none.
- **Upstream status:** none (upstream only captures from the UI comment-to-sub-issue flow).
- **Drop when:** upstream lets the API/CLI record a source without parenting.
- **Long threads (2026-11-03, `contango/issue-origin-2`):** the first live `set-source` on a long
  Android QA thread was refused "source context too large". The CLI paths already used upstream's
  general limits (1 MiB of snapshot text, 100 / 500 MiB of attachments, 256 comments), not the 64 KiB
  agent-prompt limit, so one of those tripped. They now fit instead of refusing
  (`service.BuildSourceContextToFit` / `ReduceSourceContextToFit` in
  `server/internal/service/source_context_fit{,_test}.go`): keep the root-to-anchor path and the
  anchor; drop off-path comments oldest first (with their replies), then empty older path comments,
  then leave out the source issue's description and attachments, then the anchor's attachments; refuse
  only when the anchor's own text is over 1 MiB. What was left out is recorded in the snapshot's new
  `truncated` field (omitted when nothing was, so existing digests are unchanged). The write-time
  check and the detail view's change detection reduce the current thread the same way, so a fitted
  capture does not read as changed. Upstream files touched further: `server/internal/service/source_context.go`
  (`Truncated` field, `FitToLimits` on the capture, rows returned with a too-large build),
  `server/internal/handler/source_context.go` (change detection for a fitted capture). The 256-comment
  limit still refuses.
- **System comments (2026-11-03, `contango/issue-origin-3`):** a source thread containing a
  `system` (or `plugin`) comment failed with 500, because the snapshot's author-name lookup only knew
  members and agents. It now never fails: `system` reads "Multica", other types "System", a missing
  member or agent "Unknown" / "Unknown Agent" (upstream file `server/internal/service/source_context.go`).
  The detail view shows a system author as unchanged rather than unavailable, and the source-link
  endpoints log the error detail on failure.

### 17. Working hours notification preference

- **What:** a per-user `work_hours` preference, `"<IANA zone>|<days>|<HH:MM-HH:MM>"` (days a range or comma
  list of Mon..Sun, hours may cross midnight, `""` clears), validated by the server and set from
  Settings > Notifications > Working hours. The ops inbox feeder (claude-sandbox `team/inbox-signals.py`)
  sends its periodic "asks waiting on you" reminders only inside it; new asks still notify at once.
  Owner 2026-11-04.
- **Touches:** ours: `server/internal/handler/work_hours{,_test}.go`,
  `packages/core/notification-preferences/work-hours{,.test}.ts`,
  `packages/views/settings/components/work-hours-setting.tsx`. Upstream files:
  `server/internal/handler/notification_preference.go` (one key in `validNotifGroups`, its own value
  check), `packages/core/types/notification-preference.ts` (`work_hours?: string`),
  `packages/core/package.json` (one export), `packages/views/settings/components/notifications-tab.tsx`
  (one section), `packages/views/locales/*/settings.json` (`notifications.work_hours`).
- **Migrations:** none (a key in the existing preferences JSON).
- **Upstream status:** none.
- **Drop when:** upstream has per-user quiet hours the feeder can read.

## Last rebase

**2026-11-06, v0.7.0 → v0.8.1** (branch `contango/rebase-v0.8.1`). Motivation: upstream's
MUL-8346 (#9652, v0.7.2) classifies Claude Code "hit your session/weekly limit" runs. No patch dropped;
patch 8 shrank (see its entry). Conflicts:

- `preferences.ts` / `packages/core/package.json` (patch 2): upstream added preference scopes and
  exports; kept them, view-bar helpers stay in our `view-bar-prefs.ts`.
- `server/cmd/migrate/main.go` (patches 1, 9, 14, 15): both sides' `concurrentIndexCleanups`.
- `codex.go` / `codex_test.go` (patch 8): ported onto upstream's `codexOutputSelection`.
- `app-sidebar.tsx` deleted upstream (v0.8.0 rail, MUL-8317), `search-command.tsx` rewritten (patch 10):
  Dependencies row moved to the Work panel, palette keywords to `use-root-model.ts`.
- `apps/desktop/src/main/index.ts` (patch 11): upstream's multi-window main process (MUL-8432); the
  cold-launch push route opens after the window session is restored; `focusMainWindow` → `focusWindow`.
- `help-launcher.tsx`, `apps/web/app/layout.tsx` (patch 12): took upstream's rail menu, kept our URL.
- `listeners.go`, `auth.go`, `inbox-page.tsx`, `inbox-list-item.tsx` (patch 14): kept upstream's
  `EventIssueUnreadChanged`, `whats_new_seen_version`, inbox-zero state and `ListColumn` layout; ours
  added back on top. Upstream removed the resizable inbox panes, so the smart list's 400px default pane
  (and its test) went; `openArchived` re-added for the smart list.
- `rest_snapshot_test.go` (patch 15): upstream's new superseded-suites test serves `/pulls/5/reviews`.
- Icons: upstream dropped `lucide-react` for `@multica/ui/icons`; our patch files import from
  `@multica/ui/icons` (`LayoutList` → `List` in the smart inbox filter button).
- Fallout fixed after the rebase: `CollectionPageHeader` lost `count`, so the dependency graph shows
  its node count in the title; upstream added `es` and `zh-Hant` locales, so our keys (patches 2, 10,
  11, 14, 17) were translated into both (views) and `zh-Hant` (mobile).
- Migration lint: `593_issue_dependency_edge_unique`, `594_push_device_platform_macos`,
  `607_inbox_signal_key_index`, `608_github_pull_request_review` exempted (upstream claimed the numbers).

Lockfile: upstream's plus our mobile push packages, regenerated under `minimumReleaseAge: 5760`. One
exclusion: the next 16.4.5 family (`next`, `@next/env`, `@next/swc-*`), published 2026-11-03
17:49–18:02Z and required by v0.8.1 for GHSA-673q-mjm6-r5xr (#9914). We ship `apps/web`, so this is
not the usual "upstream-only" exclusion: the owner waived the age for it on 2026-11-06 ("do the update
anyway"). Everything else was at least 4 days old. Migration path tested: a scratch DB at the old
`contango/main` schema migrated up through 616, and the 23 new upstream migrations went down and up
again.

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
