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

export interface SignalDetails {
  key: string;
  group: SignalGroup;
  summary: string;
  actions: SignalAction[];
  rank: { priority: RankPriority; blocks: number; since: string | null };
}

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
}

export type SmartSectionId = "waiting" | Exclude<SignalGroup, "fyi"> | "fyi";

export interface SmartSection {
  id: SmartSectionId;
  entries: SmartEntry[];
}

const SECTION_ORDER: SmartSectionId[] = [
  "waiting",
  "merge",
  "decision",
  "access",
  "stalled",
  "blocking",
  "alert",
  "fyi",
];

/**
 * Splits active entries into sections: "waiting" (action_required signals and
 * entries addressed to you), then one per signal group, then FYI (fyi signals
 * and every other entry). Waiting and group sections rank by score; FYI is
 * newest first. Empty sections are dropped.
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
    };
    let id: SmartSectionId;
    if (isWaitingOnYou(item)) id = "waiting";
    else if (signal) id = signal.group;
    else id = "fyi";
    const list = buckets.get(id) ?? [];
    list.push(entry);
    buckets.set(id, list);
  }
  const sections: SmartSection[] = [];
  for (const id of SECTION_ORDER) {
    const entries = buckets.get(id);
    if (!entries?.length) continue;
    if (id === "fyi") {
      entries.sort((a, b) => Date.parse(b.item.created_at) - Date.parse(a.item.created_at));
    } else {
      entries.sort(
        (a, b) =>
          b.score - a.score ||
          Date.parse(b.item.created_at) - Date.parse(a.item.created_at),
      );
    }
    sections.push({ id, entries });
  }
  return sections;
}

// --- Opt-in -----------------------------------------------------------------

export const SMART_INBOX_URL_PARAM = "smart-inbox";

export type SmartInboxMode = "smart" | "classic";

/**
 * The stored mode after applying the URL param: "1" opts in (smart, or the
 * mode the user last toggled to), "0" opts out (null = not opted in). Any
 * other value keeps the stored mode.
 */
export function smartInboxModeFromParam(
  param: string | null,
  stored: SmartInboxMode | null,
): SmartInboxMode | null {
  if (param === "1") return stored ?? "smart";
  if (param === "0") return null;
  return stored;
}
