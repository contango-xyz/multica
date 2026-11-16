import { describe, expect, it } from "vitest";
import { parseIssueRef } from "./issue-ref";

describe("parseIssueRef", () => {
  it.each([
    ["CTG-2850", "CTG-2850"],
    ["ctg-2850", "CTG-2850"],
    ["  Ctg-2850  ", "CTG-2850"],
    ["ctg 2850", "CTG-2850"],
    ["CTG2850", "CTG-2850"],
    ["CTG_2850", "CTG-2850"],
    ["#2850", "CTG-2850"],
    ["# 2850", "CTG-2850"],
    ["#CTG-2850", "CTG-2850"],
    ["2850", "CTG-2850"],
    ["002850", "CTG-2850"],
    ["https://multica.int.contangov3.com/contango/issues/CTG-2850", "CTG-2850"],
    ["https://multica.int.contangov3.com/contango/issues/ctg-2850#comment-01a1", "CTG-2850"],
    ["/contango/issues/CTG-2850?tab=runs", "CTG-2850"],
    ["CTG-2147483647", "CTG-2147483647"],
  ])("%j → %s", (input, expected) => {
    expect(parseIssueRef(input, "CTG")).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "#",
    "0",
    "CTG-0",
    "CTG-",
    "CTG-2147483648",
    "99999999999",
    "MUL-2850",
    "ctg 2850 docs",
    "fix 2850",
    "search",
    "-2850",
    "2850.5",
    "CTGX-2850",
  ])("%j is not an id of CTG", (input) => {
    expect(parseIssueRef(input, "CTG")).toBeNull();
  });

  it("keeps the workspace's own prefix spelling and allows digits in it", () => {
    expect(parseIssueRef("v2-12", "V2")).toBe("V2-12");
    expect(parseIssueRef("v2 12", "V2")).toBe("V2-12");
    expect(parseIssueRef("12", "V2")).toBe("V2-12");
  });

  it("accepts only PREFIX-NUMBER while the workspace prefix is unknown", () => {
    expect(parseIssueRef("ctg-2850", undefined)).toBe("CTG-2850");
    expect(parseIssueRef("2850", null)).toBeNull();
    expect(parseIssueRef("ctg 2850", "")).toBeNull();
  });
});
