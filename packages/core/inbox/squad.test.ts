// Contango patch 51: the Squad tab's inbox load joined with the feeder's MVP holds.
import { describe, expect, it } from "vitest";
import { InboxSquadSchema, squadLoadRows } from "./squad";

const load = (user_id: string, decisions: number) =>
  ({ user_id, name: user_id, decisions, merges: 0, everything_else: 0, new_asks_7d: 0 });

describe("squadLoadRows", () => {
  it("joins holds by user id and sorts most MVP held first, then open asks", () => {
    const data = InboxSquadSchema.parse({
      snapshot: { mvp_holds: [{ user_id: "b", name: "B", asks: 1, mvp: 3, oldest_h: 5 }, { user_id: "c", name: "C", asks: 4, mvp: 0, oldest_h: 50 }] },
      received_at: null,
      inbox_load: [load("a", 9), load("b", 1), load("c", 4)],
    });
    const rows = squadLoadRows(data);
    expect(rows.map((r) => [r.user_id, r.mvp?.mvp ?? null])).toEqual([["b", 3], ["a", null], ["c", 0]]);
  });

  it("a snapshot without mvp_holds (older feeder) or a bad one degrades to no holds", () => {
    for (const snapshot of [{}, { mvp_holds: "nope" }, null]) {
      const data = InboxSquadSchema.parse({ snapshot, received_at: null, inbox_load: [load("a", 1)] });
      expect(squadLoadRows(data)[0]!.mvp).toBeNull();
    }
  });
});
