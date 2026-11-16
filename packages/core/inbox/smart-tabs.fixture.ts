// Test fixture (contango patch 49): one unarchived inbox entry of every kind the
// unread badge can count, each on its own card (or on none), so the badge and
// the tabs can be compared kind by kind. Shared by core's, web's and iOS's
// tab tests; nothing in the app imports it.
//
// Every entry is unread except where `read` says otherwise; the archived entry
// and the read one must not count. Folds: a mention on a decision card, a
// comment on a finished merge ask's card, a comment on a card with only an fyi
// signal (fyi signals host nothing).

import type { InboxItem, InboxItemType } from "../types";

export interface InboxKindCase {
  /** What the entry stands for, for test names. */
  kind: string;
  items: InboxItem[];
}

export function everyInboxKind(now: number): InboxKindCase[] {
  let seq = 0;
  const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const base = (over: Partial<InboxItem>): InboxItem => {
    seq += 1;
    return {
      id: `kind-${seq}`,
      workspace_id: "ws",
      recipient_type: "member",
      recipient_id: "me",
      actor_type: "agent",
      actor_id: "agent-1",
      type: "new_comment",
      severity: "info",
      issue_id: `card-${seq}`,
      title: `Entry ${seq}`,
      body: null,
      issue_status: "in_progress",
      read: false,
      archived: false,
      created_at: at(1 + seq / 10),
      details: null,
      ...over,
    } as InboxItem;
  };
  const sig = (group: string, key: string, over: Partial<InboxItem> = {}, extra: Record<string, unknown> = {}) =>
    base({
      type: "signal",
      severity: "action_required",
      actor_type: "system",
      actor_id: null,
      ...over,
      details: {
        key,
        group,
        summary: `CTG-${seq + 1} · waiting`,
        actions: [{ label: "Open CTG-1", url: "https://multica.example/ws/issues/CTG-1" }],
        rank: { priority: "medium", blocks: 1, since: at(3) },
        ...extra,
      } as unknown as InboxItem["details"],
    });
  const plain = (type: InboxItemType, over: Partial<InboxItem> = {}) => base({ type, ...over });

  const decisionCard = "card-decision-fold";
  const finishedCard = "card-finished-fold";
  const fyiCard = "card-fyi-fold";
  return [
    { kind: "decision ask", items: [sig("decision", "needs-human:a")] },
    { kind: "access ask", items: [sig("access", "access:a")] },
    { kind: "blocking signal", items: [sig("blocking", "blocking:a")] },
    { kind: "decision ask on a Held card", items: [sig("decision", "needs-human:held", { issue_status: "held" })] },
    { kind: "open merge ask", items: [sig("merge", "merge:open", {}, { merge: { pr: "#1", state: "open" } })] },
    { kind: "post-merge review", items: [sig("merge", "post-merge:CTG-2:core#2", { issue_status: "done" })] },
    { kind: "finished merge ask (PR merged)", items: [sig("merge", "merge:merged", {}, { merge: { pr: "#3", state: "merged" } })] },
    { kind: "merge ask on a queued card", items: [sig("merge", "merge:queued", { issue_status: "in_merge_queue" })] },
    { kind: "stalled signal", items: [sig("stalled", "stalled:a")] },
    { kind: "fyi signal", items: [sig("fyi", "fyi:a", { severity: "info" })] },
    { kind: "alert on a card", items: [sig("alert", "fix-main:a")] },
    { kind: "alert without a card", items: [sig("alert", "fix-main:b", { issue_id: null })] },
    { kind: "reminder (no card)", items: [sig("decision", "reminder:pending", { issue_id: null, issue_status: null })] },
    { kind: "digest (no card)", items: [sig("decision", "digest:2026-11-16", { issue_id: null, issue_status: null })] },
    { kind: "card-less decision ask", items: [sig("decision", "needs-human:nocard", { issue_id: null, issue_status: null })] },
    { kind: "card-less merge ask", items: [sig("merge", "merge:nocard", { issue_id: null, issue_status: null })] },
    { kind: "card-less fyi signal", items: [sig("fyi", "fyi:nocard", { issue_id: null, severity: "info", issue_status: null })] },
    { kind: "card-less stalled signal", items: [sig("stalled", "stalled:nocard", { issue_id: null, issue_status: null })] },
    { kind: "mention", items: [plain("mentioned", { severity: "action_required" })] },
    {
      kind: "group mention (via @group, patch 48)",
      items: [
        plain("mentioned", {
          severity: "action_required",
          details: { via_group: { id: "g1", handle: "devops" }, comment_id: "c1" } as unknown as InboxItem["details"],
        }),
      ],
    },
    { kind: "review request", items: [plain("review_requested", { severity: "action_required" })] },
    { kind: "new comment", items: [plain("new_comment")] },
    { kind: "status change", items: [plain("status_changed")] },
    { kind: "assignment", items: [plain("issue_assigned", { severity: "action_required" })] },
    { kind: "task failed", items: [plain("task_failed", { severity: "attention" })] },
    { kind: "agent blocked", items: [plain("agent_blocked", { severity: "attention" })] },
    { kind: "children done", items: [plain("children_done")] },
    { kind: "reaction", items: [plain("reaction_added")] },
    { kind: "autopilot paused (no card)", items: [plain("autopilot_paused", { issue_id: null, issue_status: null, actor_type: "system" })] },
    { kind: "autopilot quota (no card)", items: [plain("autopilot_quota_exceeded", { issue_id: null, issue_status: null })] },
    { kind: "quick create done", items: [plain("quick_create_done")] },
    { kind: "quick create failed (no card)", items: [plain("quick_create_failed", { issue_id: null, issue_status: null })] },
    { kind: "quick create unconfirmed (no card)", items: [plain("quick_create_unconfirmed", { issue_id: null, issue_status: null })] },
    {
      kind: "mention folded into a decision ask",
      items: [
        sig("decision", "needs-human:fold", { issue_id: decisionCard, read: true, created_at: at(4) }),
        plain("mentioned", { issue_id: decisionCard, severity: "action_required", created_at: at(0.5) }),
      ],
    },
    {
      kind: "comment folded into a finished merge ask",
      items: [
        sig("merge", "merge:finished-fold", { issue_id: finishedCard, issue_status: "done", read: true, created_at: at(4) }),
        plain("new_comment", { issue_id: finishedCard, issue_status: "done", created_at: at(0.5) }),
      ],
    },
    {
      kind: "comment on a card with only an fyi signal",
      items: [
        sig("fyi", "fyi:fold", { issue_id: fyiCard, severity: "info", read: true, created_at: at(4) }),
        plain("new_comment", { issue_id: fyiCard, created_at: at(0.5) }),
      ],
    },
    { kind: "read entry (not counted)", items: [plain("new_comment", { read: true })] },
    { kind: "archived entry (not counted)", items: [plain("mentioned", { archived: true })] },
  ];
}

/**
 * The groups the unread badge counts, as the server's
 * CountUnreadInboxByWorkspace does: unarchived entries grouped by card (an
 * entry with no card is its own group), counted when the group's newest entry
 * is unread. Keys are `issue_id ?? id`.
 */
export function unreadBadgeKeys(items: InboxItem[]): Set<string> {
  const newest = new Map<string, InboxItem>();
  for (const item of items) {
    if (item.archived) continue;
    const key = item.issue_id ?? item.id;
    const cur = newest.get(key);
    if (!cur || Date.parse(item.created_at) > Date.parse(cur.created_at)) newest.set(key, item);
  }
  return new Set([...newest].filter(([, item]) => !item.read).map(([key]) => key));
}
