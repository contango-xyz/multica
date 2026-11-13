"use client";

// Inbox tabs (contango patch 43, owner 2026-11-12; docs/contango/SMART-INBOX.md
// "Tabs"): the smart list as five tabs, in the list pane of the two-pane
// inbox. Today (the top 5 asks), Decisions (one row per card, tap for the
// plain-words brief), Merges (one card per PR; approving happens on GitHub),
// Squad (a read-only screen) and Everything else. Selecting a row opens the
// card on the right, as in Smart. Rows and ranking: core's smart-tabs.ts.
// Archiving is Smart's: every row has the hover archive icon (the compact menu
// on touch, the row menu on right-click; `e` archives the open card), and each
// list's "…" menu marks read or archives all of it, asking first above 3 cards.

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, CheckCheck, ChevronRight, ExternalLink, MoreHorizontal } from "@multica/ui/icons";
import { inboxRowKey } from "@multica/core/inbox/filter-store";
import { inboxSquadOptions } from "@multica/core/inbox/queries";
import { ageTint, type SmartEntry } from "@multica/core/inbox/smart";
import {
  ARCHIVE_CONFIRM_OVER,
  archiveTargets,
  buildInboxTabs,
  cardHoursLost,
  cardRef,
  INBOX_TABS,
  rowEntries,
  type InboxTab,
  type TabRow,
} from "@multica/core/inbox/smart-tabs";
import { SQUAD_BUCKETS, type InboxSquad } from "@multica/core/inbox/squad";
import type { InboxItem } from "@multica/core/types";
import { IconButton } from "@multica/ui/components/common/icon-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { DeferredTooltip } from "../../common/deferred-tooltip";
import { useInboxContextMenu } from "./inbox-context-menu";
import { getInboxDisplayTitle } from "./inbox-display";
import { InboxListItem } from "./inbox-list-item";
import { InboxRowMenu } from "./inbox-row-menu";
import { SignalReplyButton } from "./signal-reply-button";

/** What a tab's rows can do besides open: Smart's row and section actions. */
interface TabArchive {
  /** One card: Smart's per-row archive (the server takes the card's other entries with it). */
  onArchive: (id: string) => void;
  /** Several cards: Smart's per-section archive, one toast. */
  onArchiveEntries: (entries: SmartEntry[]) => void;
  onMarkEntriesRead: (entries: SmartEntry[]) => void;
}

/** Archive what a row stands for: its card, plus any folded entry on another card. */
function archiveRow(row: TabRow, actions: TabArchive) {
  const targets = archiveTargets(row.entries);
  if (targets.length === 1) actions.onArchive(targets[0]!.item.id);
  else if (targets.length > 1) actions.onArchiveEntries(targets);
}

/**
 * A row's archive controls, as on Smart's rows: the archive icon shows on hover
 * or keyboard focus (pointer devices), the compact menu stands in on touch.
 * The row needs the `group` class.
 */
function RowArchive({ item, onArchive }: { item: InboxItem; onArchive: () => void }) {
  const { t } = useT("inbox");
  const label = t(($) => $.list.archive_tooltip);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <DeferredTooltip
        content={label}
        trigger={
          <button
            type="button"
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
            className="hidden rounded-xs p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring [@media(hover:hover)]:group-hover:inline-flex [@media(hover:hover)]:group-focus-within:inline-flex"
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        }
      />
      <InboxRowMenu item={item} view="inbox" />
    </div>
  );
}

/** Right-click on a card opens the list's shared row menu, as on Smart's rows. */
function useRowContextMenu(item: InboxItem) {
  const open = useInboxContextMenu();
  return open ? (e: MouseEvent) => open(item, e) : undefined;
}

/**
 * A list's "…" menu, as on Smart's section headers: mark read, archive all.
 * Archiving more than ARCHIVE_CONFIRM_OVER cards asks first.
 */
function ListActions({ entries, actions }: { entries: SmartEntry[]; actions: TabArchive }) {
  const { t } = useT("inbox");
  const [confirming, setConfirming] = useState(false);
  const targets = archiveTargets(entries);
  if (targets.length === 0) return null;
  const archiveAll = () => {
    if (targets.length > ARCHIVE_CONFIRM_OVER) setConfirming(true);
    else actions.onArchiveEntries(targets);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton
              label={t(($) => $.smart.tabs.tab_actions)}
              tooltipSide="bottom"
              size="icon-xs"
              className="shrink-0 text-muted-foreground"
            />
          }
        >
          <MoreHorizontal className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          <DropdownMenuItem onClick={() => actions.onMarkEntriesRead(entries)}>
            <CheckCheck className="h-4 w-4" />
            {t(($) => $.smart.tabs.mark_tab_read)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={archiveAll}>
            <Archive className="h-4 w-4" />
            {t(($) => $.smart.tabs.archive_tab)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.smart.tabs.confirm_archive_title, { count: targets.length })}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.smart.tabs.confirm_archive_description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.smart.reply.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                actions.onArchiveEntries(targets);
              }}
            >
              {t(($) => $.smart.tabs.confirm_archive)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A list's heading with its "…" menu on the right. */
function ListHeader({ children, entries, actions }: { children: ReactNode; entries: SmartEntry[]; actions: TabArchive }) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <ListActions entries={entries} actions={actions} />
    </div>
  );
}

const TAB_STORAGE_KEY = "multica:inbox-tab";

function readStoredTab(): InboxTab {
  try {
    const v = globalThis.localStorage?.getItem(TAB_STORAGE_KEY);
    return (INBOX_TABS as readonly string[]).includes(v ?? "") ? (v as InboxTab) : "today";
  } catch {
    return "today";
  }
}

function writeStoredTab(tab: InboxTab) {
  try {
    globalThis.localStorage?.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // Storage blocked: the tab lasts this visit.
  }
}

/** "12 Nov 07:51 UTC": absolute, the way asks are written. */
export function utcTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${date} ${time} UTC`;
}

function Pill({ tone = "default", children }: { tone?: "default" | "accent" | "ok" | "warn" | "bad"; children: ReactNode }) {
  const toneClass = {
    default: "bg-muted text-foreground",
    accent: "bg-primary/10 font-semibold text-primary",
    ok: "bg-success/15 text-success",
    warn: "bg-warning/15 text-foreground",
    bad: "bg-destructive/10 text-destructive",
  }[tone];
  return <span className={cn("rounded px-1.5 py-0.5 text-caption tabular-nums", toneClass)}>{children}</span>;
}

function Card({
  children,
  className,
  onContextMenu,
  rowKey,
}: {
  children: ReactNode;
  className?: string;
  onContextMenu?: (e: MouseEvent) => void;
  rowKey?: string;
}) {
  return (
    <div
      className={cn("grid min-w-0 gap-2 rounded-lg border bg-background p-3", className)}
      onContextMenu={onContextMenu}
      data-inbox-row-key={rowKey}
    >
      {children}
    </div>
  );
}

function Kind({ children }: { children: ReactNode }) {
  return <span className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">{children}</span>;
}

function Lede({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-title-sm font-semibold text-balance">{title}</p>
      {sub && <p className="text-caption text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-body text-muted-foreground">{children}</p>;
}

function ExternalButton({ href, children, variant = "default" }: { href: string; children: ReactNode; variant?: "default" | "outline" }) {
  return (
    <Button
      size="sm"
      variant={variant}
      className="min-h-10 lg:min-h-0"
      render={<a href={href} target="_blank" rel="noopener noreferrer" />}
      nativeButton={false}
    >
      <span className="truncate">{children}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
    </Button>
  );
}

/** The chips under a row's title: card, frees N, high, card-hours, CI, asked at. */
function RowMeta({ entry, folded = 0, showLost = false }: { entry: SmartEntry; folded?: number; showLost?: boolean }) {
  const { t } = useT("inbox");
  const ref = cardRef(entry.item);
  const blocks = entry.signal?.rank.blocks ?? 0;
  const lost = cardHoursLost(entry);
  const prio = entry.reason.priority;
  const merge = entry.signal?.merge;
  const tint = ageTint(entry);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
      {ref && <span className="font-mono">{ref}</span>}
      {blocks > 0 && <Pill tone="accent">{t(($) => $.smart.tabs.frees, { count: blocks })}</Pill>}
      {(prio === "urgent" || prio === "high") && (
        <Pill tone={prio === "urgent" ? "bad" : "warn"}>{t(($) => $.smart.priority[prio])}</Pill>
      )}
      {showLost && lost >= 1 && <Pill tone="warn">{t(($) => $.smart.tabs.card_hours, { hours: Math.round(lost) })}</Pill>}
      {merge && !merge.postMerge && merge.ci !== "unknown" && (
        <Pill tone={merge.ci === "green" ? "ok" : merge.ci === "red" ? "bad" : "warn"}>{t(($) => $.smart.tabs.ci[merge.ci])}</Pill>
      )}
      {folded > 1 && <Pill>{t(($) => $.smart.tabs.folded, { count: folded })}</Pill>}
      <span className={cn(tint === "red" && "text-destructive", tint === "amber" && "text-foreground")}>
        {t(($) => $.smart.tabs.asked, { time: utcTime(entry.signal?.rank.since ?? entry.item.created_at) })}
      </span>
    </div>
  );
}

/** The ask's "why": the brief's situation, else the body without its "Why now" line. */
function whyText(entry: SmartEntry): string {
  const brief = entry.signal?.brief;
  if (brief?.situation) return brief.situation;
  if (entry.signal?.merge?.risk) return entry.signal.merge.risk;
  const lines = (entry.item.body ?? "").split("\n").filter((l) => l.trim() && !/^why now:/i.test(l.trim()));
  return lines[0] ?? "";
}

function OpenCard({ entry, onSelect }: { entry: SmartEntry; onSelect: (item: InboxItem) => void }) {
  const { t } = useT("inbox");
  if (!entry.item.issue_id) return null;
  return (
    <Button size="sm" variant="ghost" className="min-h-10 text-primary lg:min-h-0" onClick={() => onSelect(entry.item)}>
      {t(($) => $.smart.tabs.open_card)}
    </Button>
  );
}

/** The one-tap answers, or for a merge the GitHub button, then Open card. */
function RowActions({
  entry,
  onSelect,
  onArchive,
}: {
  entry: SmartEntry;
  onSelect: (item: InboxItem) => void;
  /** Adds an Archive button after Open card. */
  onArchive?: () => void;
}) {
  const { t } = useT("inbox");
  const s = entry.signal;
  const replies = entry.item.issue_id ? (s?.replies ?? []) : [];
  const merge = s?.group === "merge" ? s : null;
  const prUrl = merge?.merge?.reviewUrl ?? merge?.merge?.url ?? merge?.actions.find((a) => /\/pull\/\d+/.test(a.url))?.url;
  const reviewUrl = prUrl && /\/pull\/\d+$/.test(prUrl) ? `${prUrl}/files` : prUrl;
  const postMerge = merge?.merge?.postMerge || merge?.key.startsWith("post-merge:");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {merge && reviewUrl ? (
        <ExternalButton href={reviewUrl} variant={postMerge ? "outline" : "default"}>
          {postMerge ? t(($) => $.smart.tabs.review_on_github) : t(($) => $.smart.tabs.approve_on_github)}
        </ExternalButton>
      ) : (
        replies.map((reply, i) => (
          <SignalReplyButton key={reply.index} item={entry.item} reply={reply} size="sm" variant={i === 0 ? "default" : "outline"} />
        ))
      )}
      {!merge &&
        replies.length === 0 &&
        s?.actions
          .filter((a) => !/\/issues\/[A-Z]+-\d+$/.test(a.url))
          .slice(0, 1)
          .map((a) => (
            <ExternalButton key={a.url} href={a.url} variant="outline">
              {a.label}
            </ExternalButton>
          ))}
      <OpenCard entry={entry} onSelect={onSelect} />
      {onArchive && (
        <Button size="sm" variant="ghost" className="min-h-10 text-muted-foreground lg:min-h-0" onClick={onArchive}>
          <Archive className="h-3.5 w-3.5" />
          {t(($) => $.smart.tabs.archive)}
        </Button>
      )}
    </div>
  );
}

// --- Today -------------------------------------------------------------------

function TodayCard({ row, rank, onSelect, actions }: { row: TabRow; rank: number; onSelect: (item: InboxItem) => void; actions: TabArchive }) {
  const onContextMenu = useRowContextMenu(row.entry.item);
  return (
    <Card className="group" onContextMenu={onContextMenu} rowKey={inboxRowKey(row.entry.item)}>
      <div className="grid grid-cols-[2rem_1fr] items-start gap-2.5">
        <span aria-hidden className="grid size-7 place-items-center rounded-full bg-primary/10 font-semibold tabular-nums text-primary">
          {rank}
        </span>
        <div className="grid min-w-0 gap-1.5">
          <div className="flex min-w-0 items-start gap-2">
            <button
              type="button"
              onClick={() => onSelect(row.entry.item)}
              className="min-w-0 flex-1 break-words text-left text-body font-semibold hover:underline"
            >
              <span className="sr-only">{rank}. </span>
              {getInboxDisplayTitle(row.entry.item)}
            </button>
            <RowArchive item={row.entry.item} onArchive={() => archiveRow(row, actions)} />
          </div>
          <RowMeta entry={row.entry} showLost />
          {whyText(row.entry) && <p className="line-clamp-3 break-words text-body">{whyText(row.entry)}</p>}
          <RowActions entry={row.entry} onSelect={onSelect} />
        </div>
      </div>
    </Card>
  );
}

/**
 * Today's red banner for an alert signal (main red: `fix-main:…`). Archives as
 * every other row does (contango patch 47; owner 2026-11-13: a "CD is red"
 * banner had no archive at all): hover icon, compact menu on touch, right-click.
 */
function AlertCard({ entry, onSelect, actions }: { entry: SmartEntry; onSelect: (item: InboxItem) => void; actions: TabArchive }) {
  const { t } = useT("inbox");
  const onContextMenu = useRowContextMenu(entry.item);
  return (
    <div
      role="status"
      className="group grid min-w-0 gap-1 rounded-lg bg-destructive/10 px-3 py-2.5"
      onContextMenu={onContextMenu}
      data-inbox-row-key={inboxRowKey(entry.item)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1">
          <Kind>{t(($) => $.smart.tabs.alert)}</Kind>
        </span>
        <RowArchive item={entry.item} onArchive={() => actions.onArchive(entry.item.id)} />
      </div>
      <button type="button" onClick={() => onSelect(entry.item)} className="min-w-0 break-words text-left text-body hover:underline">
        <b className="text-destructive">{getInboxDisplayTitle(entry.item)}</b>
        {entry.signal?.summary ? <span className="text-muted-foreground"> · {entry.signal.summary}</span> : null}
      </button>
    </div>
  );
}

function TodayPanel({
  model,
  onSelect,
  onGo,
  actions,
}: {
  model: ReturnType<typeof buildInboxTabs>;
  onSelect: (item: InboxItem) => void;
  onGo: (tab: InboxTab) => void;
  actions: TabArchive;
}) {
  const { t } = useT("inbox");
  const { rows, more, alerts } = model.today;
  return (
    <>
      {alerts.map((a) => (
        <AlertCard key={a.item.id} entry={a} onSelect={onSelect} actions={actions} />
      ))}
      {rows.length === 0 ? (
        <Empty>{t(($) => $.smart.tabs.today_empty)}</Empty>
      ) : (
        <>
          <ListHeader entries={rowEntries(rows)} actions={actions}>
            <Lede title={t(($) => $.smart.tabs.today_lede)} sub={t(($) => $.smart.tabs.today_sub)} />
          </ListHeader>
          {rows.map((row, i) => (
            <TodayCard key={row.entry.item.id} row={row} rank={i + 1} onSelect={onSelect} actions={actions} />
          ))}
          {more > 0 && (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.smart.tabs.today_more, { count: more })}{" "}
              <button type="button" className="text-primary underline" onClick={() => onGo("decisions")}>
                {t(($) => $.smart.tabs.decisions)}
              </button>
              {" · "}
              <button type="button" className="text-primary underline" onClick={() => onGo("merges")}>
                {t(($) => $.smart.tabs.merges)}
              </button>
            </p>
          )}
        </>
      )}
    </>
  );
}

// --- Decisions ---------------------------------------------------------------

function BriefBody({ entry }: { entry: SmartEntry }) {
  const { t } = useT("inbox");
  const brief = entry.signal?.brief;
  if (!brief) {
    return entry.item.body ? <p className="whitespace-pre-wrap break-words text-body">{entry.item.body}</p> : null;
  }
  const field = (label: string, value: ReactNode, className?: string) => (
    <div className={className}>
      <dt className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 max-w-prose whitespace-pre-wrap break-words text-body">{value}</dd>
    </div>
  );
  return (
    <dl className="grid gap-2.5">
      {brief.situation && field(t(($) => $.smart.tabs.going), brief.situation)}
      {brief.recommend && field(t(($) => $.smart.tabs.recommend), brief.recommend)}
      {field(
        t(($) => $.smart.tabs.if_silent),
        brief.default || t(($) => $.smart.tabs.nothing_happens),
        cn("border-l-[3px] pl-2.5", brief.defaultApplies ? "border-warning" : "border-border"),
      )}
    </dl>
  );
}

function DecisionRow({
  row,
  open,
  onToggle,
  onSelect,
  actions,
}: {
  row: TabRow;
  open: boolean;
  onToggle: () => void;
  onSelect: (item: InboxItem) => void;
  actions: TabArchive;
}) {
  const onContextMenu = useRowContextMenu(row.entry.item);
  const archive = () => archiveRow(row, actions);
  return (
    <div
      className="group min-w-0 rounded-lg border bg-background"
      data-inbox-row-key={inboxRowKey(row.entry.item)}
      onContextMenu={onContextMenu}
    >
      <div className="flex min-w-0 items-start">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="grid min-w-0 flex-1 grid-cols-[1fr_auto] items-start gap-2 py-2.5 pl-3 pr-1 text-left"
        >
          <span className="grid min-w-0 gap-1">
            <span className={cn("break-words text-body", !row.entry.item.read && "font-semibold")}>
              {getInboxDisplayTitle(row.entry.item)}
            </span>
            <RowMeta entry={row.entry} folded={row.entries.length} />
          </span>
          <ChevronRight className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        </button>
        <div className="py-2 pr-2">
          <RowArchive item={row.entry.item} onArchive={archive} />
        </div>
      </div>
      {open && (
        <div className="grid gap-3 border-t px-3 py-3">
          <BriefBody entry={row.entry} />
          <RowActions entry={row.entry} onSelect={onSelect} onArchive={archive} />
        </div>
      )}
    </div>
  );
}

function DecisionsPanel({ rows, onSelect, actions }: { rows: TabRow[]; onSelect: (item: InboxItem) => void; actions: TabArchive }) {
  const { t } = useT("inbox");
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return <Empty>{t(($) => $.smart.tabs.decisions_empty)}</Empty>;
  return (
    <>
      <ListHeader entries={rowEntries(rows)} actions={actions}>
        <Lede title={t(($) => $.smart.tabs.decisions_lede, { count: rows.length })} sub={t(($) => $.smart.tabs.decisions_sub)} />
      </ListHeader>
      {rows.map((row) => (
        <DecisionRow
          key={row.entry.item.id}
          row={row}
          open={open === row.entry.item.id}
          onToggle={() => setOpen((cur) => (cur === row.entry.item.id ? null : row.entry.item.id))}
          onSelect={onSelect}
          actions={actions}
        />
      ))}
    </>
  );
}

// --- Merges ------------------------------------------------------------------

function MergeCard({ row, onSelect, actions }: { row: TabRow; onSelect: (item: InboxItem) => void; actions: TabArchive }) {
  const { t } = useT("inbox");
  const onContextMenu = useRowContextMenu(row.entry.item);
  const m = row.entry.signal?.merge;
  const postMerge = m?.postMerge || row.entry.signal?.key.startsWith("post-merge:");
  const fact = (label: string, value: ReactNode) => (
    <div className="min-w-0 text-caption">
      <span className="block text-micro uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="break-words">{value}</span>
    </div>
  );
  return (
    <Card className="group" onContextMenu={onContextMenu} rowKey={inboxRowKey(row.entry.item)}>
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          onClick={() => onSelect(row.entry.item)}
          className="min-w-0 flex-1 break-words text-left text-body font-semibold hover:underline"
        >
          {getInboxDisplayTitle(row.entry.item)}
        </button>
        <RowArchive item={row.entry.item} onArchive={() => archiveRow(row, actions)} />
      </div>
      <RowMeta entry={row.entry} />
      {postMerge ? (
        m?.mergedAt ? <p className="text-caption text-muted-foreground">{t(($) => $.smart.tabs.merged_at, { time: utcTime(m.mergedAt) })}</p> : null
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
          {fact(t(($) => $.smart.tabs.why_human), m?.risk || "—")}
          {fact(t(($) => $.smart.tabs.agent_review), m?.review || "—")}
          {m && m.lines > 0 && fact(t(($) => $.smart.tabs.size), t(($) => $.smart.tabs.size_value, { lines: m.lines, files: m.files }))}
        </div>
      )}
      <RowActions entry={row.entry} onSelect={onSelect} />
    </Card>
  );
}

function MergesPanel({
  model,
  onSelect,
  actions,
}: {
  model: ReturnType<typeof buildInboxTabs>;
  onSelect: (item: InboxItem) => void;
  actions: TabArchive;
}) {
  const { t } = useT("inbox");
  const { approval, postMerge } = model.merges;
  return (
    <>
      {approval.length === 0 ? (
        <Empty>{t(($) => $.smart.tabs.merges_empty)}</Empty>
      ) : (
        <>
          <ListHeader entries={rowEntries(approval)} actions={actions}>
            <Lede title={t(($) => $.smart.tabs.merges_lede, { count: approval.length })} sub={t(($) => $.smart.tabs.merges_sub)} />
          </ListHeader>
          {approval.map((row) => (
            <MergeCard key={row.entry.item.id} row={row} onSelect={onSelect} actions={actions} />
          ))}
        </>
      )}
      {postMerge.length > 0 && (
        <>
          <ListHeader entries={rowEntries(postMerge)} actions={actions}>
            <p className="mt-2 text-micro font-semibold uppercase tracking-wide text-muted-foreground">{t(($) => $.smart.tabs.merged_without_you)}</p>
          </ListHeader>
          {postMerge.map((row) => (
            <MergeCard key={row.entry.item.id} row={row} onSelect={onSelect} actions={actions} />
          ))}
        </>
      )}
    </>
  );
}

// --- Squad -------------------------------------------------------------------

const BUCKET_COLOR: Record<string, string> = {
  people: "bg-warning",
  blocked: "bg-destructive",
  machines: "bg-primary",
  working: "bg-success",
  nobody: "bg-muted-foreground",
  subs: "bg-info",
  seats: "bg-info",
};

function SquadPanel({ wsId }: { wsId: string }) {
  const { t } = useT("inbox");
  const { data, isLoading, isError } = useQuery(inboxSquadOptions(wsId));
  if (isLoading) return null;
  if (isError || !data) return <Empty>{t(($) => $.smart.tabs.squad_empty)}</Empty>;
  return <SquadScreen data={data} />;
}

export function SquadScreen({ data }: { data: InboxSquad }) {
  const { t } = useT("inbox");
  const snap = data.snapshot;
  const buckets = SQUAD_BUCKETS.map((id) => ({ id, share: snap?.buckets[id]?.share ?? 0 })).filter((b) => b.share > 0);
  const people = [...(snap?.people ?? [])].sort((a, b) => b.hours - a.hours).filter((p) => p.hours > 0);
  const maxHours = Math.max(1, ...people.map((p) => p.hours));
  const holds = [...(snap?.people_via_blocked ?? [])].sort((a, b) => b.hours - a.hours).slice(0, 5);
  const load = [...data.inbox_load].sort((a, b) => b.decisions + b.merges - (a.decisions + a.merges));
  const pct = (share: number) => `${Math.round(share * 100)}%`;
  const th = "px-2 py-1.5 text-right text-micro font-semibold uppercase tracking-wide text-muted-foreground first:text-left";
  const td = "whitespace-nowrap border-t px-2 py-1.5 text-right tabular-nums first:text-left";
  return (
    <>
      {snap ? (
        <>
          <Lede
            title={t(($) => $.smart.tabs.squad_lede)}
            sub={t(($) => $.smart.tabs.squad_sub, { hours: Math.round(snap.window_hours ?? 24), time: utcTime(snap.generated_at) })}
          />
          <Card>
            <Kind>{t(($) => $.smart.tabs.where_time_goes)}</Kind>
            <div className="flex h-6 overflow-hidden rounded-md" role="img" aria-label={buckets.map((b) => `${t(($) => $.smart.tabs.buckets[b.id])} ${pct(b.share)}`).join(", ")}>
              {buckets.map((b) => (
                <div key={b.id} className={BUCKET_COLOR[b.id]} style={{ width: `${b.share * 100}%` }} />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
              {buckets.map((b) => (
                <span key={b.id} className="inline-flex items-center gap-1.5">
                  <i aria-hidden className={cn("inline-block size-2.5 rounded-sm", BUCKET_COLOR[b.id])} />
                  {t(($) => $.smart.tabs.buckets[b.id])} {pct(b.share)}
                </span>
              ))}
            </div>
          </Card>
          {people.length > 0 && (
            <Card>
              <Kind>{t(($) => $.smart.tabs.who_holds)}</Kind>
              <p className="text-caption text-muted-foreground">{t(($) => $.smart.tabs.who_holds_sub)}</p>
              <div className="grid gap-2">
                {people.map((p) => (
                  <div key={p.name} className="grid grid-cols-[minmax(0,8rem)_1fr_3.5rem] items-center gap-2 text-caption">
                    <span className="truncate">{p.name}</span>
                    <div className="h-3 overflow-hidden rounded bg-muted">
                      <div className="h-full bg-warning" style={{ width: `${(p.hours / maxHours) * 100}%` }} />
                    </div>
                    <span className="text-right tabular-nums text-muted-foreground">{t(($) => $.smart.tabs.hours_value, { hours: Math.round(p.hours) })}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {holds.length > 0 && (
            <Card>
              <Kind>{t(($) => $.smart.tabs.biggest_holds)}</Kind>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-caption">
                  <thead>
                    <tr>
                      <th className={th}>{t(($) => $.smart.tabs.col_card)}</th>
                      <th className={th}>{t(($) => $.smart.tabs.col_waiting_on)}</th>
                      <th className={th}>{t(($) => $.smart.tabs.col_card_hours)}</th>
                      <th className={th}>{t(($) => $.smart.tabs.col_behind)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holds.map((h) => (
                      <tr key={h.key}>
                        <td className={cn(td, "max-w-[14rem] truncate")} title={h.title}>
                          <span className="font-mono text-muted-foreground">{h.key}</span> {h.title}
                        </td>
                        <td className={td}>{h.human}</td>
                        <td className={td}>{h.hours.toFixed(1)}</td>
                        <td className={td}>{h.cards.length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      ) : (
        <Empty>{t(($) => $.smart.tabs.squad_empty)}</Empty>
      )}
      {load.length > 0 && (
        <Card>
          <Kind>{t(($) => $.smart.tabs.inbox_load)}</Kind>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-caption">
              <thead>
                <tr>
                  <th className={th}>{t(($) => $.smart.tabs.col_person)}</th>
                  <th className={th}>{t(($) => $.smart.tabs.decisions)}</th>
                  <th className={th}>{t(($) => $.smart.tabs.merges)}</th>
                  <th className={th}>{t(($) => $.smart.tabs.else)}</th>
                  <th className={th}>{t(($) => $.smart.tabs.col_new_asks)}</th>
                </tr>
              </thead>
              <tbody>
                {load.map((r) => (
                  <tr key={r.user_id}>
                    <td className={td}>{r.name}</td>
                    <td className={td}>{r.decisions}</td>
                    <td className={td}>{r.merges}</td>
                    <td className={td}>{r.everything_else}</td>
                    <td className={td}>{r.new_asks_7d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-caption text-muted-foreground">{t(($) => $.smart.tabs.load_note)}</p>
        </Card>
      )}
    </>
  );
}

// --- Everything else ---------------------------------------------------------

function ElsePanel({
  entries,
  selectedKey,
  onSelect,
  actions,
}: {
  entries: SmartEntry[];
  selectedKey: string;
  onSelect: (item: InboxItem) => void;
  actions: TabArchive;
}) {
  const { t } = useT("inbox");
  if (entries.length === 0) return <Empty>{t(($) => $.smart.tabs.else_empty)}</Empty>;
  return (
    <>
      <ListHeader entries={entries} actions={actions}>
        <p className="text-caption text-muted-foreground">{t(($) => $.smart.tabs.else_sub)}</p>
      </ListHeader>
      <div className="-mx-3">
        {entries.map((e) => (
          <InboxListItem
            key={inboxRowKey(e.item)}
            item={e.item}
            view="inbox"
            isSelected={inboxRowKey(e.item) === selectedKey}
            onClick={() => onSelect(e.item)}
            onAction={() => actions.onArchive(e.item.id)}
          />
        ))}
      </div>
    </>
  );
}

// --- The tab strip -----------------------------------------------------------

/** The selection keys of the rows a tab lists. */
function tabRowKeys(model: ReturnType<typeof buildInboxTabs>, tab: InboxTab): Set<string> {
  const entries: SmartEntry[] =
    tab === "today"
      ? [...model.today.alerts, ...model.today.rows.map((r) => r.entry)]
      : tab === "decisions"
        ? model.decisions.map((r) => r.entry)
        : tab === "merges"
          ? [...model.merges.approval, ...model.merges.postMerge].map((r) => r.entry)
          : tab === "else"
            ? model.else
            : [];
  return new Set(entries.map((e) => inboxRowKey(e.item)));
}

export function InboxTabsView({
  wsId,
  items,
  now,
  selectedKey,
  onSelect,
  onClearSelection,
  onArchive,
  onArchiveEntries,
  onMarkEntriesRead,
}: {
  wsId: string;
  /** The Smart rows (one per card where an action signal folds the rest). */
  items: InboxItem[];
  now: number;
  selectedKey: string;
  onSelect: (item: InboxItem) => void;
  /** Empties the content pane: on a tab switch, and when the open row leaves the tab. */
  onClearSelection: () => void;
} & TabArchive) {
  const { t } = useT("inbox");
  const actions: TabArchive = { onArchive, onArchiveEntries, onMarkEntriesRead };
  const [tab, setTab] = useState<InboxTab>(readStoredTab);
  const model = useMemo(() => buildInboxTabs(items, now), [items, now]);
  // Only the user picks what the content pane shows (owner 2026-11-12): a new
  // tab starts with nothing open, never the card the last tab had open.
  const choose = (next: InboxTab) => {
    if (next !== tab && selectedKey) {
      shownKeyRef.current = "";
      onClearSelection();
    }
    setTab(next);
    writeStoredTab(next);
  };
  // A row that was on this tab and left it (re-ranked out of Today, a merge
  // that finished) closes with it. A selection the tab never showed, such as a
  // deep link to a card on another tab, stays open.
  const tabKeys = useMemo(() => tabRowKeys(model, tab), [model, tab]);
  const shownKeyRef = useRef("");
  useEffect(() => {
    if (!selectedKey) return;
    if (tabKeys.has(selectedKey)) shownKeyRef.current = selectedKey;
    else if (shownKeyRef.current === selectedKey) {
      shownKeyRef.current = "";
      onClearSelection();
    }
  }, [selectedKey, tabKeys, onClearSelection]);
  const badge = (id: InboxTab): ReactNode => {
    const n = id === "today" ? model.badges.today : id === "decisions" ? model.badges.decisions : id === "merges" ? model.badges.merges : id === "else" ? model.badges.elseUnread : 0;
    if (!n) return null;
    return (
      <span
        className={cn(
          "rounded-full px-1.5 text-caption tabular-nums",
          id === "else" ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground",
        )}
      >
        {n}
      </span>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 overflow-x-auto border-b [scrollbar-width:none]">
        <div role="tablist" aria-label={t(($) => $.smart.tabs.aria)} className="flex min-w-max gap-0.5 px-2">
          {INBOX_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`inbox-tab-${id}`}
              aria-controls={`inbox-tabpanel-${id}`}
              aria-selected={tab === id}
              onClick={() => choose(id)}
              className={cn(
                "flex min-h-11 items-center gap-1.5 border-b-2 px-2.5 text-body font-semibold outline-none focus-visible:ring-1 focus-visible:ring-ring lg:min-h-10",
                tab === id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(($) => $.smart.tabs[id])}
              {badge(id)}
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`inbox-tabpanel-${tab}`}
        aria-labelledby={`inbox-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {/* grid-cols-1 = minmax(0, 1fr) (contango patch 47): an implicit `auto`
            column grows to the widest row's min-content, so a long one-line
            title (Everything else's Classic rows) pushed the column past the
            pane and overflow-x-hidden clipped the row's right edge: the hover
            archive, the compact menu and the time. */}
        <div data-testid="inbox-tab-list" className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-3 p-3">
          {tab === "today" && <TodayPanel model={model} onSelect={onSelect} onGo={choose} actions={actions} />}
          {tab === "decisions" && <DecisionsPanel rows={model.decisions} onSelect={onSelect} actions={actions} />}
          {tab === "merges" && <MergesPanel model={model} onSelect={onSelect} actions={actions} />}
          {tab === "squad" && <SquadPanel wsId={wsId} />}
          {tab === "else" && <ElsePanel entries={model.else} selectedKey={selectedKey} onSelect={onSelect} actions={actions} />}
        </div>
      </div>
    </div>
  );
}
