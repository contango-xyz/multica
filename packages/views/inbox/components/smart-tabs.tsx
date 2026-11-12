"use client";

// Inbox tabs (contango patch 43, owner 2026-11-12; docs/contango/SMART-INBOX.md
// "Tabs"): the smart list as five tabs, in the list pane of the two-pane
// inbox. Today (the top 5 asks), Decisions (one row per card, tap for the
// plain-words brief), Merges (one card per PR; approving happens on GitHub),
// Squad (a read-only screen) and Everything else. Selecting a row opens the
// card on the right, as in Smart. Rows and ranking: core's smart-tabs.ts.

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ExternalLink } from "@multica/ui/icons";
import { inboxRowKey } from "@multica/core/inbox/filter-store";
import { inboxSquadOptions } from "@multica/core/inbox/queries";
import { ageTint, type SmartEntry } from "@multica/core/inbox/smart";
import {
  buildInboxTabs,
  cardHoursLost,
  cardRef,
  INBOX_TABS,
  type InboxTab,
  type TabRow,
} from "@multica/core/inbox/smart-tabs";
import { SQUAD_BUCKETS, type InboxSquad } from "@multica/core/inbox/squad";
import type { InboxItem } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { getInboxDisplayTitle } from "./inbox-display";
import { InboxListItem } from "./inbox-list-item";
import { SignalReplyButton } from "./signal-reply-button";

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

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid min-w-0 gap-2 rounded-lg border bg-background p-3", className)}>{children}</div>;
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
function RowActions({ entry, onSelect }: { entry: SmartEntry; onSelect: (item: InboxItem) => void }) {
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
    </div>
  );
}

// --- Today -------------------------------------------------------------------

function TodayPanel({
  model,
  onSelect,
  onGo,
}: {
  model: ReturnType<typeof buildInboxTabs>;
  onSelect: (item: InboxItem) => void;
  onGo: (tab: InboxTab) => void;
}) {
  const { t } = useT("inbox");
  const { rows, more, alerts } = model.today;
  return (
    <>
      {alerts.map((a) => (
        <div key={a.item.id} role="status" className="grid gap-1 rounded-lg bg-destructive/10 px-3 py-2.5">
          <Kind>{t(($) => $.smart.tabs.alert)}</Kind>
          <button type="button" onClick={() => onSelect(a.item)} className="text-left text-body hover:underline">
            <b className="text-destructive">{getInboxDisplayTitle(a.item)}</b>
            {a.signal?.summary ? <span className="text-muted-foreground"> · {a.signal.summary}</span> : null}
          </button>
        </div>
      ))}
      {rows.length === 0 ? (
        <Empty>{t(($) => $.smart.tabs.today_empty)}</Empty>
      ) : (
        <>
          <Lede title={t(($) => $.smart.tabs.today_lede)} sub={t(($) => $.smart.tabs.today_sub)} />
          {rows.map((row, i) => (
            <Card key={row.entry.item.id}>
              <div className="grid grid-cols-[2rem_1fr] items-start gap-2.5">
                <span aria-hidden className="grid size-7 place-items-center rounded-full bg-primary/10 font-semibold tabular-nums text-primary">
                  {i + 1}
                </span>
                <div className="grid min-w-0 gap-1.5">
                  <button
                    type="button"
                    onClick={() => onSelect(row.entry.item)}
                    className="break-words text-left text-body font-semibold hover:underline"
                  >
                    <span className="sr-only">{i + 1}. </span>
                    {getInboxDisplayTitle(row.entry.item)}
                  </button>
                  <RowMeta entry={row.entry} showLost />
                  {whyText(row.entry) && <p className="line-clamp-3 break-words text-body">{whyText(row.entry)}</p>}
                  <RowActions entry={row.entry} onSelect={onSelect} />
                </div>
              </div>
            </Card>
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

function DecisionRow({ row, open, onToggle, onSelect }: { row: TabRow; open: boolean; onToggle: () => void; onSelect: (item: InboxItem) => void }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background" data-inbox-row-key={inboxRowKey(row.entry.item)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="grid w-full min-w-0 grid-cols-[1fr_auto] items-start gap-2 px-3 py-2.5 text-left"
      >
        <span className="grid min-w-0 gap-1">
          <span className={cn("break-words text-body", !row.entry.item.read && "font-semibold")}>
            {getInboxDisplayTitle(row.entry.item)}
          </span>
          <RowMeta entry={row.entry} folded={row.entries.length} />
        </span>
        <ChevronRight className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="grid gap-3 border-t px-3 py-3">
          <BriefBody entry={row.entry} />
          <RowActions entry={row.entry} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}

function DecisionsPanel({ rows, onSelect }: { rows: TabRow[]; onSelect: (item: InboxItem) => void }) {
  const { t } = useT("inbox");
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return <Empty>{t(($) => $.smart.tabs.decisions_empty)}</Empty>;
  return (
    <>
      <Lede title={t(($) => $.smart.tabs.decisions_lede, { count: rows.length })} sub={t(($) => $.smart.tabs.decisions_sub)} />
      {rows.map((row) => (
        <DecisionRow
          key={row.entry.item.id}
          row={row}
          open={open === row.entry.item.id}
          onToggle={() => setOpen((cur) => (cur === row.entry.item.id ? null : row.entry.item.id))}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

// --- Merges ------------------------------------------------------------------

function MergeCard({ row, onSelect }: { row: TabRow; onSelect: (item: InboxItem) => void }) {
  const { t } = useT("inbox");
  const m = row.entry.signal?.merge;
  const postMerge = m?.postMerge || row.entry.signal?.key.startsWith("post-merge:");
  const fact = (label: string, value: ReactNode) => (
    <div className="min-w-0 text-caption">
      <span className="block text-micro uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="break-words">{value}</span>
    </div>
  );
  return (
    <Card>
      <button type="button" onClick={() => onSelect(row.entry.item)} className="break-words text-left text-body font-semibold hover:underline">
        {getInboxDisplayTitle(row.entry.item)}
      </button>
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

function MergesPanel({ model, onSelect }: { model: ReturnType<typeof buildInboxTabs>; onSelect: (item: InboxItem) => void }) {
  const { t } = useT("inbox");
  const { approval, postMerge } = model.merges;
  return (
    <>
      {approval.length === 0 ? (
        <Empty>{t(($) => $.smart.tabs.merges_empty)}</Empty>
      ) : (
        <>
          <Lede title={t(($) => $.smart.tabs.merges_lede, { count: approval.length })} sub={t(($) => $.smart.tabs.merges_sub)} />
          {approval.map((row) => (
            <MergeCard key={row.entry.item.id} row={row} onSelect={onSelect} />
          ))}
        </>
      )}
      {postMerge.length > 0 && (
        <>
          <p className="mt-2 text-micro font-semibold uppercase tracking-wide text-muted-foreground">{t(($) => $.smart.tabs.merged_without_you)}</p>
          {postMerge.map((row) => (
            <MergeCard key={row.entry.item.id} row={row} onSelect={onSelect} />
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
  onArchive,
}: {
  entries: SmartEntry[];
  selectedKey: string;
  onSelect: (item: InboxItem) => void;
  onArchive: (id: string) => void;
}) {
  const { t } = useT("inbox");
  if (entries.length === 0) return <Empty>{t(($) => $.smart.tabs.else_empty)}</Empty>;
  return (
    <>
      <p className="text-caption text-muted-foreground">{t(($) => $.smart.tabs.else_sub)}</p>
      <div className="-mx-3">
        {entries.map((e) => (
          <InboxListItem
            key={inboxRowKey(e.item)}
            item={e.item}
            view="inbox"
            isSelected={inboxRowKey(e.item) === selectedKey}
            onClick={() => onSelect(e.item)}
            onAction={() => onArchive(e.item.id)}
          />
        ))}
      </div>
    </>
  );
}

// --- The tab strip -----------------------------------------------------------

export function InboxTabsView({
  wsId,
  items,
  now,
  selectedKey,
  onSelect,
  onArchive,
}: {
  wsId: string;
  /** The Smart rows (one per card where an action signal folds the rest). */
  items: InboxItem[];
  now: number;
  selectedKey: string;
  onSelect: (item: InboxItem) => void;
  onArchive: (id: string) => void;
}) {
  const { t } = useT("inbox");
  const [tab, setTab] = useState<InboxTab>(readStoredTab);
  const model = useMemo(() => buildInboxTabs(items, now), [items, now]);
  const choose = (next: InboxTab) => {
    setTab(next);
    writeStoredTab(next);
  };
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
        <div className="mx-auto grid w-full max-w-3xl gap-3 p-3">
          {tab === "today" && <TodayPanel model={model} onSelect={onSelect} onGo={choose} />}
          {tab === "decisions" && <DecisionsPanel rows={model.decisions} onSelect={onSelect} />}
          {tab === "merges" && <MergesPanel model={model} onSelect={onSelect} />}
          {tab === "squad" && <SquadPanel wsId={wsId} />}
          {tab === "else" && <ElsePanel entries={model.else} selectedKey={selectedKey} onSelect={onSelect} onArchive={onArchive} />}
        </div>
      </div>
    </div>
  );
}
