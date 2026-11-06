// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

// Contango fork, patch 19: GET /api/mvp.

afterEach(() => vi.unstubAllGlobals());

function respond(body: unknown) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const issue = {
  id: "i1", identifier: "CTG-1", number: 1, title: "Card", status: "todo", priority: "none",
  blocked_by: [], blocks: 2, on_critical_path: true, last_run_at: null, flags: ["idle"],
};

describe("getMvpReport", () => {
  it("reads the report", async () => {
    const fetch = respond({
      configured: true,
      config: { home_issue: "CTG-9", release_property: "Release", release_option: "MVP", idle_hours: 24, days: 30 },
      generated_at: "2026-11-06T12:00:00Z",
      home: { id: "h", identifier: "CTG-9", title: "MVP", status: "todo", description: "**it**" },
      totals: { total: 3, open: 1, done: 2, cancelled: 0, by_status: { todo: 1 } },
      pillars: [{ issue, total: 3, open: 1, done: 2, cancelled: 0, by_status: { todo: 1 }, open_items: [issue] }],
      standalone: { total: 0, open: 0, done: 0, cancelled: 0, by_status: {}, open_items: [] },
      critical_paths: [{ issues: [issue] }],
      burndown: [{ date: "2026-11-06", open: 1, done: 2 }],
      eta: { open: 1, done_7d: 2, done_14d: 2, rate_7d: 0.29, rate_14d: 0.14, eta_7d: "2026-11-10", eta_14d: null, days_7d: 3.5, days_14d: null },
      humans: [{ recipient_id: "u1", cards_blocked: 3, asks: [{ issue, comment_id: "c1", kind: "human", excerpt: "Approve", created_at: "2026-11-06T11:00:00Z", recipient_id: "u1", blocks: 2, inbox_item_id: "x1", replies: [{ index: 0, label: "Approve: ok", content: "ok" }] }] }],
      stuck: { held: [], blocked_no_blocker: [], idle: [issue] },
      agent_questions: [],
    });
    const r = await new ApiClient("https://api.example.test").getMvpReport();
    expect(new URL(fetch.mock.calls[0]![0]).pathname).toBe("/api/mvp");
    expect(r.configured).toBe(true);
    expect(r.home?.identifier).toBe("CTG-9");
    expect(r.pillars[0]!.open_items[0]!.assignee_type).toBeNull();
    expect(r.humans[0]!.asks[0]!.replies[0]!.index).toBe(0);
    expect(r.eta.eta_14d).toBeNull();
  });

  it("degrades a partial or malformed payload section by section", async () => {
    respond({ configured: true, totals: "wrong", pillars: [{ broken: true }], burndown: null, home: 5 });
    const r = await new ApiClient("https://api.example.test").getMvpReport();
    expect(r.configured).toBe(true);
    expect(r.totals.total).toBe(0);
    expect(r.pillars).toEqual([]);
    expect(r.burndown).toEqual([]);
    expect(r.home).toBeNull();
    expect(r.standalone.open_items).toEqual([]);
    expect(r.stuck).toEqual({ held: [], blocked_no_blocker: [], idle: [] });
  });

  it.each([null, [], "nope"])("falls back to an empty, unconfigured report: %j", async (body) => {
    respond(body);
    const r = await new ApiClient("https://api.example.test").getMvpReport();
    expect(r.configured).toBe(false);
    expect(r.pillars).toEqual([]);
    expect(r.eta.eta_7d).toBeNull();
  });
});
