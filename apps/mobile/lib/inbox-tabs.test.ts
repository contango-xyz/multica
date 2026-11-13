// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { InboxItem } from "@multica/core/types";
import { signalDetails, type SmartEntry } from "@multica/core/inbox/smart";
import {
  archiveIds,
  buildMobileInboxTabs,
  githubButton,
  parseInboxTabsMode,
  tabBadge,
  unreadIds,
  utcTime,
  whyLine,
} from "./inbox-tabs";

const NOW = Date.parse("2026-11-13T12:00:00Z");

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: "inbox-1",
    workspace_id: "ws-1",
    recipient_type: "member",
    recipient_id: "me",
    actor_type: "agent",
    actor_id: "agent-1",
    type: "new_comment",
    severity: "info",
    issue_id: "issue-1",
    title: "Issue title",
    body: null,
    issue_status: null,
    read: true,
    archived: false,
    created_at: "2026-11-13T10:00:00Z",
    details: null,
    ...overrides,
  };
}

function signal(id: string, group: string, details: Record<string, unknown> = {}, overrides: Partial<InboxItem> = {}): InboxItem {
  return item({
    id,
    type: "signal",
    actor_type: null,
    actor_id: null,
    severity: "action_required",
    issue_id: `issue-${id}`,
    title: `Ask ${id}`,
    read: false,
    details: {
      key: `${group}:${id}`,
      group,
      summary: `CTG-${id.replace(/\D/g, "") || 1} · something`,
      rank: { priority: "high", blocks: 1, since: "2026-11-13T09:00:00Z" },
      ...details,
    } as unknown as InboxItem["details"],
    ...overrides,
  });
}

function entry(i: InboxItem): SmartEntry {
  return { item: i, signal: signalDetails(i), score: 1, waitedHours: 1, reason: { priority: "none", blocks: 0, hours: 1 } } as unknown as SmartEntry;
}

describe("buildMobileInboxTabs", () => {
  it("splits signals into Today, Decisions, Merges and Everything else, as core does", () => {
    const tabs = buildMobileInboxTabs(
      [
        signal("d1", "decision"),
        signal("m1", "merge", { merge: { pr: "#12", url: "https://github.com/o/r/pull/12", state: "open" } }),
        item({ id: "c1", issue_id: "other", type: "new_comment", read: false }),
      ],
      NOW,
    );
    expect(tabs.decisions.map((r) => r.entry.item.id)).toEqual(["d1"]);
    expect(tabs.merges.approval.map((r) => r.entry.item.id)).toEqual(["m1"]);
    expect(tabs.today.rows.map((r) => r.entry.item.id).sort()).toEqual(["d1", "m1"]);
    expect(tabs.else.map((e) => e.item.id)).toEqual(["c1"]);
    expect(tabBadge(tabs, "today")).toBe(2);
    expect(tabBadge(tabs, "decisions")).toBe(1);
    expect(tabBadge(tabs, "merges")).toBe(1);
    // Owner: no badge on Squad or Everything else, even with unread rows there.
    expect(tabBadge(tabs, "else")).toBe(0);
    expect(tabBadge(tabs, "squad")).toBe(0);
  });

  it("folds a card's mention into its decision signal: one row, not two", () => {
    const tabs = buildMobileInboxTabs(
      [
        signal("d1", "decision"),
        item({ id: "mention", issue_id: "issue-d1", type: "mentioned", read: false, created_at: "2026-11-13T11:00:00Z" }),
      ],
      NOW,
    );
    expect(tabs.decisions).toHaveLength(1);
    expect(tabs.else).toHaveLength(0);
  });

  it("never puts a Held card on Today and hides finished merge asks without archiving them", () => {
    const held = signal("d2", "decision", {}, { issue_status: "held" });
    const merged = signal("m2", "merge", { merge: { pr: "#13", state: "merged" } });
    const tabs = buildMobileInboxTabs([held, merged], NOW);
    expect(tabs.today.rows).toHaveLength(0);
    expect(tabs.decisions.map((r) => r.entry.item.id)).toEqual(["d2"]);
    expect(tabs.merges.approval).toHaveLength(0);
    expect(merged.archived).toBe(false);
  });

  it("caps Today at five and counts the rest", () => {
    const asks = Array.from({ length: 7 }, (_, i) => signal(`d${i + 1}`, "decision"));
    const tabs = buildMobileInboxTabs(asks, NOW);
    expect(tabs.today.rows).toHaveLength(5);
    expect(tabs.today.more).toBe(2);
  });
});

describe("whyLine", () => {
  it("prefers the brief's situation, then the merge risk, then the body without its Why now line", () => {
    expect(whyLine(entry(signal("a", "decision", { brief: { situation: "Agent needs a key" } })))).toBe("Agent needs a key");
    expect(whyLine(entry(signal("b", "merge", { merge: { risk: "touches auth" } })))).toBe("touches auth");
    expect(whyLine(entry(signal("c", "decision", {}, { body: "Why now: 3 cards wait\n\nPick a provider" })))).toBe("Pick a provider");
    expect(whyLine(entry(signal("d", "decision")))).toBe("");
  });
});

describe("githubButton", () => {
  it("opens a PR's files for a merge ask", () => {
    const s = signalDetails(signal("m", "merge", { merge: { url: "https://github.com/o/r/pull/12" } }));
    expect(githubButton(s)).toEqual({ url: "https://github.com/o/r/pull/12/files", postMerge: false });
  });

  it("keeps the feeder's review url and falls back to a PR action", () => {
    const review = signalDetails(signal("m", "merge", { merge: { url: "https://github.com/o/r/pull/12", review_url: "https://github.com/o/r/pull/12/files#diff" } }));
    expect(githubButton(review)?.url).toBe("https://github.com/o/r/pull/12/files#diff");
    const action = signalDetails(signal("m", "merge", { actions: [{ label: "PR", url: "https://github.com/o/r/pull/7" }] }));
    expect(githubButton(action)?.url).toBe("https://github.com/o/r/pull/7/files");
  });

  it("says Review for post-merge asks and nothing for other groups or missing links", () => {
    const post = signalDetails(signal("p", "merge", { key: "post-merge:1", merge: { url: "https://github.com/o/r/pull/9", post_merge: true } }));
    expect(githubButton(post)?.postMerge).toBe(true);
    expect(githubButton(signalDetails(signal("d", "decision")))).toBeNull();
    expect(githubButton(signalDetails(signal("m", "merge")))).toBeNull();
    expect(githubButton(null)).toBeNull();
  });
});

describe("archiveIds / unreadIds", () => {
  it("sends one request per card plus entries without a card; read skips read entries", () => {
    const entries = [
      entry(item({ id: "a", issue_id: "i1", read: false })),
      entry(item({ id: "b", issue_id: "i1", read: false })),
      entry(item({ id: "c", issue_id: "i2", read: true })),
      entry(item({ id: "d", issue_id: null, read: false })),
    ];
    expect(archiveIds(entries)).toEqual(["a", "c", "d"]);
    expect(unreadIds(entries)).toEqual(["a", "d"]);
    expect(unreadIds([entry(item({ id: "x", read: true }))])).toEqual([]);
  });
});

describe("utcTime", () => {
  it("shows absolute UTC times, with the date when not today", () => {
    expect(utcTime("2026-11-13T09:05:00Z", NOW)).toBe("09:05 UTC");
    expect(utcTime("2026-11-12T23:30:00Z", NOW)).toBe("Nov 12 23:30 UTC");
    expect(utcTime(null, NOW)).toBe("");
    expect(utcTime("garbage", NOW)).toBe("");
  });
});

describe("parseInboxTabsMode", () => {
  it("defaults to tabs; only an explicit sections choice turns them off", () => {
    expect(parseInboxTabsMode(null)).toBe("tabs");
    expect(parseInboxTabsMode("weird")).toBe("tabs");
    expect(parseInboxTabsMode("sections")).toBe("sections");
  });
});
