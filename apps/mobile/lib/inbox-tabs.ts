/**
 * Inbox tabs on the phone (contango patch 45, owner 2026-11-13;
 * docs/contango/SMART-INBOX.md "Tabs" > "iOS").
 *
 * Pure helpers. The tab model itself (Today, Decisions, Merges, Everything
 * else, badges, Held cards kept off Today, finished merge asks hidden but
 * never archived) is core's `buildInboxTabs` (pure, zod only), fed with
 * mobile's own per-card fold (`buildSmartRows`), exactly as web feeds it
 * core's fold. What lives here is the phone's reading of a row: its one-line
 * why, its GitHub button and which entries a swipe reads or archives.
 */
import type { InboxItem } from "@multica/core/types";
import type { SignalDetails, SmartEntry } from "@multica/core/inbox/smart";
import {
  archiveTargets,
  buildInboxTabs,
  type InboxTab,
  type InboxTabsModel,
} from "@multica/core/inbox/smart-tabs";
import { buildSmartRows } from "@/lib/smart-inbox";

export type { InboxTab, InboxTabsModel, TabRow } from "@multica/core/inbox/smart-tabs";
export { ARCHIVE_CONFIRM_OVER, INBOX_TABS, cardHoursLost, cardRef } from "@multica/core/inbox/smart-tabs";

/** The five tabs from the inbox's raw list, as web builds them from its Smart rows. */
export function buildMobileInboxTabs(raw: InboxItem[], now: number): InboxTabsModel {
  return buildInboxTabs(buildSmartRows(raw), now);
}

/** The tab strip's badge: Today, Decisions and Merges only (owner: no badge on Squad or Everything else). */
export function tabBadge(model: InboxTabsModel, tab: InboxTab): number {
  if (tab === "today") return model.badges.today;
  if (tab === "decisions") return model.badges.decisions;
  if (tab === "merges") return model.badges.merges;
  return 0;
}

/**
 * The ask's "why" in one line: the brief's situation, else the merge risk,
 * else the body's first line that is not its "Why now" line (web's whyText).
 */
export function whyLine(entry: SmartEntry): string {
  const brief = entry.signal?.brief;
  if (brief?.situation) return brief.situation;
  if (entry.signal?.merge?.risk) return entry.signal.merge.risk;
  const lines = (entry.item.body ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^why now:/i.test(l));
  return lines[0] ?? "";
}

export interface GithubButton {
  /** The PR's review page (`<pr>/files`) or the link the feeder sent. */
  url: string;
  /** A post-merge review: "Review on GitHub", not "Approve on GitHub". */
  postMerge: boolean;
}

/**
 * A merge ask's GitHub button, as on web: the feeder's review url, else the
 * PR url, else the first PR link among its actions; a bare PR url gets
 * `/files` (owner: people look at the code before approving). Null for
 * anything that is not a merge ask, or a merge ask with no PR link.
 */
export function githubButton(s: SignalDetails | null | undefined): GithubButton | null {
  if (!s || s.group !== "merge") return null;
  const prUrl =
    s.merge?.reviewUrl ??
    s.merge?.url ??
    s.actions.find((a) => /\/pull\/\d+/.test(a.url))?.url;
  if (!prUrl || !/^https?:\/\//i.test(prUrl)) return null;
  const url = /\/pull\/\d+\/?$/.test(prUrl) ? `${prUrl.replace(/\/$/, "")}/files` : prUrl;
  return { url, postMerge: s.merge?.postMerge === true || s.key.startsWith("post-merge:") };
}

/**
 * The entry ids a row's swipe-to-archive sends: one per card (the server
 * archives every entry on a card), plus entries without a card. Web's
 * archiveRow does the same through core's archiveTargets.
 */
export function archiveIds(entries: SmartEntry[]): string[] {
  return archiveTargets(entries).map((e) => e.item.id);
}

/**
 * The entry ids a row's swipe-to-read sends: the unread ones, one per card
 * (mark-read is issue-wide on the server too), plus unread entries without a
 * card. Empty when everything is read already: the swipe is then a no-op.
 */
export function unreadIds(entries: SmartEntry[]): string[] {
  return archiveTargets(entries.filter((e) => !e.item.read)).map((e) => e.item.id);
}

/** "14:05 UTC" for today, "Nov 12 14:05 UTC" otherwise; "" for nothing. Absolute, as the owner asked for inbox times. */
export function utcTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  if (sameDay) return `${hm} UTC`;
  const month = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
  return `${month} ${d.getUTCDate()} ${hm} UTC`;
}

// --- View preference ---------------------------------------------------------

/** What a tabs-flagged user sees: the tabs (default) or the Smart sections. */
export type InboxTabsMode = "tabs" | "sections";

export function parseInboxTabsMode(stored: string | null | undefined): InboxTabsMode {
  return stored === "sections" ? "sections" : "tabs";
}
