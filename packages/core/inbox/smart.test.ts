// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import {
  ageTint,
  buildSmartSections,
  doThisFirst,
  smartCounters,
  squadHealth,
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
      replies: [],
      rank: { priority: "none", blocks: 0, since: null },
    });
  });

  it("parses one-tap replies, keeping each one's server index and dropping unusable ones", () => {
    const parsed = signalDetails(
      item({
        type: "signal",
        details: {
          key: "k",
          group: "decision",
          summary: "s",
          actions: [{ label: "Open card", url: "https://x/CTG-1" }],
          replies: [
            { label: "", content: "agree" },
            { label: "Approve: agree", content: "agree", parent_comment_id: "c1" },
            "junk",
            { label: "Reply: no", content: "no" },
          ],
        },
      }),
    );
    expect(parsed?.replies).toEqual([
      { index: 1, label: "Approve: agree", content: "agree", parent_comment_id: "c1" },
      { index: 3, label: "Reply: no", content: "no", parent_comment_id: null },
    ]);
    expect(parsed?.actions).toEqual([{ label: "Open card", url: "https://x/CTG-1" }]);
  });

  it("keeps the link actions when replies are malformed or missing", () => {
    const details = { key: "k", group: "decision", summary: "s", actions: [{ label: "Open card", url: "https://x" }] };
    expect(signalDetails(item({ type: "signal", details: { ...details, replies: "nope" } }))).toMatchObject({
      replies: [],
      actions: [{ label: "Open card", url: "https://x" }],
    });
    expect(signalDetails(item({ type: "signal", details }))?.replies).toEqual([]);
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
  it("groups by type, orders sections by their top entry, FYI last; drops empty and archived", () => {
    const mention = item({ type: "mentioned", issue_priority: "medium", created_at: hoursAgo(1) });
    const review = item({ type: "review_requested", issue_priority: "low", created_at: hoursAgo(1) });
    const decision = signal("decision", { priority: "urgent", blocks: 2, since: hoursAgo(5) }, { severity: "action_required" });
    const merge = signal("merge", { priority: "high", since: hoursAgo(1) }, { severity: "action_required" });
    const access = signal("access", { priority: "high", since: hoursAgo(2) }, { severity: "action_required" });
    const stalled = signal("stalled", { priority: "low", since: hoursAgo(1) });
    const fyiSignal = signal("fyi", { priority: "urgent", blocks: 9, since: hoursAgo(50) }, { created_at: hoursAgo(0.5) });
    const status = item({ type: "status_changed", created_at: hoursAgo(2) });
    const archived = signal("alert", { priority: "urgent", since: hoursAgo(99) }, { archived: true });

    const sections = buildSmartSections(
      [status, stalled, mention, review, merge, access, decision, fyiSignal, archived],
      NOW,
    );
    // decision 8*3*5=120, access 4*1*2=8, merge 4*1*1=4, mentions top 2*1*1=2,
    // stalled 1*1*1=1; FYI last despite its huge score.
    expect(sections.map((s) => s.id)).toEqual(["decision", "access", "merge", "mentions", "stalled", "fyi"]);
    expect(sections[3]!.entries.map((e) => e.item.id)).toEqual([mention.id, review.id]);
    // FYI is newest first and holds both fyi signals and plain entries.
    expect(sections[5]!.entries.map((e) => e.item.id)).toEqual([fyiSignal.id, status.id]);
  });

  it("marks entries that need the reader", () => {
    const ask = signal("merge", {}, { severity: "action_required" });
    const info = signal("merge", {}, { severity: "attention" });
    const mention = item({ type: "mentioned" });
    const status = item({ type: "status_changed" });
    const needs = new Map(
      buildSmartSections([ask, info, mention, status], NOW)
        .flatMap((s) => s.entries)
        .map((e) => [e.item.id, e.needsYou]),
    );
    expect(needs.get(ask.id)).toBe(true);
    expect(needs.get(info.id)).toBe(false);
    expect(needs.get(mention.id)).toBe(true);
    expect(needs.get(status.id)).toBe(false);
  });

  it("stops asking once a mention is opened, but keeps it under Mentions", () => {
    const unread = item({ type: "mentioned", read: false });
    const read = item({ type: "mentioned", read: true });
    const review = item({ type: "review_requested", read: true });
    const sections = buildSmartSections([unread, read, review], NOW);
    const needs = new Map(sections.flatMap((s) => s.entries).map((e) => [e.item.id, e.needsYou]));
    expect(needs.get(unread.id)).toBe(true);
    expect(needs.get(read.id)).toBe(false);
    expect(needs.get(review.id)).toBe(false);
    expect(sections.map((s) => s.id)).toEqual(["mentions"]);
  });

  it("ranks within a group by score", () => {
    const a = signal("blocking", { priority: "medium", blocks: 1, since: hoursAgo(1) });
    const b = signal("blocking", { priority: "medium", blocks: 5, since: hoursAgo(1) });
    const [section] = buildSmartSections([a, b], NOW);
    expect(section!.entries.map((e) => e.item.id)).toEqual([b.id, a.id]);
  });
});

describe("dashboard", () => {
  const ask = (id: string, group: string, rank: Record<string, unknown>, over: Partial<Omit<InboxItem, "details">> = {}) =>
    signal(group, rank, { id, severity: "action_required", ...over });

  it("picks the top 3 waiting entries by score, across sections, and promotes the next when one clears", () => {
    const a = ask("a", "merge", { priority: "urgent", blocks: 4, since: hoursAgo(9) }); // 8*5*9 = 360
    const b = ask("b", "decision", { priority: "high", since: hoursAgo(10) }); // 4*1*10 = 40
    const c = ask("c", "access", { priority: "medium", blocks: 1, since: hoursAgo(5) }); // 2*2*5 = 20
    const d = item({ id: "d", type: "mentioned", issue_priority: "low", created_at: hoursAgo(3) }); // 1*1*3 = 3
    const fyi = signal("fyi", { priority: "urgent", blocks: 9, since: hoursAgo(99) }, { id: "fyi" }); // not waiting
    const top = (items: InboxItem[]) => doThisFirst(buildSmartSections(items, NOW)).map((e) => e.item.id);
    expect(top([d, c, fyi, b, a])).toEqual(["a", "b", "c"]);
    expect(top([d, c, fyi, b])).toEqual(["b", "c", "d"]);
    expect(top([fyi])).toEqual([]);
  });

  it("counts what waits on you, per group, the oldest wait and the urgent ones", () => {
    const sections = buildSmartSections(
      [
        ask("a", "merge", { priority: "urgent", since: hoursAgo(9) }),
        ask("b", "merge", { priority: "high", since: hoursAgo(2) }),
        ask("c", "decision", { priority: "urgent", since: hoursAgo(30) }),
        item({ id: "m", type: "mentioned", created_at: hoursAgo(1) }),
        signal("stalled", { priority: "urgent", since: hoursAgo(50) }, { id: "s" }), // attention: not waiting
      ],
      NOW,
    );
    const counters = smartCounters(sections);
    expect(counters.waiting).toBe(4);
    expect(counters.byGroup).toEqual([
      { id: "merge", count: 2 },
      { id: "decision", count: 1 },
      { id: "mentions", count: 1 },
    ]);
    expect(counters.oldestWaitHours).toBeCloseTo(30);
    expect(counters.urgent).toBe(2);
    expect(smartCounters([]).oldestWaitHours).toBeNull();
  });

  it("reads squad health from the reader's own stalled, blocking and alert signals", () => {
    const health = squadHealth(
      buildSmartSections(
        [
          signal("stalled", {}, { id: "s1" }),
          signal("stalled", {}, { id: "s2" }),
          signal("alert", {}, { id: "main", title: "main red" }),
          item({ id: "x", type: "status_changed" }),
        ],
        NOW,
      ),
    );
    expect(health.stalled).toBe(2);
    expect(health.blocking).toBe(0);
    expect(health.alerts.map((e) => e.item.title)).toEqual(["main red"]);
  });

  it("tints age amber after 4 h and red after 24 h; urgent after 1 h and 4 h", () => {
    const tint = (priority: "urgent" | "high", waitedHours: number) =>
      ageTint({ waitedHours, reason: { priority, blocks: 0, hours: Math.floor(waitedHours) } });
    expect([3.9, 4.1, 23.9, 24.1].map((h) => tint("high", h))).toEqual(["none", "amber", "amber", "red"]);
    expect([0.9, 1.1, 3.9, 4.1].map((h) => tint("urgent", h))).toEqual(["none", "amber", "amber", "red"]);
  });
});

describe("smartInboxModeFromParam", () => {
  it("defaults to smart, keeps the remembered choice, and \"0\" picks classic", () => {
    expect(smartInboxModeFromParam(null, null)).toBe("smart");
    expect(smartInboxModeFromParam("1", null)).toBe("smart");
    expect(smartInboxModeFromParam("1", "classic")).toBe("classic");
    expect(smartInboxModeFromParam(null, "classic")).toBe("classic");
    expect(smartInboxModeFromParam("0", "smart")).toBe("classic");
  });
});
