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
