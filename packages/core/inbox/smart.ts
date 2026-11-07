// Smart inbox (contango, docs/contango/SMART-INBOX.md): pure grouping and
// ranking over the same inbox entries the classic view shows. Ranking is done
// here, client-side, so entries age and climb without the server rewriting
// them.

import { z } from "zod";
import type { InboxItem } from "../types";

export const SIGNAL_GROUPS = [
  "merge",
  "decision",
  "access",
  "stalled",
  "blocking",
  "alert",
  "fyi",
] as const;
export type SignalGroup = (typeof SIGNAL_GROUPS)[number];

export type RankPriority = "urgent" | "high" | "medium" | "low" | "none";

export interface SignalAction {
  label: string;
  url: string;
}

/**
 * A one-tap answer (contango patch 18): posts `content` on the signal's own
 * issue as the reader, replying to `parent_comment_id` (the ask) when set.
 * Separate from `actions` so older clients, whose actions parser drops the
 * whole list on an entry without a url, never see it.
 */
export interface SignalReply {
  /** Position in the stored list: what the reply endpoint takes. */
  index: number;
  label: string;
  content: string;
  parent_comment_id: string | null;
}

export interface SignalDetails {
  key: string;
  group: SignalGroup;
  summary: string;
  actions: SignalAction[];
  /** One-tap answers (unusable entries dropped; each keeps its index). */
  replies: SignalReply[];
  rank: { priority: RankPriority; blocks: number; since: string | null };
}

const SignalReplySchema = z.object({
  label: z.string(),
  content: z.string(),
  parent_comment_id: z.string().nullish().transform((v) => v || null),
});

const SignalDetailsSchema = z.object({
  key: z.string().catch(""),
  group: z.enum(SIGNAL_GROUPS).catch("fyi"),
  summary: z.string().catch(""),
  actions: z
    .array(z.object({ label: z.string(), url: z.string() }).loose())
    .catch([])
    .transform((actions) =>
      actions
        .filter((a) => /^https?:\/\//i.test(a.url) && a.label.trim() !== "")
        .map((a) => ({ label: a.label, url: a.url })),
    ),
  replies: z
    .array(z.unknown())
    .catch([])
    .transform((raw) =>
      raw.flatMap((value, index): SignalReply[] => {
        const r = SignalReplySchema.safeParse(value);
        if (!r.success || r.data.label.trim() === "" || r.data.content.trim() === "") return [];
        return [{ index, label: r.data.label, content: r.data.content, parent_comment_id: r.data.parent_comment_id }];
      }),
    ),
  rank: z
    .object({
      priority: z.enum(["urgent", "high", "medium", "low", "none"]).catch("none"),
      blocks: z.number().int().nonnegative().catch(0),
      since: z.string().nullish().catch(null).transform((v) => v || null),
    })
    .catch({ priority: "none", blocks: 0, since: null }),
});

/** Parsed details of a `signal` entry; null for any other entry type. */
export function signalDetails(item: InboxItem): SignalDetails | null {
  if (item.type !== "signal") return null;
  const parsed = SignalDetailsSchema.safeParse(item.details ?? {});
  return parsed.success ? parsed.data : null;
}

export const PRIORITY_WEIGHT: Record<RankPriority, number> = {
  urgent: 8,
  high: 4,
  medium: 2,
  low: 1,
  none: 1,
};

// Entry kinds addressed to the reader personally.
const ADDRESSED_TYPES = new Set<InboxItem["type"]>(["mentioned", "review_requested"]);

export interface RankInput {
  priority: RankPriority;
  blocks: number;
  /** ISO time the wait started. */
  since: string;
}

export function rankInput(item: InboxItem): RankInput {
  const signal = signalDetails(item);
  if (signal) {
    return {
      priority: signal.rank.priority,
      blocks: signal.rank.blocks,
      since: signal.rank.since ?? item.created_at,
    };
  }
  const p = item.issue_priority;
  return {
    priority: p && p in PRIORITY_WEIGHT ? (p as RankPriority) : "none",
    blocks: 0,
    since: item.created_at,
  };
}

/** Age in hours, floored at 6 minutes so a brand-new entry still ranks. */
export function ageHours(since: string, now: number): number {
  const t = Date.parse(since);
  if (Number.isNaN(t)) return 0.1;
  return Math.max(0.1, (now - t) / 3_600_000);
}

/** priority weight × (1 + blocks) × age in hours. */
export function rankScore(input: RankInput, now: number): number {
  return PRIORITY_WEIGHT[input.priority] * (1 + input.blocks) * ageHours(input.since, now);
}

/** The pieces of the "why it ranks here" line; the view localizes them. */
export interface RankReason {
  priority: RankPriority;
  blocks: number;
  hours: number;
}

export function rankReason(input: RankInput, now: number): RankReason {
  return {
    priority: input.priority,
    blocks: input.blocks,
    hours: Math.floor(ageHours(input.since, now)),
  };
}

export function isWaitingOnYou(item: InboxItem): boolean {
  if (item.type === "signal") return item.severity === "action_required";
  return ADDRESSED_TYPES.has(item.type);
}

export interface SmartEntry {
  item: InboxItem;
  signal: SignalDetails | null;
  score: number;
  reason: RankReason;
  /** Waits on the reader: an action_required signal, a mention or a review request. */
  needsYou: boolean;
  /** Hours since the wait started (rank.since, else created_at). */
  waitedHours: number;
}

export type SmartSectionId = Exclude<SignalGroup, "fyi"> | "mentions" | "fyi";

export interface SmartSection {
  id: SmartSectionId;
  /** Ranked; FYI is newest first. */
  entries: SmartEntry[];
}

// Tie-break between sections whose top entries score the same.
const SECTION_ORDER: SmartSectionId[] = [
  "merge",
  "decision",
  "access",
  "stalled",
  "blocking",
  "alert",
  "mentions",
  "fyi",
];

function sectionFor(item: InboxItem, signal: SignalDetails | null): SmartSectionId {
  if (signal) return signal.group;
  if (ADDRESSED_TYPES.has(item.type)) return "mentions";
  return "fyi";
}

const byScore = (a: SmartEntry, b: SmartEntry) =>
  b.score - a.score || Date.parse(b.item.created_at) - Date.parse(a.item.created_at);
const byNewest = (a: SmartEntry, b: SmartEntry) =>
  Date.parse(b.item.created_at) - Date.parse(a.item.created_at);

/**
 * Splits active entries into one section per signal group, plus "mentions"
 * (mentions and review requests) and FYI (fyi signals and every other entry).
 * Each section ranks by score (FYI: newest first); sections are ordered by
 * their top entry's score, FYI always last. Empty sections are dropped.
 *
 * Signals are kept one row each; other entries are expected to be deduplicated
 * per issue by the caller, as the classic list does.
 */
export function buildSmartSections(items: InboxItem[], now: number): SmartSection[] {
  const buckets = new Map<SmartSectionId, SmartEntry[]>();
  for (const item of items) {
    if (item.archived) continue;
    const signal = signalDetails(item);
    const input = rankInput(item);
    const entry: SmartEntry = {
      item,
      signal,
      score: rankScore(input, now),
      reason: rankReason(input, now),
      needsYou: isWaitingOnYou(item),
      waitedHours: ageHours(input.since, now),
    };
    const id = sectionFor(item, signal);
    const list = buckets.get(id) ?? [];
    list.push(entry);
    buckets.set(id, list);
  }
  const ranked: SmartSection[] = [];
  let fyi: SmartSection | null = null;
  for (const id of SECTION_ORDER) {
    const entries = buckets.get(id);
    if (!entries?.length) continue;
    if (id === "fyi") {
      fyi = { id, entries: entries.sort(byNewest) };
    } else {
      ranked.push({ id, entries: entries.sort(byScore) });
    }
  }
  // Stable sort: equal top scores keep SECTION_ORDER.
  ranked.sort((a, b) => b.entries[0]!.score - a.entries[0]!.score);
  return fyi ? [...ranked, fyi] : ranked;
}

// --- Dashboard ---------------------------------------------------------------

/** A card: its issue, else the entry itself. The dashboard counts cards. */
export function cardKey(item: Pick<InboxItem, "id" | "issue_id">): string {
  return item.issue_id ?? item.id;
}

/**
 * The top `n` cards waiting on the reader, by their best entry's rank score
 * (ties: longer wait first).
 */
export function doThisFirst(sections: SmartSection[], n = 3): SmartEntry[] {
  const seen = new Set<string>();
  return sections
    .flatMap((section) => section.entries)
    .filter((entry) => entry.needsYou)
    .sort((a, b) => b.score - a.score || b.waitedHours - a.waitedHours)
    .filter((entry) => {
      const key = cardKey(entry.item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, n);
}

export interface SmartCounters {
  /** Cards waiting on the reader. */
  waiting: number;
  /** Waiting cards per section, in display order, zero counts left out. */
  byGroup: Array<{ id: SmartSectionId; count: number }>;
  /** The longest wait among waiting entries, in hours; null when none wait. */
  oldestWaitHours: number | null;
  /** Urgent cards waiting on the reader. */
  urgent: number;
}

const COUNTER_ORDER: SmartSectionId[] = [
  "merge",
  "decision",
  "access",
  "stalled",
  "blocking",
  "alert",
  "mentions",
  "fyi",
];

export function smartCounters(sections: SmartSection[]): SmartCounters {
  const waiting = sections.flatMap((s) =>
    s.entries.filter((e) => e.needsYou).map((e) => ({ id: s.id, e, card: cardKey(e.item) })),
  );
  const cards = (list: typeof waiting) => new Set(list.map((w) => w.card)).size;
  const byGroup = COUNTER_ORDER.map((id) => ({
    id,
    count: cards(waiting.filter((w) => w.id === id)),
  })).filter((g) => g.count > 0);
  return {
    waiting: cards(waiting),
    byGroup,
    oldestWaitHours: waiting.length ? Math.max(...waiting.map((w) => w.e.waitedHours)) : null,
    urgent: cards(waiting.filter((w) => w.e.reason.priority === "urgent")),
  };
}

export interface SquadHealth {
  stalled: number;
  blocking: number;
  /** Alert signals (e.g. "main red", "CD red"); shown as red chips by title. */
  alerts: SmartEntry[];
}

/**
 * Squad health from what is already in the reader's inbox: their stalled,
 * blocking and alert signals. No other source is consulted.
 */
export function squadHealth(sections: SmartSection[]): SquadHealth {
  const of = (id: SmartSectionId) =>
    sections.find((s) => s.id === id)?.entries.filter((e) => e.signal) ?? [];
  return { stalled: of("stalled").length, blocking: of("blocking").length, alerts: of("alert") };
}

export type AgeTint = "none" | "amber" | "red";

/** Amber after 4 h, red after 24 h; urgent entries after 1 h and 4 h. */
export function ageTint(entry: Pick<SmartEntry, "waitedHours" | "reason">): AgeTint {
  const [amber, red] = entry.reason.priority === "urgent" ? [1, 4] : [4, 24];
  if (entry.waitedHours > red) return "red";
  if (entry.waitedHours > amber) return "amber";
  return "none";
}

// --- Opt-in -----------------------------------------------------------------

export const SMART_INBOX_URL_PARAM = "smart-inbox";

export type SmartInboxMode = "smart" | "classic";

/**
 * The mode to show for a user the server has the smart inbox on for. Smart is
 * the default (owner 2026-11-07: rolled out to every member, web and desktop);
 * the toggle's choice is remembered. "1" keeps the remembered mode (smart if
 * none), "0" picks classic; any other value keeps the remembered mode.
 */
export function smartInboxModeFromParam(
  param: string | null,
  stored: SmartInboxMode | null,
): SmartInboxMode {
  if (param === "0") return "classic";
  return stored ?? "smart";
}
