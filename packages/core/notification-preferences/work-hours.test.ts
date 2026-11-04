import { describe, expect, it } from "vitest";
import { formatWorkHours, parseWorkHours } from "./work-hours";

describe("work hours", () => {
  it("round-trips a comma list and expands ranges, including wrapping ones", () => {
    const w = parseWorkHours("Europe/London|Mon-Fri|09:00-18:00");
    expect(w).toEqual({ zone: "Europe/London", days: ["Mon", "Tue", "Wed", "Thu", "Fri"], from: "09:00", to: "18:00" });
    expect(formatWorkHours(w!)).toBe("Europe/London|Mon,Tue,Wed,Thu,Fri|09:00-18:00");
    expect(parseWorkHours("UTC|Fri-Mon|22:00-06:00")?.days).toEqual(["Mon", "Fri", "Sat", "Sun"]);
  });
  it("is null when unset or malformed", () => {
    expect(parseWorkHours(undefined)).toBeNull();
    expect(parseWorkHours("")).toBeNull();
    expect(parseWorkHours("UTC|Funday|09:00-18:00")).toBeNull();
  });
});
