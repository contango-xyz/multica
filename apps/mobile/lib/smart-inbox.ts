/**
 * Smart inbox on mobile (contango, docs/contango/SMART-INBOX.md "iOS").
 *
 * Pure helpers over the same inbox entries the classic list shows. Ranking
 * and sections come from `@multica/core/inbox/smart` (pure, zod only). The
 * per-card fold mirrors `packages/core/inbox/smart-fold.ts`, re-implemented
 * here over mobile's own `deduplicateInboxItems` because core's version pulls
 * in core's Query factories (apps/mobile/AGENTS.md: no runtime imports of
 * those). Keep the two in step.
 */
import type { InboxItem } from "@multica/core/types";
import {
  buildSmartSections,
  isEndedSignal,
  signalDetails,
  type SmartEntry,
  type SmartSectionId,
} from "@multica/core/inbox/smart";
import { deduplicateInboxItems } from "@/lib/inbox-display";

const ADDRESSED = new Set<InboxItem["type"]>(["mentioned", "review_requested"]);

const newestFirst = (a: InboxItem, b: InboxItem) =>
  Date.parse(b.created_at) - Date.parse(a.created_at);

function foldInto(signal: InboxItem, entries: InboxItem[]): InboxItem {
  const sorted = [...entries].sort(newestFirst);
  const mention = sorted.find((e) => ADDRESSED.has(e.type));
  const commentId =
    mention?.details?.comment_id ??
    sorted.find((e) => e.details?.comment_id)?.details?.comment_id;
  return {
    ...signal,
    ...(mention ? { actor_type: mention.actor_type, actor_id: mention.actor_id } : {}),
    read: signal.read && entries.every((e) => e.read),
    details: {
      ...(signal.details ?? {}),
      ...(commentId ? { comment_id: commentId } : {}),
    },
  };
}

/**
 * One row per card. A card with an unresolved action signal (any group but
 * fyi) is ONE row: the signal, with the card's other entries folded in
 * (unread while any of them is, sender = the latest mention's). Other cards
 * are grouped per issue exactly as Classic. Mirrors core's buildSmartRows.
 *
 * Read and archive on the folded row's id act on the whole card: the server's
 * mark-read and archive are issue-wide, and mobile's mutations patch every
 * row of the issue.
 */
export function buildSmartRows(raw: InboxItem[]): InboxItem[] {
  // An ended signal (contango patch 46) is hidden, never archived; the card's
  // mentions then list as in Classic.
  const active = raw.filter((i) => !i.archived && !isEndedSignal(i));
  const signals = active.filter((i) => i.type === "signal");
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
    return entries ? foldInto(s, entries) : s;
  });
  return [...rows, ...deduplicateInboxItems(rest)];
}

export interface SmartListSection {
  id: SmartSectionId;
  /** SectionList's row array. */
  data: SmartEntry[];
}

/**
 * The phone layout of the web's SmartInboxPage: sections per signal group,
 * then "Mentions & reviews", then FYI (fyi signals and every other entry);
 * each ranked by score (FYI newest first), sections ordered by their top
 * entry's score, FYI last, empty ones dropped.
 */
export function buildSmartList(raw: InboxItem[], now: number): SmartListSection[] {
  return buildSmartSections(buildSmartRows(raw), now).map((s) => ({
    id: s.id,
    data: s.entries,
  }));
}

/** The time a signal row shows: the wait (rank.since), else the row's time. */
export function signalSince(item: InboxItem): string {
  return signalDetails(item)?.rank.since ?? item.created_at;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * The issue a signal action links to, when it is a card in this workspace:
 * `https://<web host>/<workspace>/issues/CTG-123` (also `/issue/` and a
 * uuid). Returns the identifier or id to open in-app, else null (open the
 * URL in the browser). Matching on the workspace slug plus an issue-shaped
 * last segment keeps GitHub links (`/org/repo/issues/12`) out.
 */
export function cardIdFromUrl(url: string, workspaceSlug: string | null): string | null {
  if (!workspaceSlug) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) return null;
  const [ws, kind, id] = parts as [string, string, string];
  if (ws !== workspaceSlug || (kind !== "issues" && kind !== "issue")) return null;
  const decoded = decodeURIComponent(id);
  return IDENTIFIER.test(decoded) || UUID.test(decoded) ? decoded : null;
}

/**
 * What to tell the reader when a one-tap reply fails. 404: the entry is no
 * longer theirs (gone); 409: the feeder changed or closed the ask between
 * render and tap, and the server's reason says which ("this reply is no
 * longer offered", "this ask is already closed"). Anything else: the
 * server's reason, else the generic text. The server sends its reason as
 * `{"error": "..."}`, which mobile's ApiError keeps in `body` (its message
 * falls back to "<status> <statusText>"). Returns an i18n key or a message.
 */
export function signalReplyError(err: unknown): { key: string } | { message: string } {
  const e = err && typeof err === "object" ? (err as { status?: unknown; body?: unknown }) : {};
  if (e.status === 404) return { key: "smart.reply.gone" };
  const body = e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : {};
  const reason =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : "";
  if (reason) return { message: reason };
  return { key: e.status === 409 ? "smart.reply.changed" : "smart.reply.failed" };
}
