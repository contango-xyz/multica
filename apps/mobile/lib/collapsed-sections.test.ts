import { describe, expect, it } from "vitest";
import type { Issue } from "@multica/core/types";
import { applyCollapsed, toggleCollapsed } from "./collapsed-sections";

const issue = (id: string, status: string) => ({ id, status }) as unknown as Issue;

describe("toggleCollapsed", () => {
  it("collapses then expands a status for one chip only", () => {
    const once = toggleCollapsed({}, "view:a", "done");
    expect(once).toEqual({ "view:a": ["done"] });
    expect(toggleCollapsed(once, "builtin:all", "backlog")).toEqual({ "view:a": ["done"], "builtin:all": ["backlog"] });
    expect(toggleCollapsed(once, "view:a", "done")).toEqual({ "view:a": [] });
  });
});

describe("applyCollapsed", () => {
  const sections = [
    { status: "todo", data: [issue("1", "todo")] },
    { status: "done", data: [issue("2", "done"), issue("3", "done")] },
  ];
  it("empties collapsed sections but keeps their count and flag", () => {
    expect(applyCollapsed(sections, ["done"])).toEqual([
      { status: "todo", data: [sections[0]!.data[0]], count: 1, collapsed: false },
      { status: "done", data: [], count: 2, collapsed: true },
    ]);
  });
});
