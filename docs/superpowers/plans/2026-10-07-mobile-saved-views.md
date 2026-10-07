# Mobile Saved Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mobile Issues tab shows **All** plus the workspace's saved issue views (web order, minus hidden), each returning exactly the issues web returns.

**Architecture:** Mobile fetches views + view-bar preferences, composes a chip row with core's pure `applyViewBarPrefs`, turns the selected view's opaque `query`/`display` blobs into an `IssueTableQuerySpec` with a pure mobile mapper (sanitised by core's `baselineFromQuery`), and pages `POST /api/issues/table/rows`. Rows are grouped by status client-side with the existing helper.

**Tech Stack:** Expo 55 / React Native 0.83, TanStack Query v5, zustand, zod v4, vitest (node env), `@multica/core` workspace package.

**Spec:** `docs/superpowers/specs/2026-10-07-mobile-saved-views-design.md`

## Global Constraints

- Follow `apps/mobile/AGENTS.md`: mobile imports from core only types and pure utilities/schemas; no core stores, hooks, Query factories or the core `api` client.
- UI-consumed responses go through zod + `parseWithFallback` with a typed fallback (`data/api.ts` helpers).
- Workspace-scoped query keys include `wsId`.
- No change in web/desktop behaviour from the core refactor.
- Public fork: never commit hostnames, Apple team IDs or `.env*.local` files.
- i18n: every new string in both `apps/mobile/locales/en` and `apps/mobile/locales/zh-Hans`.
- Commits: conventional commits, each ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01YEaBDgLE4nKkyzLseJWm8A`.
- Commands run from repo root `/Users/ultrasecreth/Developer/multica` unless stated.

## Review Focus

1. A view whose saved filters include a status/priority AND the user's quick filter also picks some → must narrow (intersection), and a disjoint pick must show an empty list, not the unfiltered view. (Task 4 test `disjoint overlay yields an empty match-nothing list`.)
2. Remembered chip points to a view deleted on web → app must open on **All**, not on a blank/erroring screen. (Task 5 test `falls back to All when remembered view is gone`.)
3. Preferences `order` lists ids of deleted views or `builtin:members`/`builtin:agents` → those must not produce chips; All stays first even if prefs hide it. (Task 5 tests.)
4. A view saved with sort `position` or an unknown/garbage `sortBy` → request must still be valid (known fields pass through; unknown → `created_at`/`desc`). (Task 4 test `unknown sort falls back to created_at desc`.)
5. Views/preferences request fails (network, 403) → Issues tab still shows All with issues. (Task 7: `useIssueViewChips` returns All-only on error; covered by Task 5 `composes All-only when views are undefined`.)

---

### Task 1: Core — make view-bar prefs importable without the API client

**Files:**
- Create: `packages/core/issue-views/view-bar-prefs.ts`
- Create: `packages/core/issue-views/view-bar-prefs.test.ts`
- Modify: `packages/core/issue-views/preferences.ts:8-13` and `:60-93` (remove moved code, re-export)
- Modify: `packages/core/package.json` exports (add `./issue-views/view-bar-prefs`)

**Interfaces:**
- Produces: `@multica/core/issue-views/view-bar-prefs` exporting `ViewBarPrefs { hidden: string[]; order: string[] }`, `EMPTY_VIEW_BAR_PREFS`, `applyViewBarPrefs<T extends { barItemId: string }>(items: T[], prefs: ViewBarPrefs | undefined, anchorId: string): { visible: T[]; hiddenSet: Set<string>; ordered: T[] }`. Existing `preferences.ts` keeps exporting the same three names.

- [ ] **Step 1: Write the failing test** `packages/core/issue-views/view-bar-prefs.test.ts`

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyViewBarPrefs } from "./view-bar-prefs";

const items = ["builtin:all", "view:a", "view:b", "view:c"].map((barItemId) => ({ barItemId }));
const ids = (xs: { barItemId: string }[]) => xs.map((x) => x.barItemId);

describe("applyViewBarPrefs", () => {
  it("applies order, appends unordered items, ignores unknown ids", () => {
    const r = applyViewBarPrefs(items, { order: ["view:c", "view:gone", "view:a"], hidden: [] }, "builtin:all");
    expect(ids(r.visible)).toEqual(["view:c", "view:a", "builtin:all", "view:b"]);
  });
  it("drops hidden items but never the anchor", () => {
    const r = applyViewBarPrefs(items, { order: [], hidden: ["view:b", "builtin:all"] }, "builtin:all");
    expect(ids(r.visible)).toEqual(["builtin:all", "view:a", "view:c"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @multica/core exec vitest run issue-views/view-bar-prefs.test.ts`
Expected: FAIL — cannot resolve `./view-bar-prefs`.

- [ ] **Step 3: Create `packages/core/issue-views/view-bar-prefs.ts`** — move the code verbatim (no `"use client"`, no imports):

```ts
/**
 * Pure view-bar composition. Kept free of React / the API client so the
 * mobile app (which owns its own API layer) can import it.
 */
export interface ViewBarPrefs {
  hidden: string[];
  order: string[];
}

export const EMPTY_VIEW_BAR_PREFS: ViewBarPrefs = { hidden: [], order: [] };

/**
 * Compose the view bar: apply the user's order, drop hidden items, keep the
 * anchor built-in ("builtin:" first item) always visible so nobody locks
 * themselves out of a surface. Unknown ids in prefs (deleted views) are
 * ignored; items absent from `order` append in their natural position.
 */
export function applyViewBarPrefs<T extends { barItemId: string }>(
  items: T[],
  prefs: ViewBarPrefs | undefined,
  anchorId: string,
): { visible: T[]; hiddenSet: Set<string>; ordered: T[] } {
  const order = prefs?.order ?? [];
  const hiddenSet = new Set(prefs?.hidden ?? []);
  hiddenSet.delete(anchorId);

  const byId = new Map(items.map((item) => [item.barItemId, item]));
  const ordered: T[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item) {
      ordered.push(item);
      byId.delete(id);
    }
  }
  for (const item of items) {
    if (byId.has(item.barItemId)) ordered.push(item);
  }

  return {
    ordered,
    hiddenSet,
    visible: ordered.filter((item) => !hiddenSet.has(item.barItemId)),
  };
}
```

In `preferences.ts`: delete the `ViewBarPrefs` interface, `EMPTY_VIEW_BAR_PREFS` const and the `applyViewBarPrefs` function (with its doc comment), and add after the imports:

```ts
export { EMPTY_VIEW_BAR_PREFS, applyViewBarPrefs, type ViewBarPrefs } from "./view-bar-prefs";
import { EMPTY_VIEW_BAR_PREFS, type ViewBarPrefs } from "./view-bar-prefs";
```

(keep the second line only if `preferences.ts` still references those names internally; `pnpm --filter @multica/core typecheck` will tell you).

In `packages/core/package.json` `exports`, after `"./issue-views/preferences": ...` add:

```json
    "./issue-views/view-bar-prefs": "./issue-views/view-bar-prefs.ts",
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @multica/core exec vitest run issue-views && pnpm --filter @multica/core typecheck && pnpm typecheck`
Expected: all PASS (root typecheck proves web/desktop imports unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/core/issue-views/view-bar-prefs.ts packages/core/issue-views/view-bar-prefs.test.ts packages/core/issue-views/preferences.ts packages/core/package.json
git commit -m "refactor(core): move pure view-bar prefs into a client-free module"
```

---

### Task 2: Mobile API — views, preferences, table rows, and object-param fix

**Files:**
- Modify: `apps/mobile/data/api.ts` (`listIssues` ~line 629; add three methods after it)
- Test: `apps/mobile/data/api.test.ts` (append describes)

**Interfaces:**
- Produces on `api`:
  - `listIssueViews(scope: { scope_type: "workspace" }, opts?: { signal?: AbortSignal }): Promise<IssueView[]>`
  - `getIssueViewPreference(scope: { scope_type: "workspace" }, opts?: { signal?: AbortSignal }): Promise<IssueViewPreference>`
  - `listIssueTableRows(req: IssueTableRowsRequest, opts?: { signal?: AbortSignal }): Promise<IssueTableRowsResponse>`
  - `IssueView`, `IssueViewPreference` types come from `@multica/core/api/schemas`; `IssueTableRowsRequest`, `IssueTableRowsResponse` from `@multica/core/types`.

- [ ] **Step 1: Write failing tests** — append to `apps/mobile/data/api.test.ts`:

```ts
describe("api issue views + table rows", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("listIssues serialises object params as JSON", async () => {
    fetchMock.mockResolvedValue(json({ issues: [], total: 0 }));
    await api.listIssues({ properties: { "def-1": ["u-1"] } } as never);
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(JSON.parse(url.searchParams.get("properties")!)).toEqual({ "def-1": ["u-1"] });
  });

  it("listIssueViews GETs workspace views and tolerates a non-array body", async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: "v1", name: "Needs me", query: {}, display: {} }]));
    const views = await api.listIssueViews({ scope_type: "workspace" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example.test/api/issue-views?scope_type=workspace");
    expect(views.map((v) => v.name)).toEqual(["Needs me"]);

    fetchMock.mockResolvedValueOnce(json({ unexpected: true }));
    expect(await api.listIssueViews({ scope_type: "workspace" })).toEqual([]);
  });

  it("getIssueViewPreference falls back to empty prefs on garbage", async () => {
    fetchMock.mockResolvedValueOnce(json("nope"));
    const pref = await api.getIssueViewPreference({ scope_type: "workspace" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.example.test/api/issue-view-preferences?scope_type=workspace",
    );
    expect(pref.prefs).toEqual({ hidden: [], order: [] });
  });

  it("listIssueTableRows POSTs the request body", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ query_fingerprint: "f", group_key: null, parent_id: null, total: 0, rows: [], branch_total: 0, next_cursor: null }),
    );
    const req = {
      query: { scope: { kind: "workspace" as const }, filters: {}, sort: { field: "created_at" as const, direction: "desc" as const } },
      group: { kind: "none" as const },
      group_key: null,
      hierarchy: { enabled: false },
      parent_id: null,
      page: { limit: 100, cursor: null },
    };
    const res = await api.listIssueTableRows(req);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/api/issues/table/rows");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(req);
    expect(res.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @multica/mobile exec vitest run data/api.test.ts`
Expected: FAIL — `listIssueViews is not a function` etc., and the properties assertion fails with `[object Object]`.

- [ ] **Step 3: Implement** in `apps/mobile/data/api.ts`.

Add imports near the other schema imports:

```ts
import {
  EMPTY_ISSUE_TABLE_ROWS_RESPONSE,
  EMPTY_ISSUE_VIEW_PREFERENCE,
  IssueTableRowsResponseSchema,
  IssueViewListSchema,
  IssueViewPreferenceSchema,
  type IssueView,
  type IssueViewPreference,
} from "@multica/core/api/schemas";
import type { IssueTableRowsRequest, IssueTableRowsResponse } from "@multica/core/types";
```

In `listIssues`, replace the scalar branch so objects are JSON (arrays keep the comma join):

```ts
      } else if (typeof v === "object") {
        // Map-shaped params (e.g. `properties`) are JSON on the wire, same as
        // web's client (packages/core/api/client.ts).
        search.set(k, JSON.stringify(v));
      } else {
        search.set(k, String(v));
      }
```

Add after `listIssues`:

```ts
  // --- Saved issue views (read-only on mobile) ---
  // Mirrors packages/core/api/client.ts listIssueViews / getIssueViewPreference.
  async listIssueViews(
    scope: { scope_type: "workspace" },
    opts?: { signal?: AbortSignal },
  ): Promise<IssueView[]> {
    return this.fetchValidated(
      `/api/issue-views?scope_type=${scope.scope_type}`,
      IssueViewListSchema,
      [],
      { ...opts, endpoint: "GET /api/issue-views" },
    );
  }

  async getIssueViewPreference(
    scope: { scope_type: "workspace" },
    opts?: { signal?: AbortSignal },
  ): Promise<IssueViewPreference> {
    return this.fetchValidated(
      `/api/issue-view-preferences?scope_type=${scope.scope_type}`,
      IssueViewPreferenceSchema,
      EMPTY_ISSUE_VIEW_PREFERENCE,
      { ...opts, endpoint: "GET /api/issue-view-preferences" },
    );
  }

  async listIssueTableRows(
    req: IssueTableRowsRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<IssueTableRowsResponse> {
    return this.fetchValidatedWith(
      "/api/issues/table/rows",
      IssueTableRowsResponseSchema,
      EMPTY_ISSUE_TABLE_ROWS_RESPONSE,
      { method: "POST", body: JSON.stringify(req) },
      { ...opts, endpoint: "POST /api/issues/table/rows" },
    );
  }
```

If `IssueViewListSchema` has no `.catch`, a non-array body throws inside zod; `parseWithFallback` returns the `[]` fallback — the test proves it. If the `[]` fallback type complains, annotate `[] as IssueView[]`.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @multica/mobile exec vitest run data/api.test.ts && pnpm --filter @multica/mobile typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/data/api.ts apps/mobile/data/api.test.ts
git commit -m "feat(mobile): API for saved views, view prefs and table rows; send object params as JSON"
```

---

### Task 3: Pins accept `view`

**Files:**
- Modify: `apps/mobile/data/schemas.ts:547`
- Create: `apps/mobile/data/pin-schema.test.ts`

**Interfaces:**
- Produces: `PinnedItemSchema` parses `item_type: "view"` as `"view"` (core `PinnedItemType` already includes it).

- [ ] **Step 1: Failing test** `apps/mobile/data/pin-schema.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { PinnedItemSchema } from "./schemas";

describe("PinnedItemSchema", () => {
  it("keeps view pins as views", () => {
    expect(PinnedItemSchema.parse({ id: "p", item_type: "view", item_id: "v1" }).item_type).toBe("view");
  });
  it("still coerces unknown types to issue", () => {
    expect(PinnedItemSchema.parse({ id: "p", item_type: "dashboard", item_id: "x" }).item_type).toBe("issue");
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @multica/mobile exec vitest run data/pin-schema.test.ts` → FAIL (`"issue"` ≠ `"view"`).

- [ ] **Step 3: Implement** — `schemas.ts:547`:

```ts
  item_type: z.enum(["issue", "project", "view"]).catch("issue"),
```

- [ ] **Step 4: Verify** — same vitest command PASS; `pnpm --filter @multica/mobile typecheck` will now flag `more/pins.tsx` narrowing (`MissingPinRow itemType: "issue" | "project"`). That is fixed in Task 8; if typecheck fails only there, proceed.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/data/schemas.ts apps/mobile/data/pin-schema.test.ts
git commit -m "fix(mobile): keep view pins instead of coercing them to issue pins"
```

---

### Task 4: View → table query mapper (pure)

**Files:**
- Create: `apps/mobile/lib/view-table-query.ts`
- Create: `apps/mobile/lib/view-table-query.test.ts`

**Interfaces:**
- Consumes: `IssueView` (`@multica/core/api/schemas`), `baselineFromQuery` (`@multica/core/issue-views/baseline`), `assigneeTypesForActorKind` (`@multica/core/issues/surface/scope`), types from `@multica/core/types`.
- Produces:
  - `type IssuesChipSource = { kind: "all" } | { kind: "view"; view: IssueView }`
  - `interface QuickFilter { statuses: IssueStatus[]; priorities: IssuePriority[] }`
  - `buildIssueTableQuery(source: IssuesChipSource, quick: QuickFilter): IssueTableQuerySpec`
  - `intersectFilter<T extends string>(fixed: T[], quick: T[]): T[] | null` — `null` = no constraint; `[]` = match nothing.

- [ ] **Step 1: Failing tests** `apps/mobile/lib/view-table-query.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { IssueView } from "@multica/core/api/schemas";
import { buildIssueTableQuery, intersectFilter } from "./view-table-query";

const view = (over: Partial<IssueView>): IssueView => ({
  id: "v1", workspace_id: "w", owner_id: "u", name: "V", scope_type: "workspace",
  scope_id: null, scope_variant: null, visibility: "private", definition_version: 1,
  query: {}, display: {}, revision: 1, created_at: "", updated_at: "", ...over,
});
const noQuick = { statuses: [], priorities: [] };

describe("intersectFilter", () => {
  it("returns null when neither side constrains", () => expect(intersectFilter([], [])).toBeNull());
  it("uses the side that constrains", () => {
    expect(intersectFilter(["a"], [])).toEqual(["a"]);
    expect(intersectFilter([], ["b"])).toEqual(["b"]);
  });
  it("intersects when both constrain", () => expect(intersectFilter(["a", "b"], ["b", "c"])).toEqual(["b"]));
});

describe("buildIssueTableQuery", () => {
  it("All = workspace scope, no filters, default sort, sub-issues shown", () => {
    expect(buildIssueTableQuery({ kind: "all" }, noQuick)).toEqual({
      scope: { kind: "workspace" },
      filters: { include_sub_issues: true },
      sort: { field: "created_at", direction: "desc" },
    });
  });

  it("maps a Needs-me style view: property filters pass through verbatim", () => {
    const spec = buildIssueTableQuery(
      { kind: "view", view: view({ query: { propertyFilters: { "resp-def": ["user-1"], "needs-def": ["true"] } } }) },
      noQuick,
    );
    expect(spec.filters.properties).toEqual({ "resp-def": ["user-1"], "needs-def": ["true"] });
  });

  it("keeps operator property filters and drops unknown operators", () => {
    const spec = buildIssueTableQuery(
      { kind: "view", view: view({ query: { propertyFilters: { n: [{ op: "gt", value: "3" }, { op: "bogus", value: "1" }] } } }) },
      noQuick,
    );
    expect(spec.filters.properties).toEqual({ n: [{ op: "gt", value: "3" }] });
  });

  it("maps every saved filter dimension", () => {
    const spec = buildIssueTableQuery(
      {
        kind: "view",
        view: view({
          query: {
            statusFilters: ["todo"], priorityFilters: ["high"],
            assigneeFilters: [{ type: "agent", id: "a1" }], includeNoAssignee: true,
            creatorFilters: [{ type: "member", id: "m1" }],
            projectFilters: ["p1"], includeNoProject: true, projectStatusFilters: ["in_progress"],
            labelFilters: ["l1"],
          },
        }),
      },
      noQuick,
    );
    expect(spec.filters).toMatchObject({
      statuses: ["todo"], priorities: ["high"],
      assignees: [{ type: "agent", id: "a1" }], include_no_assignee: true,
      creators: [{ type: "member", id: "m1" }],
      project_ids: ["p1"], include_no_project: true, project_statuses: ["in_progress"],
      label_ids: ["l1"],
    });
  });

  it("members/agents variants restrict assignee types like web", () => {
    expect(buildIssueTableQuery({ kind: "view", view: view({ scope_variant: "members" }) }, noQuick).scope)
      .toEqual({ kind: "workspace", assignee_types: ["member"] });
    expect(buildIssueTableQuery({ kind: "view", view: view({ scope_variant: "agents" }) }, noQuick).scope)
      .toEqual({ kind: "workspace", assignee_types: ["agent", "squad"] });
  });

  it("uses the view's sort and sub-issue display settings", () => {
    const spec = buildIssueTableQuery(
      { kind: "view", view: view({ display: { sortBy: "priority", sortDirection: "asc", showSubIssues: false } }) },
      noQuick,
    );
    expect(spec.sort).toEqual({ field: "priority", direction: "asc" });
    expect(spec.filters.include_sub_issues).toBe(false);
  });

  it("unknown sort falls back to created_at desc", () => {
    const spec = buildIssueTableQuery(
      { kind: "view", view: view({ display: { sortBy: "rainbow", sortDirection: "sideways" } }) },
      noQuick,
    );
    expect(spec.sort).toEqual({ field: "created_at", direction: "desc" });
  });

  it("quick filter narrows a view's statuses", () => {
    const spec = buildIssueTableQuery(
      { kind: "view", view: view({ query: { statusFilters: ["todo", "in_progress"] } }) },
      { statuses: ["in_progress", "done"], priorities: [] },
    );
    expect(spec.filters.statuses).toEqual(["in_progress"]);
  });

  it("disjoint overlay yields an empty match-nothing list", () => {
    const spec = buildIssueTableQuery(
      { kind: "view", view: view({ query: { priorityFilters: ["high"] } }) },
      { statuses: [], priorities: ["low"] },
    );
    expect(spec.filters.priorities).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @multica/mobile exec vitest run lib/view-table-query.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `apps/mobile/lib/view-table-query.ts`

```ts
/**
 * Saved view (or "All") → POST /api/issues/table/rows query. Mirrors the
 * filter mapping in web's packages/views/issues/surface/
 * use-issue-surface-controller.ts so a view returns the same issues on both
 * clients. The view blob is sanitised by core's baselineFromQuery first.
 */
import type { IssueView } from "@multica/core/api/schemas";
import { baselineFromQuery } from "@multica/core/issue-views/baseline";
import { assigneeTypesForActorKind } from "@multica/core/issues/surface/scope";
import type {
  IssuePriority,
  IssueStatus,
  IssueTableFilters,
  IssueTableQuerySpec,
  IssueTableSortField,
} from "@multica/core/types";

export type IssuesChipSource = { kind: "all" } | { kind: "view"; view: IssueView };

export interface QuickFilter {
  statuses: IssueStatus[];
  priorities: IssuePriority[];
}

const SORT_FIELDS: readonly string[] = [
  "position", "status", "priority", "title", "created_at", "updated_at",
  "last_activity", "start_date", "due_date",
];
const DEFAULT_SORT = { field: "created_at", direction: "desc" } as const;

/** null = no constraint on this dimension; [] = match nothing. */
export function intersectFilter<T extends string>(fixed: T[], quick: T[]): T[] | null {
  if (fixed.length === 0 && quick.length === 0) return null;
  if (fixed.length === 0) return quick;
  if (quick.length === 0) return fixed;
  const q = new Set(quick);
  return fixed.filter((v) => q.has(v));
}

function sortFrom(display: Record<string, unknown>): IssueTableQuerySpec["sort"] {
  const field = display.sortBy;
  const direction = display.sortDirection;
  const validField =
    typeof field === "string" && (SORT_FIELDS.includes(field) || field.startsWith("property:"));
  if (!validField) return { ...DEFAULT_SORT };
  return {
    field: field as IssueTableSortField,
    direction: direction === "asc" || direction === "desc" ? direction : "desc",
  };
}

export function buildIssueTableQuery(source: IssuesChipSource, quick: QuickFilter): IssueTableQuerySpec {
  if (source.kind === "all") {
    const filters: IssueTableFilters = { include_sub_issues: true };
    const statuses = intersectFilter<IssueStatus>([], quick.statuses);
    const priorities = intersectFilter<IssuePriority>([], quick.priorities);
    if (statuses) filters.statuses = statuses;
    if (priorities) filters.priorities = priorities;
    return { scope: { kind: "workspace" }, filters, sort: { ...DEFAULT_SORT } };
  }

  const { view } = source;
  const raw = baselineFromQuery(view.query).raw;
  const variant = view.scope_variant === "members" || view.scope_variant === "agents" ? view.scope_variant : undefined;
  const assigneeTypes = assigneeTypesForActorKind(variant);

  const filters: IssueTableFilters = {};
  const statuses = intersectFilter(raw.statusFilters, quick.statuses);
  const priorities = intersectFilter(raw.priorityFilters, quick.priorities);
  if (statuses) filters.statuses = statuses;
  if (priorities) filters.priorities = priorities;
  if (raw.assigneeFilters.length > 0) filters.assignees = raw.assigneeFilters;
  if (raw.includeNoAssignee) filters.include_no_assignee = true;
  if (raw.creatorFilters.length > 0) filters.creators = raw.creatorFilters;
  if (raw.projectFilters.length > 0) filters.project_ids = raw.projectFilters;
  if (raw.includeNoProject) filters.include_no_project = true;
  if (raw.projectStatusFilters.length > 0) filters.project_statuses = raw.projectStatusFilters;
  if (raw.labelFilters.length > 0) filters.label_ids = raw.labelFilters;
  if (Object.keys(raw.propertyFilters).length > 0) filters.properties = raw.propertyFilters;
  filters.include_sub_issues = view.display.showSubIssues !== false;

  return {
    scope: { kind: "workspace", ...(assigneeTypes ? { assignee_types: assigneeTypes } : {}) },
    filters,
    sort: sortFrom(view.display),
  };
}
```

Note on the All test: with empty quick filters, `filters` must be exactly `{ include_sub_issues: true }` — the code above produces that. If `raw.assigneeFilters`' type (`ActorFilterValue`) is not assignable to `IssueActorRef[]`, cast with `as IssueActorRef[]` (same shape `{type,id}`) and import the type.

- [ ] **Step 4: Verify** — vitest command PASS; `pnpm --filter @multica/mobile typecheck` PASS (except the known pins narrowing from Task 3).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/view-table-query.ts apps/mobile/lib/view-table-query.test.ts
git commit -m "feat(mobile): map saved views to table queries"
```

---

### Task 5: Chip row composition + remembered-chip resolution (pure)

**Files:**
- Create: `apps/mobile/lib/issues-chips.ts`
- Create: `apps/mobile/lib/issues-chips.test.ts`

**Interfaces:**
- Consumes: `applyViewBarPrefs`, `ViewBarPrefs` (`@multica/core/issue-views/view-bar-prefs`), `IssueView`.
- Produces:
  - `const ALL_CHIP_ID = "builtin:all"`
  - `type IssuesChip = { id: "builtin:all"; kind: "all" } | { id: \`view:${string}\`; kind: "view"; view: IssueView }`
  - `composeIssuesChips(views: IssueView[] | undefined, prefs: ViewBarPrefs | undefined): IssuesChip[]` — All first, then visible workspace views in pref order; other builtins dropped.
  - `resolveSelectedChip(chips: IssuesChip[], rememberedId: string | null): IssuesChip`

- [ ] **Step 1: Failing tests** `apps/mobile/lib/issues-chips.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { IssueView } from "@multica/core/api/schemas";
import { ALL_CHIP_ID, composeIssuesChips, resolveSelectedChip } from "./issues-chips";

const v = (id: string, scope_type = "workspace"): IssueView => ({
  id, workspace_id: "w", owner_id: "u", name: id, scope_type, scope_id: null, scope_variant: null,
  visibility: "private", definition_version: 1, query: {}, display: {}, revision: 1, created_at: "", updated_at: "",
});
const ids = (chips: { id: string }[]) => chips.map((c) => c.id);

describe("composeIssuesChips", () => {
  it("composes All-only when views are undefined", () => {
    expect(ids(composeIssuesChips(undefined, undefined))).toEqual([ALL_CHIP_ID]);
  });
  it("keeps All first even if prefs order it later or hide it", () => {
    const chips = composeIssuesChips([v("a"), v("b")], {
      order: ["view:b", "builtin:members", "builtin:all", "view:a"],
      hidden: ["builtin:all"],
    });
    expect(ids(chips)).toEqual([ALL_CHIP_ID, "view:b", "view:a"]);
  });
  it("drops hidden views, unknown ids and non-workspace views", () => {
    const chips = composeIssuesChips([v("a"), v("b"), v("p", "project")], {
      order: ["view:gone"],
      hidden: ["view:a"],
    });
    expect(ids(chips)).toEqual([ALL_CHIP_ID, "view:b"]);
  });
});

describe("resolveSelectedChip", () => {
  const chips = composeIssuesChips([v("a")], undefined);
  it("returns the remembered view", () => expect(resolveSelectedChip(chips, "view:a").id).toBe("view:a"));
  it("falls back to All when remembered view is gone", () =>
    expect(resolveSelectedChip(chips, "view:zzz").id).toBe(ALL_CHIP_ID));
  it("falls back to All when nothing is remembered", () =>
    expect(resolveSelectedChip(chips, null).id).toBe(ALL_CHIP_ID));
});
```

- [ ] **Step 2: Run** `pnpm --filter @multica/mobile exec vitest run lib/issues-chips.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `apps/mobile/lib/issues-chips.ts`

```ts
/**
 * The Issues tab chip row: "All" + the workspace Issues page's saved views,
 * in the user's web order minus views hidden on web. Web's other built-ins
 * (members / agents) are intentionally not shown on mobile.
 */
import type { IssueView } from "@multica/core/api/schemas";
import { applyViewBarPrefs, type ViewBarPrefs } from "@multica/core/issue-views/view-bar-prefs";

export const ALL_CHIP_ID = "builtin:all";

export type IssuesChip =
  | { id: typeof ALL_CHIP_ID; kind: "all" }
  | { id: `view:${string}`; kind: "view"; view: IssueView };

const ALL_CHIP: IssuesChip = { id: ALL_CHIP_ID, kind: "all" };

export function composeIssuesChips(
  views: IssueView[] | undefined,
  prefs: ViewBarPrefs | undefined,
): IssuesChip[] {
  const viewChips: IssuesChip[] = (views ?? [])
    .filter((view) => view.scope_type === "workspace")
    .map((view) => ({ id: `view:${view.id}` as const, kind: "view" as const, view }));
  const items = [ALL_CHIP, ...viewChips].map((chip) => ({ barItemId: chip.id, chip }));
  const { visible } = applyViewBarPrefs(items, prefs, ALL_CHIP_ID);
  const rest = visible.map((item) => item.chip).filter((chip) => chip.kind === "view");
  return [ALL_CHIP, ...rest];
}

export function resolveSelectedChip(chips: IssuesChip[], rememberedId: string | null): IssuesChip {
  return chips.find((chip) => chip.id === rememberedId) ?? ALL_CHIP;
}
```

- [ ] **Step 4: Verify** — vitest PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/issues-chips.ts apps/mobile/lib/issues-chips.test.ts
git commit -m "feat(mobile): compose the Issues chip row from saved views and web prefs"
```

---

### Task 6: Queries, remembered-chip store, realtime freshness

**Files:**
- Create: `apps/mobile/data/queries/issue-views.ts`
- Create: `apps/mobile/data/stores/issues-chip-store.ts`
- Create: `apps/mobile/lib/trailing-throttle.ts`, `apps/mobile/lib/trailing-throttle.test.ts`
- Modify: `apps/mobile/data/realtime/use-my-issues-realtime.ts`

**Interfaces:**
- Consumes: `api.listIssueViews`, `api.getIssueViewPreference`, `api.listIssueTableRows` (Task 2); `buildIssueTableQuery` output type `IssueTableQuerySpec` (Task 4).
- Produces:
  - `issueViewKeys = { all(wsId), views(wsId), prefs(wsId), rowsAll(wsId), rows(wsId, spec) }`
  - `issueViewListOptions(wsId: string | null)`, `issueViewPrefOptions(wsId: string | null)`, `issueTableRowsInfiniteOptions(wsId: string | null, spec: IssueTableQuerySpec)` (page size `ISSUE_TABLE_PAGE_SIZE = 100`)
  - `useIssuesChipStore` with `rememberedByWs: Record<string, string>`, `remember(wsId: string, chipId: string): void`, `hydrate(wsId: string): Promise<void>`
  - `createTrailingThrottle(fn: () => void, ms: number): () => void`

- [ ] **Step 1: Failing test** `apps/mobile/lib/trailing-throttle.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrailingThrottle } from "./trailing-throttle";

describe("createTrailingThrottle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst into one trailing call", () => {
    const fn = vi.fn();
    const t = createTrailingThrottle(fn, 1000);
    t(); t(); t();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    t();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @multica/mobile exec vitest run lib/trailing-throttle.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`apps/mobile/lib/trailing-throttle.ts`:

```ts
/** Run `fn` once, `ms` after the first call of a burst. */
export function createTrailingThrottle(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}
```

`apps/mobile/data/queries/issue-views.ts`:

```ts
/**
 * Saved views on the Issues tab (read-only). Views + prefs are workspace
 * scope only — the chip row mirrors web's workspace Issues page.
 */
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { IssueTableQuerySpec } from "@multica/core/types";
import { api } from "@/data/api";

export const ISSUE_TABLE_PAGE_SIZE = 100;

export const issueViewKeys = {
  all: (wsId: string | null) => ["issue-views", wsId] as const,
  views: (wsId: string | null) => [...issueViewKeys.all(wsId), "list", "workspace"] as const,
  prefs: (wsId: string | null) => [...issueViewKeys.all(wsId), "prefs", "workspace"] as const,
  rowsAll: (wsId: string | null) => [...issueViewKeys.all(wsId), "rows"] as const,
  rows: (wsId: string | null, spec: IssueTableQuerySpec) => [...issueViewKeys.rowsAll(wsId), spec] as const,
};

export const issueViewListOptions = (wsId: string | null) =>
  queryOptions({
    queryKey: issueViewKeys.views(wsId),
    queryFn: ({ signal }) => api.listIssueViews({ scope_type: "workspace" }, { signal }),
    enabled: !!wsId,
  });

export const issueViewPrefOptions = (wsId: string | null) =>
  queryOptions({
    queryKey: issueViewKeys.prefs(wsId),
    queryFn: ({ signal }) => api.getIssueViewPreference({ scope_type: "workspace" }, { signal }),
    enabled: !!wsId,
  });

export const issueTableRowsInfiniteOptions = (wsId: string | null, spec: IssueTableQuerySpec) =>
  infiniteQueryOptions({
    queryKey: issueViewKeys.rows(wsId, spec),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.listIssueTableRows(
        {
          query: spec,
          group: { kind: "none" },
          group_key: null,
          hierarchy: { enabled: false },
          parent_id: null,
          page: { limit: ISSUE_TABLE_PAGE_SIZE, cursor: pageParam },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!wsId,
  });
```

`apps/mobile/data/stores/issues-chip-store.ts` (same SecureStore pattern as `data/workspace-store.ts`):

```ts
/**
 * Remembers the selected Issues-tab chip per workspace across restarts.
 * Values are chip ids ("builtin:all" | "view:<uuid>"); resolution against the
 * live chip list (deleted views → All) happens in lib/issues-chips.ts.
 */
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";

const keyFor = (wsId: string) => `multica_issues_chip_${wsId}`;

interface IssuesChipState {
  rememberedByWs: Record<string, string>;
  remember: (wsId: string, chipId: string) => void;
  hydrate: (wsId: string) => Promise<void>;
}

export const useIssuesChipStore = create<IssuesChipState>((set, get) => ({
  rememberedByWs: {},
  remember: (wsId, chipId) => {
    set((s) => ({ rememberedByWs: { ...s.rememberedByWs, [wsId]: chipId } }));
    SecureStore.setItemAsync(keyFor(wsId), chipId).catch(() => {});
  },
  hydrate: async (wsId) => {
    if (get().rememberedByWs[wsId]) return;
    const stored = await SecureStore.getItemAsync(keyFor(wsId)).catch(() => null);
    if (stored) set((s) => ({ rememberedByWs: { ...s.rememberedByWs, [wsId]: stored } }));
  },
}));
```

In `use-my-issues-realtime.ts`: import `issueViewKeys` and `createTrailingThrottle`; inside the `useWSSubscriptions` callback, before `return`, add:

```ts
      // Issues-tab rows (saved views / All) are server-filtered: refetch the
      // active ones, collapsing bursts of issue events into one request.
      const refreshRows = createTrailingThrottle(
        () => void qc.invalidateQueries({ queryKey: issueViewKeys.rowsAll(wsId) }),
        1500,
      );
```

and call `refreshRows()` inside the existing `issue:created`, `issue:updated`, `issue:deleted` handlers and in `onReconnect` (keep the existing calls):

```ts
        ws.on("issue:created", () => { invalidateMyAll(); refreshRows(); }),
        ws.on("issue:updated", (payload) => { patchMyIssuesList(qc, wsId, payload.issue); refreshRows(); }),
        ws.on("issue:deleted", (payload) => { removeFromMyIssuesList(qc, wsId, payload.issue_id); refreshRows(); }),
        ...
        ws.onReconnect(() => { invalidateMyAll(); refreshRows(); }),
```

Update the file's header comment with one line: `issue:* + reconnect also refetch the Issues-tab table rows (throttled).`

- [ ] **Step 4: Verify** — `pnpm --filter @multica/mobile exec vitest run` (whole mobile suite) PASS; typecheck PASS except the pins narrowing.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/trailing-throttle.ts apps/mobile/lib/trailing-throttle.test.ts apps/mobile/data/queries/issue-views.ts apps/mobile/data/stores/issues-chip-store.ts apps/mobile/data/realtime/use-my-issues-realtime.ts
git commit -m "feat(mobile): saved-view queries, remembered chip, realtime row refresh"
```

---

### Task 7: Issues tab screen

**Files:**
- Modify (rewrite body): `apps/mobile/app/(app)/[workspace]/(tabs)/my-issues.tsx` (route name stays `my-issues` so links/deep links don't change)
- Modify: `apps/mobile/app/(app)/[workspace]/(tabs)/_layout.tsx:97` (title key)
- Modify: `apps/mobile/locales/en/navigation.json`, `apps/mobile/locales/zh-Hans/navigation.json`, `apps/mobile/locales/en/issues.json`, `apps/mobile/locales/zh-Hans/issues.json`

**Interfaces:**
- Consumes: `issueViewListOptions`, `issueViewPrefOptions`, `issueTableRowsInfiniteOptions` (Task 6); `composeIssuesChips`, `resolveSelectedChip`, `IssuesChip` (Task 5); `buildIssueTableQuery` (Task 4); `useIssuesChipStore` (Task 6); existing `useMyIssuesViewStore` (status/priority quick filter, `issues-filter?scope=my`), `groupIssuesByStatus`, `IssueRow`, `IssuesLoading`.
- Produces: the screen; i18n keys `navigation:tabs.issues`, `issues:empty.view`.

- [ ] **Step 1: i18n.** Add `"issues": "Issues"` under `tabs` in `locales/en/navigation.json` and `"issues": "任务"` in `locales/zh-Hans/navigation.json`. Add under `empty` in `locales/en/issues.json`: `"view": "No issues match this view."` and in zh-Hans: `"view": "没有符合此视图的任务。"`. Leave `my_issues` keys (unused keys are harmless; removing is out of scope).

- [ ] **Step 2: Tab title.** In `(tabs)/_layout.tsx` change `title: t("tabs.my_issues")` → `title: t("tabs.issues")`.

- [ ] **Step 3: Rewrite the screen.** Keep the file's `FilterButton`, `ActiveFilterChips`, `Chip`, `SectionHeader`, `EmptyState` components unchanged. Replace the module doc comment, the `SCOPES` constant, the `MyIssues` component and `ScopeToolbar` with:

```tsx
/**
 * Issues tab: "All" + the workspace's saved views (web order, minus views
 * hidden on web). A view's filters are evaluated by the server via
 * POST /api/issues/table/rows — same query web builds — so a view lists the
 * same issues on both clients. Status + priority quick filters
 * (useMyIssuesViewStore) narrow whatever chip is selected.
 */
```

```tsx
import { useEffect, useMemo } from "react";
import { Pressable, ScrollView, SectionList, View } from "react-native";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
// …keep the existing imports for Text, Button, Header, HeaderActions, StatusIcon,
// IssueRow, IssuesLoading, useWorkspaceStore, useMyIssuesViewStore,
// useClearFiltersOnWorkspaceChange, PRIORITY_LABEL, useT, useIssueStatuses,
// groupIssuesByStatus, useColorScheme, THEME, Ionicons, router, useIsFocused;
// drop buildMyIssuesFilter / myIssueListOptions / MyIssuesScope / useAuthStore / filterIssues.
import {
  issueTableRowsInfiniteOptions,
  issueViewListOptions,
  issueViewPrefOptions,
} from "@/data/queries/issue-views";
import { useIssuesChipStore } from "@/data/stores/issues-chip-store";
import { composeIssuesChips, resolveSelectedChip, type IssuesChip } from "@/lib/issues-chips";
import { buildIssueTableQuery } from "@/lib/view-table-query";

export default function IssuesTab() {
  const isFocused = useIsFocused();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { t } = useT("issues");

  const statusFilters = useMyIssuesViewStore((s) => s.statusFilters);
  const priorityFilters = useMyIssuesViewStore((s) => s.priorityFilters);
  useClearFiltersOnWorkspaceChange(useMyIssuesViewStore.getState().clearFilters, wsId);

  const views = useQuery(issueViewListOptions(wsId));
  const prefs = useQuery(issueViewPrefOptions(wsId));
  const chips = useMemo(
    () => composeIssuesChips(views.data, prefs.data?.prefs),
    [views.data, prefs.data],
  );

  const remembered = useIssuesChipStore((s) => (wsId ? s.rememberedByWs[wsId] ?? null : null));
  useEffect(() => {
    if (wsId) void useIssuesChipStore.getState().hydrate(wsId);
  }, [wsId]);
  const selected = resolveSelectedChip(chips, remembered);
  const selectChip = (chip: IssuesChip) => {
    if (wsId) useIssuesChipStore.getState().remember(wsId, chip.id);
  };

  const spec = useMemo(
    () =>
      buildIssueTableQuery(
        selected.kind === "all" ? { kind: "all" } : { kind: "view", view: selected.view },
        { statuses: statusFilters, priorities: priorityFilters },
      ),
    [selected, statusFilters, priorityFilters],
  );

  const rows = useInfiniteQuery(issueTableRowsInfiniteOptions(wsId, spec));
  const issues = useMemo(
    () => rows.data?.pages.flatMap((page) => page.rows.map((row) => row.issue)) ?? [],
    [rows.data],
  );

  const catalog = useIssueStatuses();
  const sections = useMemo(() => groupIssuesByStatus(issues, catalog.statuses), [issues, catalog.statuses]);

  const hasActiveFilters = statusFilters.length > 0 || priorityFilters.length > 0;
  const openFilter = () => {
    if (!wsSlug) return;
    router.push({ pathname: "/[workspace]/issues-filter", params: { workspace: wsSlug, scope: "my" } });
  };
  const refreshAll = () => {
    void views.refetch();
    void prefs.refetch();
    void rows.refetch();
  };

  const showEmptyState = !rows.isLoading && !rows.error && issues.length === 0;
  const emptyMessage = hasActiveFilters
    ? t("empty.filtered")
    : selected.kind === "all"
      ? t("empty.all")
      : t("empty.view");

  return (
    <View className="flex-1 bg-background">
      <Header title={t("navigation:tabs.issues")} right={<HeaderActions />} />
      <ChipToolbar
        chips={chips}
        selectedId={selected.id}
        allLabel={t("tabs.all")}
        onSelect={selectChip}
        onOpenFilter={openFilter}
        hasActiveFilters={hasActiveFilters}
      />
      {hasActiveFilters ? (
        <ActiveFilterChips
          statusFilters={statusFilters}
          priorityFilters={priorityFilters}
          statusLabelOf={catalog.labelOf}
          onClearStatus={(s) => useMyIssuesViewStore.getState().toggleStatusFilter(s)}
          onClearPriority={(p) => useMyIssuesViewStore.getState().togglePriorityFilter(p)}
        />
      ) : null}
      {rows.isLoading ? (
        <IssuesLoading />
      ) : rows.error ? (
        <View className="px-4 gap-3 pt-4">
          <Text className="text-sm text-destructive">
            {t("errors.load_failed", {
              message: rows.error instanceof Error ? rows.error.message : "unknown",
            })}
          </Text>
          <Button variant="outline" onPress={() => rows.refetch()}>
            <Text>{t("common:actions.retry")}</Text>
          </Button>
        </View>
      ) : showEmptyState ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          ItemSeparatorComponent={() => <View className="h-px bg-border ml-4" />}
          renderSectionHeader={({ section }) => (
            <SectionHeader status={section.status} count={section.data.length} />
          )}
          contentContainerClassName="pb-6"
          renderItem={({ item }) => (
            <IssueRow
              issue={item}
              onPress={() => {
                if (wsSlug) router.push(`/${wsSlug}/issue/${item.id}`);
              }}
            />
          )}
          onEndReached={() => {
            if (rows.hasNextPage && !rows.isFetchingNextPage) void rows.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          refreshing={isFocused && rows.isRefetching && !rows.isFetchingNextPage}
          onRefresh={refreshAll}
        />
      )}
    </View>
  );
}

/** Horizontally scrolling chip row (All + saved views) + Filter button. */
function ChipToolbar({
  chips,
  selectedId,
  allLabel,
  onSelect,
  onOpenFilter,
  hasActiveFilters,
}: {
  chips: IssuesChip[];
  selectedId: string;
  allLabel: string;
  onSelect: (chip: IssuesChip) => void;
  onOpenFilter: () => void;
  hasActiveFilters: boolean;
}) {
  return (
    <View className="flex-row items-center px-4 pt-2 pb-2">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-1 pr-2"
      >
        {chips.map((chip) => {
          const active = chip.id === selectedId;
          const label = chip.kind === "all" ? allLabel : chip.view.name;
          return (
            <Button
              key={chip.id}
              variant="outline"
              size="sm"
              onPress={() => onSelect(chip)}
              className={active ? "bg-accent" : ""}
              accessibilityState={{ selected: active }}
            >
              <Text
                numberOfLines={1}
                className={active ? "text-accent-foreground" : "text-muted-foreground"}
              >
                {label}
              </Text>
            </Button>
          );
        })}
      </ScrollView>
      <FilterButton onPress={onOpenFilter} hasActiveFilters={hasActiveFilters} />
    </View>
  );
}
```

Delete the now-unused `useMyIssuesViewStore` `scope`/`setScope` reads (the store fields stay; `issues-filter.tsx` still writes its status/priority).

- [ ] **Step 4: Verify** — `pnpm --filter @multica/mobile typecheck` (pins narrowing may still fail until Task 8) and `pnpm --filter @multica/mobile lint` PASS for this file. If `Pressable` is now unused at top level it is still used by `Chip`; keep imports that `Chip`/`FilterButton` need.

- [ ] **Step 5: Commit**

```bash
git add "apps/mobile/app/(app)/[workspace]/(tabs)/my-issues.tsx" "apps/mobile/app/(app)/[workspace]/(tabs)/_layout.tsx" apps/mobile/locales
git commit -m "feat(mobile): Issues tab shows All plus saved views"
```

---

### Task 8: Retire More → Issues; open view pins on the Issues tab

**Files:**
- Delete: `apps/mobile/app/(app)/[workspace]/more/issues.tsx`
- Modify: `apps/mobile/app/(app)/[workspace]/_layout.tsx:296-300` (remove the `more/issues` Stack.Screen)
- Modify: `apps/mobile/components/nav/more-tab-dropdown.tsx:79` (remove the issues menu item)
- Modify: `apps/mobile/app/(app)/[workspace]/more/pins.tsx` (view pin row)
- Modify: `apps/mobile/locales/en/settings.json` or the namespace holding `pins.unavailable_*` (add `pins.unavailable_view`) — find it with `rg -l '"unavailable_project"' apps/mobile/locales`.

**Interfaces:**
- Consumes: `issueViewListOptions` (Task 6), `useIssuesChipStore.remember` (Task 6).

- [ ] **Step 1: Remove the route and menu entry.** Delete the file; remove the `<Stack.Screen name="more/issues" … />` block in `_layout.tsx`; delete the `{ labelKey: "more_menu.issues", … path: "/more/issues" }` line. Run `rg -n "more/issues" apps/mobile` — expected: no hits except comments; update those comments to say "Issues tab".

- [ ] **Step 2: View pin row.** In `more/pins.tsx`, next to the issue/project branches (around line 133), add a `view` branch and component:

```tsx
  if (pin.item_type === "view") return <ViewPinRow pin={pin} />;
```

```tsx
function ViewPinRow({ pin }: { pin: PinnedItem }) {
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { data, isLoading } = useQuery(issueViewListOptions(wsId));
  const view = data?.find((v) => v.id === pin.item_id);
  if (isLoading) return null;
  if (!view) return <MissingPinRow itemType="view" itemId={pin.item_id} />;
  return (
    <Pressable
      className="flex-row items-center gap-3 px-4 py-3 active:bg-secondary"
      onPress={() => {
        if (!wsId || !wsSlug) return;
        useIssuesChipStore.getState().remember(wsId, `view:${view.id}`);
        router.navigate(`/${wsSlug}/my-issues`);
      }}
    >
      <Ionicons name="albums-outline" size={16} />
      <Text className="text-sm text-foreground" numberOfLines={1}>{view.name}</Text>
    </Pressable>
  );
}
```

Widen `MissingPinRow`'s `itemType` to `"issue" | "project" | "view"` and its label selection to use `t("pins.unavailable_view")` for views. Add `"unavailable_view": "Saved view unavailable"` (en) / `"unavailable_view": "保存的视图不可用"` (zh-Hans) next to `unavailable_project`. Match existing imports in the file (`useWorkspaceStore`, `Pressable`, `Ionicons`, `router`, `PinnedItem` type); add `issueViewListOptions` and `useIssuesChipStore` imports. If a sibling row component already gives the icon a theme colour, copy that prop.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @multica/mobile typecheck && pnpm --filter @multica/mobile lint && pnpm --filter @multica/mobile test`
Expected: all PASS (pins narrowing from Task 3 now resolved).

- [ ] **Step 4: Commit**

```bash
git add -A apps/mobile
git commit -m "feat(mobile): retire More→Issues; view pins open the Issues tab"
```

---

### Task 9: Whole-branch verification on device

**Files:** none (native `ios/` is generated and git-ignored).

- [ ] **Step 1: Full checks** — `pnpm typecheck && pnpm --filter @multica/core test && pnpm --filter @multica/mobile typecheck && pnpm --filter @multica/mobile lint && pnpm --filter @multica/mobile test`. Expected: PASS. `git diff contango/mobile-saved-views@{u} --stat` must show no `.env*`, `ios/` or hostnames (grep the changed files for internal hostnames and the signing team id → no hits).

- [ ] **Step 2: Device build.** From `apps/mobile/ios`: `xcodebuild -workspace Multica.xcworkspace -scheme Multica -configuration Release -destination 'id=<phone udid>' -derivedDataPath <scratch>/dd-dev -allowProvisioningUpdates build`, then `xcrun devicectl device install app --device <udid> <app>` and launch. (The local iOS 27 fixes in generated `ios/` must still be present: SceneDelegate in `AppDelegate.swift`, scene manifest, deployment target 16.0, script sandboxing NO.)

- [ ] **Step 3: Parity check (human + agent).** On the phone open Issues → each chip. For "Needs me" and one other view, compare the issue set and count with the same view on web. Record result. Kill and reopen the app → last chip restored. Pick a status quick filter → list narrows.

- [ ] **Step 4: Push** — `git push contango contango/mobile-saved-views`.
