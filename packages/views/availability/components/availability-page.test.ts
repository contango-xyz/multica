// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatRange, formatWorkHours } from "./availability-page";

describe("availability formatting", () => {
  it("reads the work_hours preference", () => {
    expect(formatWorkHours("Europe/London|Mon-Fri|09:00-18:00")).toBe("Mon-Fri 09:00-18:00 (Europe/London)");
    expect(formatWorkHours("")).toBe("");
  });

  it("shows a one-day entry once", () => {
    expect(formatRange({ starts_on: "2026-11-16", ends_on: "2026-11-16" })).not.toContain("–");
    expect(formatRange({ starts_on: "2026-11-16", ends_on: "2026-11-20" })).toContain("–");
  });
});
