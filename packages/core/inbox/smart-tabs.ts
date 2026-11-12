// Inbox tabs (contango patch 43, owner 2026-11-12; docs/contango/SMART-INBOX.md
// "Tabs"): the smart inbox's rows split into Today, Decisions, Merges and
// Everything else (Squad has no rows). Pure; ranking is smart.ts's score.
//
// - Decisions: signals in decision, access and blocking; one row per card, the
//   card's other asks (an agent's re-ask is a new entry) folded into it.
// - Merges: merge signals, one row per PR, in "needs your approval" and
//   "merged without you" (post-merge reviews). A merge ask whose PR is finished
//   (details.merge.state other than open, or its card merged, queued or closed)
//   is hidden here: never archived (auto-archive is off by owner decision).
// - Today: the top 5 of Decisions and Merges' approvals by score, never a Held
//   card; alert signals (main red) are its banner.
// - Everything else: every other row (mentions, fyi, stalled, done, alerts),
//   newest first.
// The feeder's digest:/reminder: entries are left out: Today replaces them on
// screen (their pushes are unchanged).

import type { InboxItem } from "../types";
import { buildSmartSections, cardKey, type SmartEntry } from "./smart";

export const INBOX_TABS = ["today", "decisions", "merges", "squad", "else"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export const TODAY_LIMIT = 5;

const DECISION_GROUPS = new Set(["decision", "access", "blocking"]);
const HIDDEN_KEY = /^(?:digest|reminder):/;
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
  today: { rows: TabRow[]; more: number; alerts: SmartEntry[] };
  decisions: TabRow[];
  merges: { approval: TabRow[]; postMerge: TabRow[] };
  else: SmartEntry[];
  badges: { today: number; decisions: number; merges: number; elseUnread: number };
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

/** A merge ask with nothing left for its human: hidden on screen, never archived. */
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
  const rest: SmartEntry[] = [];
  for (const e of all) {
    const s = e.signal;
    if (s && HIDDEN_KEY.test(s.key)) continue;
    if (s && DECISION_GROUPS.has(s.group)) decisions.push(e);
    else if (s?.group === "merge") {
      if (isPostMerge(e)) postMerge.push(e);
      else if (!isFinishedMergeAsk(e)) approval.push(e);
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
    today: { rows: todayRows, more: candidates.length - todayRows.length, alerts },
    decisions: decisionRows,
    merges: { approval: approvalRows, postMerge: postMergeRows },
    else: elseRows,
    badges: {
      today: todayRows.length,
      decisions: decisionRows.length,
      merges: approvalRows.length,
      elseUnread: elseRows.filter((e) => !e.item.read).length,
    },
  };
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
