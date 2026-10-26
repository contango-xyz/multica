// @vitest-environment node
import { describe, expect, it } from "vitest";

import { PUSH_REFRESH_MS, resolvePushEnvironment, shouldReRegister } from "./push-environment";

describe("resolvePushEnvironment", () => {
  it("maps the development entitlement to sandbox", () => {
    expect(resolvePushEnvironment("development")).toBe("sandbox");
  });
  it("maps the production entitlement to production", () => {
    expect(resolvePushEnvironment("production")).toBe("production");
  });
  it("treats no embedded profile (TestFlight/App Store) as production", () => {
    expect(resolvePushEnvironment(null)).toBe("production");
  });
});

describe("shouldReRegister", () => {
  it("registers when never registered", () => {
    expect(shouldReRegister(null, 0)).toBe(true);
  });
  it("waits until the refresh window has elapsed", () => {
    expect(shouldReRegister(0, PUSH_REFRESH_MS - 1)).toBe(false);
    expect(shouldReRegister(0, PUSH_REFRESH_MS)).toBe(true);
  });
});
