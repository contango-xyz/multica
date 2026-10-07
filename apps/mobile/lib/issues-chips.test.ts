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
