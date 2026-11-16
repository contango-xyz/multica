// Inbox tabs (contango patch 43, owner 2026-11-12; docs/contango/SMART-INBOX.md
// "Tabs"): the smart inbox's rows split into Today, Decisions, Merges and
// Everything else (Squad has no rows). Pure; ranking is smart.ts's score.
//
// - Decisions: signals in decision, access and blocking; one row per card, the
//   card's other asks (an agent's re-ask is a new entry) folded into it.
// - Merges: merge signals, one row per PR, in "needs your approval" and
//   "merged without you" (post-merge reviews). A merge ask whose PR is finished
//   (details.merge.state other than open, or its card merged, queued or closed)
//   leaves Merges for Everything else: never archived (auto-archive is off by
//   owner decision).
// - Today: the top 5 of Decisions and Merges' approvals by score, never a Held
//   card; alert signals (main red) are its banner; notices (below) sit on top.
// - Everything else: every other row (mentions, fyi, stalled, done, alerts,
//   finished merge asks), newest first.
//
// Every unarchived entry lands on a tab (contango patch 49, owner 2026-11-16:
// the unread badge counted entries no tab showed). Notices are the signals with
// no card that ask something of the reader: the feeder's `reminder:pending`
// ("2 asks waiting on you") and `digest:<day>` entries, or any card-less
// decision/merge ask. They have no card to open or answer on, so Today shows
// them as compact banners with their body and link buttons. A finished merge
// ask (and what folded into it) moves to Everything else rather than
// disappearing; nothing is archived on the reader's behalf.

import type { InboxItem } from "../types";
import { buildSmartSections, cardKey, type SmartEntry } from "./smart";

export const INBOX_TABS = ["today", "decisions", "merges", "squad", "else"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export const TODAY_LIMIT = 5;

const DECISION_GROUPS = new Set(["decision", "access", "blocking"]);
// The feeder's roll-ups: a notice even if one day carries a card.
const NOTICE_KEY = /^(?:digest|reminder):/;
const NOTICE_GROUPS = new Set(["decision", "access", "blocking", "merge"]);
// A card in one of these has nothing left to approve.
const MERGE_FINISHED_STATUSES = new Set(["done", "merged_but_not_approved", "cancelled", "in_merge_queue"]);
const HELD_STATUSES = new Set(["held"]);

/** One row on Decisions, Merges or Today: the newest entry, standing for all of `entries`. */
export interface TabRow {
  entry: SmartEntry;
  /** Every entry the row stands for, the shown one first. */
  entries: SmartEntry[];
  /** Best score among them: the row ranks by it. */
  score: number;
}

export interface InboxTabsModel {
  /** `notices`: card-less asks (reminder, digest), shown as banners on top. */
  today: { rows: TabRow[]; more: number; alerts: SmartEntry[]; notices: SmartEntry[] };
  decisions: TabRow[];
  merges: { approval: TabRow[]; postMerge: TabRow[] };
  else: SmartEntry[];
  badges: { today: number; decisions: number; merges: number; elseUnread: number };
}

/**
 * A notice: a signal with no card that asks something of the reader (the
 * feeder's reminder and digest roll-ups, or a card-less ask). Alerts keep their
 * own banner; card-less fyi and stalled signals are Everything else's.
 */
export function isNotice(entry: SmartEntry): boolean {
  const s = entry.signal;
  if (!s || s.group === "alert") return false;
  if (NOTICE_KEY.test(s.key)) return true;
  return !entry.item.issue_id && NOTICE_GROUPS.has(s.group);
}

/** "CTG-2114" from a signal's summary ("CTG-2114 · unblocks 3 cards · …"), else null. */
export function cardRef(item: InboxItem): string | null {
  const summary = typeof item.details?.summary === "string" ? item.details.summary : "";
  const m = /^([A-Z][A-Z0-9]*-\d+)\b/.exec(summary.trim());
  return m ? m[1]! : null;
}

/** Card-hours lost so far: the cards this one holds × the hours it has waited. */
export function cardHoursLost(entry: SmartEntry): number {
  return (entry.signal?.rank.blocks ?? 0) * entry.waitedHours;
}

function isPostMerge(entry: SmartEntry): boolean {
  return !!entry.signal && (entry.signal.merge?.postMerge === true || entry.signal.key.startsWith("post-merge:"));
}

/** A merge ask with nothing left for its human: off Merges (Everything else lists it), never archived. */
export function isFinishedMergeAsk(entry: SmartEntry): boolean {
  const s = entry.signal;
  if (!s || s.group !== "merge" || isPostMerge(entry)) return false;
  if (s.merge && s.merge.state !== "open") return true;
  return MERGE_FINISHED_STATUSES.has(entry.item.issue_status ?? "");
}

const newest = (a: SmartEntry, b: SmartEntry) => Date.parse(b.item.created_at) - Date.parse(a.item.created_at);

function groupRows(entries: SmartEntry[], keyOf: (e: SmartEntry) => string): TabRow[] {
  const groups = new Map<string, SmartEntry[]>();
  for (const e of entries) {
    const k = keyOf(e);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups.values()]
    .map((list) => {
      const sorted = [...list].sort(newest);
      return { entry: sorted[0]!, entries: sorted, score: Math.max(...list.map((e) => e.score)) };
    })
    .sort((a, b) => b.score - a.score || b.entry.waitedHours - a.entry.waitedHours);
}

const prKey = (e: SmartEntry) => (e.signal?.merge?.pr ? `pr:${e.signal.merge.pr}` : `card:${cardKey(e.item)}`);

export function buildInboxTabs(items: InboxItem[], now: number): InboxTabsModel {
  const all = buildSmartSections(items, now).flatMap((s) => s.entries);
  const decisions: SmartEntry[] = [];
  const approval: SmartEntry[] = [];
  const postMerge: SmartEntry[] = [];
  const alerts: SmartEntry[] = [];
  const notices: SmartEntry[] = [];
  const rest: SmartEntry[] = [];
  for (const e of all) {
    const s = e.signal;
    if (isNotice(e)) notices.push(e);
    else if (s && DECISION_GROUPS.has(s.group)) decisions.push(e);
    else if (s?.group === "merge") {
      if (isPostMerge(e)) postMerge.push(e);
      else if (isFinishedMergeAsk(e)) rest.push(e);
      else approval.push(e);
    } else {
      if (s?.group === "alert") alerts.push(e);
      rest.push(e);
    }
  }
  const decisionRows = groupRows(decisions, (e) => `card:${cardKey(e.item)}`);
  const approvalRows = groupRows(approval, prKey);
  const postMergeRows = groupRows(postMerge, prKey).sort((a, b) => newest(a.entry, b.entry));
  // Today: one row per card across both tabs, never a Held card.
  const seen = new Set<string>();
  const candidates = [...decisionRows, ...approvalRows]
    .filter((r) => !HELD_STATUSES.has(r.entry.item.issue_status ?? ""))
    .sort((a, b) => b.score - a.score || b.entry.waitedHours - a.entry.waitedHours)
    .filter((r) => {
      const k = cardKey(r.entry.item);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const todayRows = candidates.slice(0, TODAY_LIMIT);
  const elseRows = rest.sort(newest);
  return {
    today: { rows: todayRows, more: candidates.length - todayRows.length, alerts, notices: notices.sort(newest) },
    decisions: decisionRows,
    merges: { approval: approvalRows, postMerge: postMergeRows },
    else: elseRows,
    badges: {
      today: todayRows.length + notices.filter((e) => !e.item.read).length,
      decisions: decisionRows.length,
      merges: approvalRows.length,
      elseUnread: elseRows.filter((e) => !e.item.read).length,
    },
  };
}

/**
 * The entries each tab lists as their home (contango patch 49): every entry of
 * the model exactly once. Today's ranked rows are copies of Decisions and
 * Merges rows and its alert banners repeat Everything else's, so Today's own
 * entries are its notices only; Squad lists none. A row stands for the entries
 * folded into it (`TabRow.entries`).
 */
export function tabHomeEntries(model: InboxTabsModel): Record<InboxTab, SmartEntry[]> {
  return {
    today: model.today.notices,
    decisions: rowEntries(model.decisions),
    merges: [...rowEntries(model.merges.approval), ...rowEntries(model.merges.postMerge)],
    squad: [],
    else: model.else,
  };
}

// --- Archive ----------------------------------------------------------------

/** Archiving more cards than this at once asks first. */
export const ARCHIVE_CONFIRM_OVER = 3;

/**
 * The entries to archive for some rows: one per card, since archiving an entry
 * archives every inbox entry on its card (server-side, as Smart's per-row
 * archive does), plus each entry that has no card.
 */
export function archiveTargets(entries: SmartEntry[]): SmartEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const issue = e.item.issue_id;
    if (!issue) return true;
    if (seen.has(issue)) return false;
    seen.add(issue);
    return true;
  });
}

/** Every entry the rows stand for, folded ones included. */
export function rowEntries(rows: TabRow[]): SmartEntry[] {
  return rows.flatMap((r) => r.entries);
}

// --- Opt-in -----------------------------------------------------------------

export const INBOX_TABS_URL_PARAM = "inbox-tabs";

export type InboxTabsMode = "tabs" | "sections";

/**
 * For a user on the tabs flag: tabs unless they chose sections. "0" picks the
 * sections view (today's Smart), "1" tabs; anything else keeps the remembered
 * choice.
 */
export function inboxTabsModeFromParam(param: string | null, stored: InboxTabsMode | null): InboxTabsMode {
  if (param === "0") return "sections";
  if (param === "1") return "tabs";
  return stored ?? "tabs";
}
