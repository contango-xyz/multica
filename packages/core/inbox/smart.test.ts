// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import {
  buildSmartSections,
  rankInput,
  rankReason,
  rankScore,
  signalDetails,
  smartInboxModeFromParam,
} from "./smart";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

let seq = 0;
function item(over: Partial<Omit<InboxItem, "details">> & { details?: unknown }): InboxItem {
  seq += 1;
  return {
    id: `i${seq}`,
    workspace_id: "ws",
    recipient_type: "member",
    recipient_id: "u",
    actor_type: null,
    actor_id: null,
    type: "status_changed",
    severity: "info",
    issue_id: null,
    title: `item ${seq}`,
    body: null,
    issue_status: null,
    read: false,
    archived: false,
    created_at: hoursAgo(1),
    ...over,
    details: (over.details ?? null) as InboxItem["details"],
  };
}

function signal(
  group: string,
  rank: Record<string, unknown>,
  over: Partial<Omit<InboxItem, "details">> = {},
): InboxItem {
  return item({
    type: "signal",
    severity: "attention",
    details: { key: `k${seq}`, group, summary: "why", actions: [], rank },
    ...over,
  });
}

describe("signalDetails", () => {
  it("parses a signal and falls back on malformed fields", () => {
    const parsed = signalDetails(
      item({
        type: "signal",
        details: {
          key: "k",
          group: "nonsense",
          summary: 3,
          actions: [
            { label: "Open PR", url: "https://github.com/x" },
            { label: "bad", url: "javascript:alert(1)" },
          ],
          rank: { priority: "p0", blocks: -2 },
        },
      }),
    );
    expect(parsed).toEqual({
      key: "k",
      group: "fyi",
      summary: "",
      actions: [{ label: "Open PR", url: "https://github.com/x" }],
      rank: { priority: "none", blocks: 0, since: null },
    });
  });

  it("is null for other entry types", () => {
    expect(signalDetails(item({ type: "mentioned" }))).toBeNull();
  });
});

describe("ranking", () => {
  it("multiplies priority weight, 1 + blocks and age", () => {
    const urgent = rankInput(signal("merge", { priority: "urgent", blocks: 3, since: hoursAgo(2) }));
    expect(rankScore(urgent, NOW)).toBeCloseTo(8 * 4 * 2);
    expect(rankReason(urgent, NOW)).toEqual({ priority: "urgent", blocks: 3, hours: 2 });
  });

  it("uses the issue priority and created_at for non-signal entries", () => {
    const input = rankInput(item({ type: "mentioned", issue_priority: "high", created_at: hoursAgo(3) }));
    expect(input).toEqual({ priority: "high", blocks: 0, since: hoursAgo(3) });
  });

  it("lets an old low-priority entry climb past a fresh high-priority one", () => {
    const old = rankInput(signal("merge", { priority: "low", since: hoursAgo(10) }));
    const fresh = rankInput(signal("merge", { priority: "high", since: hoursAgo(1) }));
    expect(rankScore(old, NOW)).toBeGreaterThan(rankScore(fresh, NOW));
  });
});

describe("buildSmartSections", () => {
  it("puts waiting first, then groups in order, FYI last; drops empty and archived", () => {
    const mention = item({ type: "mentioned", issue_priority: "medium", created_at: hoursAgo(1) });
    const ask = signal("decision", { priority: "urgent", blocks: 2, since: hoursAgo(5) }, { severity: "action_required" });
    const stalled = signal("stalled", { priority: "low" });
    const merge = signal("merge", { priority: "high" });
    const fyiSignal = signal("fyi", {}, { created_at: hoursAgo(0.5) });
    const status = item({ type: "status_changed", created_at: hoursAgo(2) });
    const archived = signal("alert", {}, { archived: true });

    const sections = buildSmartSections(
      [status, stalled, mention, merge, ask, fyiSignal, archived],
      NOW,
    );
    expect(sections.map((s) => s.id)).toEqual(["waiting", "merge", "stalled", "fyi"]);
    expect(sections[0]!.entries.map((e) => e.item.id)).toEqual([ask.id, mention.id]);
    // FYI is newest first and holds both fyi signals and plain entries.
    expect(sections[3]!.entries.map((e) => e.item.id)).toEqual([fyiSignal.id, status.id]);
  });

  it("ranks within a group by score", () => {
    const a = signal("blocking", { priority: "medium", blocks: 1, since: hoursAgo(1) });
    const b = signal("blocking", { priority: "medium", blocks: 5, since: hoursAgo(1) });
    const [section] = buildSmartSections([a, b], NOW);
    expect(section!.entries.map((e) => e.item.id)).toEqual([b.id, a.id]);
  });
});

describe("smartInboxModeFromParam", () => {
  it("opts in, opts out and otherwise keeps the stored mode", () => {
    expect(smartInboxModeFromParam("1", null)).toBe("smart");
    expect(smartInboxModeFromParam("1", "classic")).toBe("classic");
    expect(smartInboxModeFromParam("0", "smart")).toBeNull();
    expect(smartInboxModeFromParam(null, "classic")).toBe("classic");
    expect(smartInboxModeFromParam(null, null)).toBeNull();
  });
});
