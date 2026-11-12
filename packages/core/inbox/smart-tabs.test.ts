// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import { signalDetails } from "./smart";
import {
  buildInboxTabs,
  cardHoursLost,
  cardRef,
  inboxTabsModeFromParam,
  TODAY_LIMIT,
} from "./smart-tabs";

const NOW = Date.parse("2026-11-12T12:00:00Z");
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
    type: "mentioned",
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

function sig(
  group: string,
  opts: { key?: string; card?: string; blocks?: number; since?: number; extra?: Record<string, unknown> } = {},
  over: Partial<Omit<InboxItem, "details">> = {},
): InboxItem {
  seq += 1;
  const card = opts.card ?? `card${seq}`;
  return item({
    type: "signal",
    severity: "action_required",
    issue_id: card,
    created_at: hoursAgo(opts.since ?? 1),
    details: {
      key: opts.key ?? `needs-human:${card}:${seq}`,
      group,
      summary: `CTG-${seq} · waiting`,
      actions: [],
      rank: { priority: "medium", blocks: opts.blocks ?? 0, since: hoursAgo(opts.since ?? 1) },
      ...opts.extra,
    },
    ...over,
  });
}

describe("buildInboxTabs", () => {
  it("files signals into their tabs and leaves digest and reminder entries out", () => {
    const m = buildInboxTabs(
      [
        sig("decision"),
        sig("access"),
        sig("blocking"),
        sig("merge"),
        sig("merge", { key: "post-merge:CTG-1:core#1" }),
        sig("stalled"),
        sig("fyi"),
        sig("alert"),
        sig("decision", { key: "digest:2026-11-12" }),
        sig("decision", { key: "reminder:pending" }),
        item({ type: "mentioned" }),
      ],
      NOW,
    );
    expect(m.decisions.map((r) => r.entry.signal?.group)).toEqual(
      expect.arrayContaining(["decision", "access", "blocking"]),
    );
    expect(m.decisions).toHaveLength(3);
    expect(m.merges.approval).toHaveLength(1);
    expect(m.merges.postMerge).toHaveLength(1);
    expect(m.today.alerts).toHaveLength(1);
    // stalled, fyi, alert and the mention
    expect(m.else).toHaveLength(4);
    expect(m.else.some((e) => e.signal && /^(digest|reminder):/.test(e.signal.key))).toBe(false);
  });

  it("folds an agent's re-ask on the same card into one Decisions row", () => {
    const m = buildInboxTabs(
      [sig("decision", { card: "c1", since: 5 }), sig("decision", { card: "c1", since: 1 })],
      NOW,
    );
    expect(m.decisions).toHaveLength(1);
    expect(m.decisions[0]!.entries).toHaveLength(2);
    // The newest ask is shown; the row ranks by the older ask's score.
    expect(m.decisions[0]!.entry.waitedHours).toBeCloseTo(1);
    expect(m.decisions[0]!.score).toBe(Math.max(...m.decisions[0]!.entries.map((e) => e.score)));
  });

  it("hides finished merge asks on screen", () => {
    const merged = sig("merge", { extra: { merge: { pr: "#1", state: "merged" } } });
    const queuedCard = sig("merge", {}, { issue_status: "in_merge_queue" });
    const doneCard = sig("merge", {}, { issue_status: "done" });
    const open = sig("merge", { extra: { merge: { pr: "#2", state: "open" } } });
    const postMergeOnDoneCard = sig("merge", { key: "post-merge:CTG-9:core#9" }, { issue_status: "done" });
    const m = buildInboxTabs([merged, queuedCard, doneCard, open, postMergeOnDoneCard], NOW);
    expect(m.merges.approval.map((r) => r.entry.item.id)).toEqual([open.id]);
    expect(m.merges.postMerge.map((r) => r.entry.item.id)).toEqual([postMergeOnDoneCard.id]);
    expect(m.badges.merges).toBe(1);
    // Hidden, not moved: nothing else lists them.
    expect(m.else).toHaveLength(0);
  });

  it("ranks Today by score, one row per card, never a Held card, capped at 5", () => {
    const many = Array.from({ length: 7 }, (_, i) => sig("decision", { blocks: i, since: 2 }));
    const held = sig("decision", { blocks: 50, since: 50 }, { issue_status: "held" });
    const merge = sig("merge", { blocks: 20, since: 3 });
    const m = buildInboxTabs([...many, held, merge], NOW);
    expect(m.today.rows).toHaveLength(TODAY_LIMIT);
    expect(m.today.rows[0]!.entry.item.id).toBe(merge.id);
    expect(m.today.rows.some((r) => r.entry.item.id === held.id)).toBe(false);
    // Held cards still show on Decisions.
    expect(m.decisions.some((r) => r.entry.item.id === held.id)).toBe(true);
    expect(m.today.more).toBe(8 - TODAY_LIMIT);
    expect(m.badges.today).toBe(TODAY_LIMIT);
  });

  it("counts only unread rows on Everything else", () => {
    const m = buildInboxTabs([item({ read: true }), item({ read: false }), sig("fyi")], NOW);
    expect(m.badges.elseUnread).toBe(2);
  });

  it("ignores archived entries", () => {
    const m = buildInboxTabs([sig("decision", {}, { archived: true })], NOW);
    expect(m.decisions).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("reads the card ref from the summary", () => {
    expect(cardRef(sig("decision"))).toMatch(/^CTG-\d+$/);
    expect(cardRef(item({ details: { summary: "no ref here" } }))).toBeNull();
  });

  it("card-hours lost is blocks × hours waited", () => {
    const m = buildInboxTabs([sig("decision", { blocks: 3, since: 10 })], NOW);
    expect(cardHoursLost(m.decisions[0]!.entry)).toBeCloseTo(30);
  });

  it("parses the brief and merge facts, tolerating junk", () => {
    const parsed = signalDetails(
      sig("merge", {
        extra: {
          brief: { situation: "S", recommend: "R", default: "", reply_with: "`done`" },
          merge: { pr: "#3840", url: "javascript:x", review_url: "https://github.com/a/b/pull/1/files", ci: "purple", lines: 212, state: "weird" },
        },
      }),
    );
    expect(parsed?.brief).toEqual({ situation: "S", recommend: "R", default: "", defaultApplies: false, replyWith: "`done`" });
    expect(parsed?.merge).toMatchObject({ pr: "#3840", url: null, reviewUrl: "https://github.com/a/b/pull/1/files", ci: "unknown", lines: 212, state: "open" });
    expect(signalDetails(sig("decision"))?.brief).toBeNull();
    expect(signalDetails(sig("decision", { extra: { brief: "nonsense" } }))?.brief).toBeNull();
  });

  it("chooses tabs unless sections were picked", () => {
    expect(inboxTabsModeFromParam(null, null)).toBe("tabs");
    expect(inboxTabsModeFromParam("0", "tabs")).toBe("sections");
    expect(inboxTabsModeFromParam(null, "sections")).toBe("sections");
    expect(inboxTabsModeFromParam("1", "sections")).toBe("tabs");
  });
});
