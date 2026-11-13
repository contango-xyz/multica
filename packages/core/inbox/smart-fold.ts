// Smart inbox rows (contango, docs/contango/SMART-INBOX.md): one row per card.
//
// A card with a live action signal (any group but fyi) shows ONE row:
// the signal, with the card's other entries (the mention that tagged you,
// comments, status changes) folded into it. The row keeps the signal's
// title, summary and rank, shows the sender of the latest mention, anchors
// on that mention's comment, and is unread while any folded entry is. Cards
// without an action signal are grouped per issue exactly as in Classic.

import { deduplicateInboxItems } from "./queries";
import { isEndedSignal, signalDetails } from "./smart";
import type { InboxItem } from "../types";

const ADDRESSED = new Set<InboxItem["type"]>(["mentioned", "review_requested"]);

export interface SmartRows {
  /** The rows the Smart view lists. */
  items: InboxItem[];
  /**
   * Folded row id → every stored entry it stands for: the signal itself
   * first, then what folded into it. Read/archive act on all of them.
   */
  folded: Map<string, InboxItem[]>;
}

const newestFirst = (a: InboxItem, b: InboxItem) =>
  Date.parse(b.created_at) - Date.parse(a.created_at);

function foldInto(signal: InboxItem, entries: InboxItem[]): InboxItem {
  const sorted = [...entries].sort(newestFirst);
  const mention = sorted.find((e) => ADDRESSED.has(e.type));
  const commentId =
    mention?.details?.comment_id ?? sorted.find((e) => e.details?.comment_id)?.details?.comment_id;
  return {
    ...signal,
    // The sender is whoever tagged you; with no mention it stays the system.
    ...(mention ? { actor_type: mention.actor_type, actor_id: mention.actor_id } : {}),
    read: signal.read && entries.every((e) => e.read),
    details: {
      ...(signal.details ?? {}),
      ...(commentId ? { comment_id: commentId } : {}),
    },
  };
}

/**
 * `keep`: the open row's key (issue id, else entry id). An ended signal on it
 * stays listed until the reader moves on, so an ask that ends while they are
 * answering it does not vanish under them (owner 2026-11-11, CTG-2629).
 */
export function buildSmartRows(raw: InboxItem[], keep?: string | null): SmartRows {
  // Ended signals are hidden (never archived), and the card's mentions then
  // list as they do in Classic instead of folding into a hidden row.
  const active = raw.filter(
    (i) => !i.archived && (!isEndedSignal(i) || (!!keep && (i.issue_id === keep || i.id === keep))),
  );
  const signals = active.filter((i) => i.type === "signal");
  // The card's host row: its newest action signal.
  const host = new Map<string, InboxItem>();
  for (const s of signals) {
    const group = signalDetails(s)?.group;
    if (!s.issue_id || !group || group === "fyi") continue;
    const current = host.get(s.issue_id);
    if (!current || newestFirst(s, current) < 0) host.set(s.issue_id, s);
  }
  const folded = new Map<string, InboxItem[]>();
  const rest: InboxItem[] = [];
  for (const item of active) {
    if (item.type === "signal") continue;
    const target = item.issue_id ? host.get(item.issue_id) : undefined;
    if (target) folded.set(target.id, [...(folded.get(target.id) ?? []), item]);
    else rest.push(item);
  }
  const rows = signals.map((s) => {
    const entries = folded.get(s.id);
    if (!entries) return s;
    folded.set(s.id, [s, ...entries]);
    return foldInto(s, entries);
  });
  return { items: [...rows, ...deduplicateInboxItems(rest)], folded };
}

/** The stored entries a row stands for (itself unless folded). */
export function smartRowEntries(rows: SmartRows, item: InboxItem): InboxItem[] {
  return rows.folded.get(item.id) ?? [item];
}

/** Ids among a row's entries that are still unread. */
export function smartRowUnreadIds(rows: SmartRows, item: InboxItem): string[] {
  return smartRowEntries(rows, item).filter((e) => !e.read).map((e) => e.id);
}
