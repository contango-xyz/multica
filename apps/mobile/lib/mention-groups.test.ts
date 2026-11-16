// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MemberGroup } from "@multica/core/types";
import { matchMentionGroups } from "./mention-groups";

const group = (id: string, handle: string, name: string, description: string): MemberGroup => ({
  id,
  handle,
  name,
  description,
  fallback_user_id: null,
  members: [],
  on_duty: [],
  on_duty_via: "members",
  mention: `[@${handle}](mention://group/${id})`,
  created_at: "",
  updated_at: "",
});

const groups = [
  group("g1", "devops", "DevOps", "Infra and deploys"),
  group("g2", "fe", "Frontend", "Web and desktop UI"),
];

describe("matchMentionGroups", () => {
  it("offers every group, in server order, for an empty query", () => {
    expect(matchMentionGroups(groups, "").map((g) => g.id)).toEqual(["g1", "g2"]);
  });

  it.each([
    ["DEVO", ["g1"]],
    ["frontend", ["g2"]],
    ["deploys", ["g1"]],
    ["nobody", []],
  ])("matches %j on handle, name or description", (query, ids) => {
    expect(matchMentionGroups(groups, query).map((g) => g.id)).toEqual(ids);
  });
});
