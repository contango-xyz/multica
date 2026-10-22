# Contango patches on upstream multica

Every change our fork carries on top of upstream `multica-ai/multica`, one entry per patch.
Read this before each rebase onto a new upstream tag: for every entry, check the upstream release
notes for the same fix and drop the patch when its "Drop when" holds.

**Base:** upstream `v0.6.5` (rebased 2026-10-22 from `v0.6.1`). Branch `contango/main`.

Commits are named by subject, not hash: hashes change on every rebase. Find one with
`git log --oneline v0.6.5..contango/main --grep '<subject words>'`.

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
4. Lockfile: resolve with upstream's, then `pnpm install --lockfile-only --config.minimumReleaseAge=5760`.
5. `go test ./...` against a scratch Postgres; also migrate a DB at the old `contango/main` schema up
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
- **Upstream status:** none as of v0.6.5 (no APNs or device push).
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
- **Upstream status:** none as of v0.6.5.
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
- **Upstream status:** upstream did not touch `comment.go` in v0.6.2–v0.6.5.
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
- **Upstream status:** not fixed as of v0.6.5 (conflicted with upstream's `PRSnapshotsEnabled`
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
- **Upstream status:** v0.6.2–v0.6.5 wakeup fixes (#9066, #9069, #9202, #9039) don't cover it.
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

## Last rebase

**2026-10-22, v0.6.1 → v0.6.5** (branch `contango/rebase-v0.6.5`). Conflicts:

- `my-issues.tsx` (patch 2): Expo SDK 57 moved `useIsFocused` to `expo-router`; kept ours with
  their import.
- `apps/mobile/package.json` + `pnpm-lock.yaml` (patch 1): bumped `expo-application` to `~57.0.3`
  and `expo-notifications` to `~57.0.23` (57.0.24 was under the 4-day release age).
- `handler.go`, `task.go` (patch 5): both sides added a line/field; kept both.
- `codex.go` (patch 8): both sides added `codexClient` fields; kept both.
