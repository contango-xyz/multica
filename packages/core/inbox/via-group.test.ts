// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import { viaGroupHandle } from "./via-group";

const item = (type: InboxItem["type"], details: unknown) =>
  ({ type, details }) as Pick<InboxItem, "type" | "details">;

describe("viaGroupHandle", () => {
  it("reads the group handle off a mention", () => {
    expect(viaGroupHandle(item("mentioned", { via_group: { id: "g1", handle: "devops" } }))).toBe("devops");
  });

  it("is null for a direct mention, another type or a malformed value", () => {
    expect(viaGroupHandle(item("mentioned", { comment_id: "c1" }))).toBeNull();
    expect(viaGroupHandle(item("mentioned", null))).toBeNull();
    expect(viaGroupHandle(item("mentioned", { via_group: "devops" }))).toBeNull();
    expect(viaGroupHandle(item("mentioned", { via_group: { id: "g1" } }))).toBeNull();
    expect(viaGroupHandle(item("new_comment", { via_group: { id: "g1", handle: "devops" } }))).toBeNull();
  });
});
