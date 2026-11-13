// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import { buildSmartRows, smartRowEntries, smartRowUnreadIds } from "./smart-fold";
import { buildSmartSections, doThisFirst, smartCounters } from "./smart";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function item(over: Partial<Omit<InboxItem, "details">> & { details?: unknown }): InboxItem {
  return {
    id: "x", workspace_id: "ws", recipient_type: "member", recipient_id: "me",
    actor_type: null, actor_id: null, type: "status_changed", severity: "info",
    issue_id: null, title: "t", body: null, issue_status: null, read: true, archived: false,
    created_at: hoursAgo(1),
    ...over,
    details: (over.details ?? null) as InboxItem["details"],
  };
}
const signal = (id: string, group: string, over: Partial<Omit<InboxItem, "details">> = {}) =>
  item({
    id, type: "signal", severity: "action_required", actor_type: "system", title: `Signal ${id}`, read: true,
    details: { key: id, group, summary: `why ${id}`, actions: [], rank: { priority: "high", blocks: 2, since: hoursAgo(6) } },
    ...over,
  });

describe("buildSmartRows", () => {
  const rows = () =>
    buildSmartRows([
      signal("merge-ask", "merge", { issue_id: "ctg-2023", created_at: hoursAgo(0.2) }),
      item({ id: "older-mention", type: "mentioned", issue_id: "ctg-2023", actor_type: "agent", actor_id: "ohno", created_at: hoursAgo(5), details: { comment_id: "c-old" } }),
      item({ id: "mention", type: "mentioned", issue_id: "ctg-2023", actor_type: "agent", actor_id: "brooks", read: false, created_at: hoursAgo(2), details: { comment_id: "c-new" } }),
      item({ id: "status", type: "status_changed", issue_id: "ctg-2023", created_at: hoursAgo(1) }),
      item({ id: "other-mention", type: "mentioned", issue_id: "ctg-9", actor_type: "agent", actor_id: "sutherland", details: { comment_id: "c9" } }),
      signal("fyi-note", "fyi", { issue_id: "ctg-9" }),
    ]);

  it("folds a card's entries into its action signal: one row, the signal's group and text, the tagger's avatar", () => {
    const { items } = rows();
    const onCard = items.filter((i) => i.issue_id === "ctg-2023");
    expect(onCard).toHaveLength(1);
    expect(onCard[0]).toMatchObject({
      id: "merge-ask",
      type: "signal",
      title: "Signal merge-ask",
      actor_type: "agent",
      actor_id: "brooks",
      read: false,
    });
    expect(onCard[0]!.details).toMatchObject({ group: "merge", summary: "why merge-ask", comment_id: "c-new" });
    // The card sits in Merge approvals, not under Mentions & reviews.
    const sections = buildSmartSections(items, NOW);
    expect(sections.find((s) => s.id === "merge")!.entries.map((e) => e.item.id)).toEqual(["merge-ask"]);
    expect(sections.find((s) => s.id === "mentions")!.entries.map((e) => e.item.id)).toEqual(["other-mention"]);
  });

  it("does not fold into fyi signals: a mention there keeps its own row", () => {
    const { items } = rows();
    expect(items.filter((i) => i.issue_id === "ctg-9").map((i) => i.id).sort()).toEqual(["fyi-note", "other-mention"]);
  });

  it("read and archive act on every folded entry", () => {
    const r = rows();
    const row = r.items.find((i) => i.id === "merge-ask")!;
    expect(smartRowEntries(r, row).map((e) => e.id)).toEqual(["merge-ask", "older-mention", "mention", "status"]);
    expect(smartRowUnreadIds(r, row)).toEqual(["mention"]);
    const plain = r.items.find((i) => i.id === "other-mention")!;
    expect(smartRowEntries(r, plain).map((e) => e.id)).toEqual(["other-mention"]);
  });

  it("keeps the system sender when nobody tagged you on the card", () => {
    const { items } = buildSmartRows([
      signal("stall", "stalled", { issue_id: "ctg-5" }),
      item({ id: "st", type: "status_changed", issue_id: "ctg-5" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "stall", actor_type: "system" });
    expect(items[0]!.details?.comment_id).toBeUndefined();
  });
});

describe("dashboard counts cards", () => {
  it("one card with two action signals counts once and takes one Do-this-first slot", () => {
    const sections = buildSmartSections(
      [
        signal("a1", "merge", { issue_id: "card-a" }),
        signal("a2", "decision", { issue_id: "card-a" }),
        signal("b1", "access", { issue_id: "card-b" }),
      ],
      NOW,
    );
    const counters = smartCounters(sections);
    expect(counters.waiting).toBe(2);
    expect(counters.byGroup).toEqual([
      { id: "merge", count: 1 },
      { id: "decision", count: 1 },
      { id: "access", count: 1 },
    ]);
    expect(doThisFirst(sections).map((e) => e.item.issue_id)).toEqual(["card-a", "card-b"]);
  });
});

describe("buildSmartRows: ended signals (contango patch 46)", () => {
  const ended = (id: string, group: string, over: Partial<Omit<InboxItem, "details">> = {}) => {
    const s = signal(id, group, over);
    return { ...s, details: { ...(s.details ?? {}), resolved_at: "2026-11-12T09:00:00Z" } } as InboxItem;
  };
  // CTG-2176 (2026-11-13): the merge ask for #3573 stayed live after the PR
  // merged and the ask was answered; the card itself is Blocked on others.
  const raw = () => [
    ended("merge-3573", "merge", { issue_id: "ctg-2176", issue_status: "blocked", read: false, created_at: hoursAgo(48) }),
    item({ id: "mention-a", type: "mentioned", issue_id: "ctg-2176", created_at: hoursAgo(48.1), details: { comment_id: "c-a" } }),
    item({ id: "mention-b", type: "mentioned", issue_id: "ctg-2176", created_at: hoursAgo(66), details: { comment_id: "c-b" } }),
    signal("live-ask", "decision", { issue_id: "ctg-7" }),
  ];

  it("hides an ended signal and lists the card's mentions as Classic does", () => {
    const { items, folded } = buildSmartRows(raw());
    expect(items.map((i) => i.id).sort()).toEqual(["live-ask", "mention-a"]);
    expect(folded.size).toBe(0);
    const sections = buildSmartSections(items, NOW);
    expect(sections.find((s) => s.id === "merge")).toBeUndefined();
    expect(doThisFirst(sections).map((e) => e.item.id)).toEqual(["live-ask"]);
  });

  it("keeps an ended signal on the open card until the reader moves on", () => {
    expect(buildSmartRows(raw(), "ctg-2176").items.map((i) => i.id).sort()).toEqual(["live-ask", "merge-3573"]);
    expect(buildSmartRows(raw(), "ctg-7").items.map((i) => i.id).sort()).toEqual(["live-ask", "mention-a"]);
  });

  it("an unended signal with no resolved_at is unchanged", () => {
    const live = signal("ask", "merge", { issue_id: "ctg-1" });
    expect(buildSmartRows([live]).items.map((i) => i.id)).toEqual(["ask"]);
  });
});
