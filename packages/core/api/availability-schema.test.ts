// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AvailabilityResponseSchema } from "./schemas";

describe("AvailabilityResponseSchema", () => {
  it("fills defaults for an older or partial backend", () => {
    const parsed = AvailabilityResponseSchema.parse({ members: [{ user_id: "u1", time_off: [{ id: "t1", starts_on: "2026-11-16", ends_on: "2026-11-16" }] }] });
    const first = parsed.members[0]!;
    expect(first).toMatchObject({ work_hours: "", away_today: false, backup_user_id: null, personal_ical: false });
    expect(first.time_off[0]).toMatchObject({ half_day: false, label: "", source: "manual" });
  });

  it("treats a missing member list as empty", () => {
    expect(AvailabilityResponseSchema.parse({}).members).toEqual([]);
  });
});
