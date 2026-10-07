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
