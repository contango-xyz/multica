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
