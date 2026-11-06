// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MvpAsk } from "@multica/core/types";
import {
  burndownGeometry,
  canReply,
  criticalIds,
  nearestIndex,
  niceTicks,
  orderedStatusCounts,
  percentDone,
} from "./mvp-helpers";

describe("percentDone", () => {
  it("rounds down and handles an empty group", () => {
    expect(percentDone({ done: 0, total: 0 })).toBe(0);
    expect(percentDone({ done: 999, total: 1000 })).toBe(99);
    expect(percentDone({ done: 3, total: 3 })).toBe(100);
  });
});

describe("orderedStatusCounts", () => {
  it("follows the catalog order, unknown keys last, zeros dropped", () => {
    expect(
      orderedStatusCounts({ held: 2, zz_custom: 1, todo: 3, in_progress: 0, backlog: 1 }, ["backlog", "todo", "in_progress", "held"]),
    ).toEqual([
      ["backlog", 1],
      ["todo", 3],
      ["held", 2],
      ["zz_custom", 1],
    ]);
  });
});

describe("criticalIds", () => {
  it("collects every card on every chain", () => {
    const issue = (id: string) => ({ id }) as never;
    expect([...criticalIds({ critical_paths: [{ issues: [issue("a"), issue("b")] }, { issues: [issue("c")] }] })]).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("canReply", () => {
  const ask = { inbox_item_id: "i1", recipient_id: "u1", replies: [{ index: 0, label: "Approve: ok", content: "ok" }] } as MvpAsk;
  it("only for the entry's own recipient, with replies", () => {
    expect(canReply(ask, "u1")).toBe(true);
    expect(canReply(ask, "u2")).toBe(false);
    expect(canReply(ask, undefined)).toBe(false);
    expect(canReply({ ...ask, inbox_item_id: null }, "u1")).toBe(false);
    expect(canReply({ ...ask, replies: [] }, "u1")).toBe(false);
  });
});

describe("niceTicks", () => {
  it("gives a round bound", () => {
    expect(niceTicks(0)).toEqual({ yMax: 1, ticks: [0, 1] });
    expect(niceTicks(107)).toEqual({ yMax: 150, ticks: [0, 50, 100, 150] });
    expect(niceTicks(474)).toEqual({ yMax: 600, ticks: [0, 200, 400, 600] });
  });
});

describe("burndownGeometry", () => {
  const points = [
    { date: "2026-11-01", open: 10, done: 0 },
    { date: "2026-11-02", open: 5, done: 5 },
    { date: "2026-11-03", open: 0, done: 10 },
  ];
  const geo = burndownGeometry(points, 200, 100, { left: 0, top: 0, right: 0, bottom: 0 });
  it("maps days across and counts up", () => {
    expect(geo.x(0)).toBe(0);
    expect(geo.x(2)).toBe(200);
    expect(geo.y(0)).toBe(100);
    expect(geo.openPath).toBe("M0.0,0.0 L100.0,50.0 L200.0,100.0");
    expect(geo.donePath.startsWith("M0.0,100.0")).toBe(true);
  });
  it("finds the nearest day under the pointer", () => {
    expect(nearestIndex(geo, points.length, -20)).toBe(0);
    expect(nearestIndex(geo, points.length, 120)).toBe(1);
    expect(nearestIndex(geo, points.length, 500)).toBe(2);
  });
});
