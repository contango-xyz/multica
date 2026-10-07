import { describe, expect, it } from "vitest";
import { viewPinState } from "./view-pin-state";

const views = [{ id: "v1", name: "Needs me" }];

describe("viewPinState", () => {
  it("is loading while the views query has no answer yet", () =>
    expect(viewPinState({ status: "pending", data: undefined }, "v1")).toEqual({ kind: "loading" }));
  it("finds a workspace view", () =>
    expect(viewPinState({ status: "success", data: views }, "v1")).toEqual({ kind: "view", name: "Needs me" }));
  it("never reports a pin missing when the views request failed", () =>
    expect(viewPinState({ status: "error", data: undefined }, "v1")).toEqual({ kind: "unavailable" }));
  it("a view absent from workspace views (e.g. a My-issues view) is unavailable, not deleted", () =>
    expect(viewPinState({ status: "success", data: views }, "v-my")).toEqual({ kind: "unavailable" }));
});
