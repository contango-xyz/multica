import { describe, expect, it } from "vitest";
import type { IssueView } from "@multica/core/api/schemas";
import type { IssueStatusEntry } from "@multica/core/types";
import { buildIssueTableQuery, intersectFilter, type IssuesQueryPlan, type StatusCatalogLike } from "./view-table-query";

const view = (over: Partial<IssueView>): IssueView => ({
  id: "v1", workspace_id: "w", owner_id: "u", name: "V", scope_type: "workspace",
  scope_id: null, scope_variant: null, visibility: "private", definition_version: 1,
  query: {}, display: {}, revision: 1, created_at: "", updated_at: "", ...over,
});
const noQuick = { statuses: [], priorities: [] };
const entry = (key: string, category: string, archived = false): IssueStatusEntry =>
  ({ key, category, archived_at: archived ? "2026-01-01" : null }) as unknown as IssueStatusEntry;
const catalog: StatusCatalogLike = {
  isLoaded: true,
  statuses: [
    entry("backlog", "backlog"), entry("todo", "unstarted"), entry("in_progress", "started"),
    entry("qa", "started"), entry("done", "done"), entry("cancelled", "closed"), entry("old", "started", true),
  ],
};
const spec = (plan: IssuesQueryPlan) => {
  if (plan.kind !== "query") throw new Error(`expected a query, got ${plan.kind}`);
  return plan.spec;
};

describe("intersectFilter", () => {
  it("returns null when neither side constrains", () => expect(intersectFilter([], [])).toBeNull());
  it("uses the side that constrains", () => {
    expect(intersectFilter(["a"], [])).toEqual(["a"]);
    expect(intersectFilter([], ["b"])).toEqual(["b"]);
  });
  it("intersects when both constrain", () => expect(intersectFilter(["a", "b"], ["b", "c"])).toEqual(["b"]));
});

describe("buildIssueTableQuery", () => {
  it("All = workspace scope, visible statuses only, default sort, sub-issues shown", () => {
    const s = spec(buildIssueTableQuery({ kind: "all" }, noQuick, catalog));
    expect(s.scope).toEqual({ kind: "workspace" });
    expect(s.sort).toEqual({ field: "created_at", direction: "desc" });
    expect(s.filters.include_sub_issues).toBe(true);
    // Web hides cancelled (DEFAULT_HIDDEN_STATUSES) and archived columns in list/board.
    const statuses = s.filters.statuses ?? [];
    expect(statuses).toEqual(expect.arrayContaining(["backlog", "todo", "in_progress", "qa", "done"]));
    expect(statuses).not.toContain("cancelled");
    expect(statuses).not.toContain("old");
  });

  it("waits for the status catalog before querying a list-mode surface", () => {
    expect(buildIssueTableQuery({ kind: "all" }, noQuick, { isLoaded: false, statuses: [] }).kind).toBe("pending");
  });

  it("an explicit status filter can show cancelled and archived statuses", () => {
    const s = spec(buildIssueTableQuery(
      { kind: "view", view: view({ query: { statusFilters: ["cancelled", "old", "ghost"] } }) },
      noQuick,
      catalog,
    ));
    expect(s.filters.statuses).toEqual(["cancelled", "old"]);
  });

  it("table-mode views keep cancelled (web's table does not hide statuses)", () => {
    const s = spec(buildIssueTableQuery({ kind: "view", view: view({ display: { viewMode: "table" } }) }, noQuick, catalog));
    expect(s.filters.statuses).toBeUndefined();
  });

  it("maps a Needs-me style view: property filters pass through verbatim", () => {
    const s = spec(buildIssueTableQuery(
      { kind: "view", view: view({ query: { propertyFilters: { "resp-def": ["user-1"], "needs-def": ["true"] } } }) },
      noQuick,
      catalog,
    ));
    expect(s.filters.properties).toEqual({ "resp-def": ["user-1"], "needs-def": ["true"] });
  });

  it("keeps operator property filters and drops unknown operators", () => {
    const s = spec(buildIssueTableQuery(
      { kind: "view", view: view({ query: { propertyFilters: { n: [{ op: "gt", value: "3" }, { op: "bogus", value: "1" }] } } }) },
      noQuick,
      catalog,
    ));
    expect(s.filters.properties).toEqual({ n: [{ op: "gt", value: "3" }] });
  });

  it("maps every saved filter dimension", () => {
    const s = spec(buildIssueTableQuery(
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
      catalog,
    ));
    expect(s.filters).toMatchObject({
      statuses: ["todo"], priorities: ["high"],
      assignees: [{ type: "agent", id: "a1" }], include_no_assignee: true,
      creators: [{ type: "member", id: "m1" }],
      project_ids: ["p1"], include_no_project: true, project_statuses: ["in_progress"],
      label_ids: ["l1"],
    });
  });

  it("members/agents variants restrict assignee types like web", () => {
    expect(spec(buildIssueTableQuery({ kind: "view", view: view({ scope_variant: "members" }) }, noQuick, catalog)).scope)
      .toEqual({ kind: "workspace", assignee_types: ["member"] });
    expect(spec(buildIssueTableQuery({ kind: "view", view: view({ scope_variant: "agents" }) }, noQuick, catalog)).scope)
      .toEqual({ kind: "workspace", assignee_types: ["agent", "squad"] });
  });

  it("uses the view's sort and sub-issue display settings", () => {
    const s = spec(buildIssueTableQuery(
      { kind: "view", view: view({ display: { sortBy: "priority", sortDirection: "asc", showSubIssues: false } }) },
      noQuick,
      catalog,
    ));
    expect(s.sort).toEqual({ field: "priority", direction: "asc" });
    expect(s.filters.include_sub_issues).toBe(false);
  });

  it("position sort is always ascending, like web", () => {
    const s = spec(buildIssueTableQuery(
      { kind: "view", view: view({ display: { sortBy: "position", sortDirection: "desc" } }) },
      noQuick,
      catalog,
    ));
    expect(s.sort).toEqual({ field: "position", direction: "asc" });
  });

  it("unknown sort falls back to created_at desc", () => {
    const s = spec(buildIssueTableQuery(
      { kind: "view", view: view({ display: { sortBy: "rainbow", sortDirection: "sideways" } }) },
      noQuick,
      catalog,
    ));
    expect(s.sort).toEqual({ field: "created_at", direction: "desc" });
  });

  it("quick filter narrows a view's statuses", () => {
    const s = spec(buildIssueTableQuery(
      { kind: "view", view: view({ query: { statusFilters: ["todo", "in_progress"] } }) },
      { statuses: ["in_progress", "done"], priorities: [] },
      catalog,
    ));
    expect(s.filters.statuses).toEqual(["in_progress"]);
  });

  it("disjoint status overlay matches nothing instead of sending an empty (= unfiltered) list", () => {
    const plan = buildIssueTableQuery(
      { kind: "view", view: view({ query: { statusFilters: ["todo"] } }) },
      { statuses: ["done"], priorities: [] },
      catalog,
    );
    expect(plan.kind).toBe("empty");
  });

  it("disjoint priority overlay matches nothing", () => {
    const plan = buildIssueTableQuery(
      { kind: "view", view: view({ query: { priorityFilters: ["high"] } }) },
      { statuses: [], priorities: ["low"] },
      catalog,
    );
    expect(plan.kind).toBe("empty");
  });
});
