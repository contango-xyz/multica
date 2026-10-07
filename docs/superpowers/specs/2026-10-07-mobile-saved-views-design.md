# Mobile saved views — design

Status: approved in conversation 2026-10-07, pending written-spec review.
Branch: `contango/mobile-saved-views` (fork `contango-xyz/multica`, based on v0.6.1 `2ea01ae4`).

## Goal

Show the workspace's saved issue views — the same tabs the web Issues page shows — in the iOS app, so a
view like "Needs me" (custom property *Responsible human* = me AND *Needs human* = yes) is one tap away
on the phone and returns exactly the issues web returns.

Success: on a real device against a real server, every saved view lists the same issues (same set, same
total) as the same view on web.

## User-facing behaviour

- The bottom tab "My issues" becomes **"Issues"**. The separate *Issues* entry under *More* is removed.
- The top of the Issues screen is a horizontally scrolling chip row: **All**, then the saved views of the
  workspace Issues page (`scope_type=workspace`): the user's own plus workspace-shared ones, in the
  user's web order, minus views hidden on web. Web's other built-ins (Members, Agents) are not shown.
  **All** is always present and cannot be hidden.
- The selected chip is remembered per workspace on the device (secure-store/local persistence, same
  mechanism as existing mobile view stores). If the remembered view no longer exists, fall back to All.
- The list stays the current status-grouped SectionList with the existing issue rows, loading more pages
  on scroll. Saved views apply their saved filters, actor-kind restriction (members/agents), sort and
  show-sub-issues setting. Board/table/swimlane/gantt layouts are rendered as this list.
- The existing status/priority filter sheet still works and narrows whatever chip is selected.
- Read-only: no creating, editing, reordering or hiding views on mobile. Pull-to-refresh and app
  foreground reload the views and preferences.
- The Assigned / Created / Agents scope switcher is removed. ("Assigned to me" can be saved as a view on
  web.)

## Data flow

1. **Views + order.** `GET /api/issue-views?scope_type=workspace` (bare array, own + shared, created_at
   ASC) and `GET /api/issue-view-preferences?scope_type=workspace` (`{hidden:[], order:[]}` of bar item
   ids `builtin:<key>` / `view:<uuid>`). Compose the chip row with core's `applyViewBarPrefs`, anchor
   `builtin:all`; then drop the other `builtin:*` items.
2. **View → query.** Sanitise `view.query` with core's `baselineFromQuery`, then a mobile pure function
   builds an `IssueTableQuerySpec`:
   - scope `{kind:"workspace"}` plus `assignee_types` from `assigneeTypesForActorKind(view.scope_variant)`
     (core: members → `["member"]`, agents → `["agent","squad"]`);
   - filters mapped 1:1 like web's surface controller: statuses, priorities, assignees,
     include_no_assignee, creators, project_ids, include_no_project, project_statuses, label_ids,
     properties; `include_sub_issues` from `view.display.showSubIssues` (default `true`);
   - sort from `view.display.sortBy/sortDirection` (default `created_at`/`desc`, the web view-store
     defaults).
   **All** = workspace scope, no filters, default sort, sub-issues shown.
3. **Overlay.** The mobile status/priority filter is intersected with the view's lists per dimension:
   view list empty → use the overlay; overlay empty → use the view list; both set → intersection; an
   empty intersection shows an empty list (never widens).
4. **Rows.** `POST /api/issues/table/rows` with `group:{kind:"none"}`, `group_key:null`,
   `hierarchy:{enabled:false}`, `parent_id:null`, page size 100, `next_cursor` paging via an infinite
   query. Rows are grouped by status client-side with the existing `lib/group-issues-by-status.ts`.
5. **Freshness.** Issue realtime events (created/updated/deleted) invalidate the rows query, throttled,
   following existing mobile realtime patterns. Views/preferences refetch on pull-to-refresh and on
   foreground (existing AppState focus handling).

## Code changes

**Shared core (no behaviour change for web/desktop)**
- Move the pure `applyViewBarPrefs`, `ViewBarPrefs` type and `EMPTY_VIEW_BAR_PREFS` out of
  `packages/core/issue-views/preferences.ts` (which imports the web API client and React Query) into a
  dependency-free module; `preferences.ts` re-exports them so existing imports keep working.
- Mobile may then import `applyViewBarPrefs`, `baselineFromQuery` (`issue-views/baseline.ts`, pure) and
  `assigneeTypesForActorKind` (`issues/surface/scope.ts`, pure). Verify each import chain stays free of
  React/DOM/api/store runtime imports.

**Mobile (`apps/mobile`)**
- `data/api.ts`: `listIssueViews(scope)`, `getIssueViewPreference(scope)`, `listIssueTableRows(req)`
  (POST via `fetchValidatedWith`), each validated with zod + `parseWithFallback` and malformed-response
  fallbacks. Reuse compatible pure zod schemas from core where they exist.
- `data/queries/issue-views.ts`: key factories (`wsId`-scoped) + query/infinite-query options.
- `lib/view-table-query.ts`: pure view/All + overlay → `IssueTableQuerySpec`.
- Issues tab screen: replaces `(tabs)/my-issues.tsx` content with chip row + list; tab renamed;
  `more/issues.tsx` entry removed from the More menu.
- Selected-chip persistence per workspace.
- i18n strings in every mobile locale (en, zh-Hans).

**Bug fixes found during design**
- `data/api.ts` `listIssues` serialises object params with `String(v)` → `[object Object]`; serialise
  objects with `JSON.stringify` (as web's client does).
- `data/schemas.ts` pins schema coerces unknown `item_type` to `"issue"`, so a web view pin renders as a
  broken issue row in *More → Pins*. Accept `"view"`; tapping a view pin opens the Issues tab with that
  view selected.

## Error handling

- Views or preferences request fails → chip row shows **All** only; list still works.
- A view whose `query` fails to sanitise or references unknown properties → `baselineFromQuery` drops
  invalid parts (same as web). If the server still rejects the rows request (4xx), that chip shows the
  existing list error state with retry; other chips are unaffected.
- Remembered chip id not in the list → All.

## Testing

- Vitest (`apps/mobile`): view → spec mapping (property filters incl. operator objects, actor kinds,
  sort defaults, sub-issues), overlay intersection rules incl. empty intersection, chip composition
  (order, hidden, anchor, unknown ids), `listIssues` param serialisation, pin schema `view`.
- `pnpm --filter @multica/mobile typecheck`, `lint`, `test`; root `pnpm typecheck` + core tests for the
  preferences refactor.
- Device check: Release build on a physical iPhone against the real server; for "Needs me" and at least
  one other view, compare issue set and total with web.

## Out of scope

Creating/editing/reordering views on mobile; board/table/swimlane/gantt layouts; project-page and
"My issues"-page views; web's Members/Agents built-ins; moving the local iOS 27 native fixes (scene
lifecycle, deployment target, script sandboxing) into a config plugin — a separate follow-up.
