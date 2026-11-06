"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Target } from "@multica/ui/icons";
import type { MvpAsk, MvpGroup, MvpIssue, MvpReport } from "@multica/core/types";
import { issueKeys, mvpReportOptions } from "@multica/core/issues/queries";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useAuthStore } from "@multica/core/auth";
import { useActorName } from "@multica/core/workspace/hooks";
import { cn } from "@multica/ui/lib/utils";
import { CollectionPageHeader, CollectionPageState } from "../../layout/collection-page";
import { AppLink } from "../../navigation";
import { StatusIcon } from "../../issues/components/status-icon";
import { ActorAvatar } from "../../common/actor-avatar";
import { ReadonlyContent } from "../../editor/readonly-content";
import { SignalReplyButton } from "../../inbox/components/signal-reply-button";
import { useT, useTimeAgo } from "../../i18n";
import { BurndownChart } from "./burndown-chart";
import { canReply, criticalIds, orderedStatusCounts, percentDone } from "./mvp-helpers";

// The MVP page (Contango fork, patch 19): what MVP means (the home card's
// description), how far along it is, the critical path(s), and what is in the
// way. Everything comes from GET /api/mvp; the page only lays it out.

export function MvpPage() {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const { data, isLoading, isError } = useQuery(mvpReportOptions(wsId));

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <CollectionPageHeader
        icon={Target}
        title={t(($) => $.mvp.page_title)}
        actions={data?.generated_at ? <UpdatedAt at={data.generated_at} /> : null}
      />
      {isLoading ? null : isError || !data ? (
        <CollectionPageState icon={Target} title={t(($) => $.mvp.load_failed)} />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <MvpBody report={data} />
        </div>
      )}
    </div>
  );
}

function UpdatedAt({ at }: { at: string }) {
  const { t } = useT("issues");
  const ago = useTimeAgo();
  return <span className="text-caption text-muted-foreground">{t(($) => $.mvp.updated, { time: ago(at) })}</span>;
}

export function MvpBody({ report }: { report: MvpReport }) {
  const { t } = useT("issues");
  const critical = useMemo(() => criticalIds(report), [report]);
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-6">
      <Definition report={report} />
      {!report.configured ? (
        <Section title={t(($) => $.mvp.page_title)}>
          <p className="text-body text-muted-foreground">{t(($) => $.mvp.not_configured, { problem: report.problem ?? "" })}</p>
        </Section>
      ) : (
        <>
          <Tiles report={report} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={t(($) => $.mvp.burndown_title, { days: report.config.days })}>
              <BurndownChart points={report.burndown} />
              <Projection report={report} />
            </Section>
            <CriticalPaths report={report} />
          </div>
          <InTheWay report={report} critical={critical} />
          <AgentQuestions report={report} critical={critical} />
          <Pillars report={report} critical={critical} />
        </>
      )}
    </div>
  );
}

function Section({ title, hint, children, className }: { title: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-lg border border-surface-border bg-surface p-4", className)}>
      <header className="flex flex-col gap-0.5">
        <h2 className="text-title-sm font-semibold">{title}</h2>
        {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

function Definition({ report }: { report: MvpReport }) {
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  const [expanded, setExpanded] = useState(false);
  const home = report.home;
  return (
    <Section
      title={
        <span className="flex flex-wrap items-baseline justify-between gap-2">
          <span>{t(($) => $.mvp.definition_title)}</span>
          {home && (
            <AppLink href={paths.issueDetail(home.id)} newTabTitle={home.identifier} className="text-caption font-normal text-brand hover:underline">
              {home.identifier} · {t(($) => $.mvp.edit_discuss)}
            </AppLink>
          )}
        </span>
      }
    >
      {home ? (
        <div className="flex flex-col gap-2">
          <div className={cn("relative min-w-0", !expanded && "max-h-48 overflow-hidden")}>
            <ReadonlyContent content={home.description} />
            {!expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent" />}
          </div>
          <button type="button" className="self-start text-caption text-muted-foreground hover:text-foreground" onClick={() => setExpanded((v) => !v)}>
            {expanded ? t(($) => $.mvp.show_less) : t(($) => $.mvp.show_more)}
          </button>
        </div>
      ) : (
        <p className="text-body text-muted-foreground">{t(($) => $.mvp.definition_missing)}</p>
      )}
    </Section>
  );
}

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-surface-border bg-surface p-3">
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="text-title font-semibold tabular-nums">{value}</span>
      {sub && <span className="truncate text-caption text-muted-foreground">{sub}</span>}
    </div>
  );
}

function Tiles({ report }: { report: MvpReport }) {
  const { t } = useT("issues");
  const { totals, eta } = report;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile label={t(($) => $.mvp.tile_done)} value={`${percentDone(totals)}%`} sub={t(($) => $.mvp.of_total, { done: totals.done, total: totals.total })} />
      <Tile label={t(($) => $.mvp.tile_open)} value={totals.open} />
      <Tile label={t(($) => $.mvp.tile_done_7d)} value={eta.done_7d} sub={t(($) => $.mvp.per_day, { rate: eta.rate_7d })} />
      <Tile
        label={`${t(($) => $.mvp.tile_eta)} · ${t(($) => $.mvp.projection)}`}
        value={eta.eta_7d ?? eta.eta_14d ?? "—"}
        sub={eta.eta_14d && eta.eta_7d ? `14d: ${eta.eta_14d}` : undefined}
      />
    </div>
  );
}

function Projection({ report }: { report: MvpReport }) {
  const { t } = useT("issues");
  const { eta } = report;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/50 p-3 text-caption">
      <span className="font-medium">{t(($) => $.mvp.projection)}</span>
      {eta.eta_7d || eta.eta_14d ? (
        <>
          {eta.eta_7d && <span>{t(($) => $.mvp.projection_7, { date: eta.eta_7d, days: eta.days_7d ?? 0 })}</span>}
          {eta.eta_14d && <span>{t(($) => $.mvp.projection_14, { date: eta.eta_14d, days: eta.days_14d ?? 0 })}</span>}
        </>
      ) : (
        <span>{t(($) => $.mvp.projection_none)}</span>
      )}
      <span className="text-muted-foreground">{t(($) => $.mvp.projection_note)}</span>
    </div>
  );
}

/** One card: status, key, title, people, blockers. */
export function IssueLine({
  issue,
  critical,
  showBlockers = true,
  showCriticalBadge = true,
}: {
  issue: MvpIssue;
  critical: Set<string>;
  showBlockers?: boolean;
  /** Off inside a critical-path list, where every card is on the path. */
  showCriticalBadge?: boolean;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { categoryOf, colorOf, iconOf, labelOf } = useIssueStatuses(wsId);
  const { getActorName } = useActorName();
  const onPath = issue.on_critical_path || critical.has(issue.id);
  return (
    <div
      data-critical={onPath || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-body hover:bg-surface-hover",
        onPath && "ring-1 ring-warning/50 bg-warning/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span title={labelOf(issue.status)} className="flex shrink-0">
          <StatusIcon
            status={issue.status}
            color={colorOf(issue.status)}
            icon={iconOf(issue.status)}
            category={categoryOf(issue.status)}
            className="h-3.5 w-3.5"
          />
        </span>
        <AppLink
          href={paths.issueDetail(issue.id)}
          newTabTitle={issue.identifier}
          title={`${issue.identifier} ${issue.title}`}
          className="flex min-w-0 flex-1 items-baseline gap-2"
        >
          <span className="shrink-0 text-caption text-muted-foreground tabular-nums">{issue.identifier}</span>
          <span className="truncate">{issue.title}</span>
        </AppLink>
        <span className="flex shrink-0 items-center gap-1.5">
          {onPath && showCriticalBadge && (
            <span title={t(($) => $.mvp.on_critical_path)} className="rounded-full bg-warning/15 px-1.5 text-micro font-medium text-warning">
              CP
            </span>
          )}
          {issue.blocks > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-micro tabular-nums text-muted-foreground" title={t(($) => $.mvp.unblocks, { count: issue.blocks })}>
              +{issue.blocks}
            </span>
          )}
          {issue.assignee_type && issue.assignee_id && (
            <ActorAvatar actorType={issue.assignee_type} actorId={issue.assignee_id} size="xs" enableHoverCard />
          )}
          {issue.responsible_id && issue.responsible_id !== issue.assignee_id && (
            <span title={t(($) => $.mvp.responsible, { name: getActorName("member", issue.responsible_id) })} className="opacity-70">
              <ActorAvatar actorType="member" actorId={issue.responsible_id} size="xs" />
            </span>
          )}
        </span>
      </div>
      {showBlockers && issue.blocked_by.length > 0 && (
        <span className="flex flex-wrap items-center gap-1 pl-5 text-micro text-muted-foreground">
          {t(($) => $.mvp.blocked_by)}
          {issue.blocked_by.map((b) => (
            <AppLink
              key={b.id}
              href={paths.issueDetail(b.id)}
              newTabTitle={b.identifier}
              className={cn("rounded-full bg-muted px-1.5 tabular-nums hover:text-foreground", critical.has(b.id) && "bg-warning/15 text-warning")}
            >
              {b.identifier}
            </AppLink>
          ))}
        </span>
      )}
    </div>
  );
}

function CriticalPaths({ report }: { report: MvpReport }) {
  const { t } = useT("issues");
  const critical = useMemo(() => criticalIds(report), [report]);
  return (
    <Section title={t(($) => $.mvp.critical_title)} hint={t(($) => $.mvp.critical_hint)}>
      {report.critical_paths.length === 0 ? (
        <p className="text-body text-muted-foreground">{t(($) => $.mvp.critical_empty)}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {report.critical_paths.map((chain, i) => (
            <div key={chain.issues[0]?.id ?? i} className="flex flex-col gap-1">
              <span className="text-caption font-medium text-muted-foreground">
                {t(($) => $.mvp.chain_label, { n: i + 1 })} · {chain.issues.length}
              </span>
              <ol className="flex flex-col">
                {chain.issues.map((issue, j) => (
                  <li key={issue.id} className="flex items-start gap-1">
                    <span className="mt-2 w-5 shrink-0 text-right text-micro tabular-nums text-muted-foreground">{j + 1}.</span>
                    <div className="min-w-0 flex-1">
                      <IssueLine issue={issue} critical={critical} showBlockers={false} showCriticalBadge={false} />
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function AskLine({ ask, critical, showRecipient = false }: { ask: MvpAsk; critical: Set<string>; showRecipient?: boolean }) {
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  const ago = useTimeAgo();
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-surface-border p-2">
      <IssueLine issue={ask.issue} critical={critical} showBlockers={false} />
      <div className="flex flex-wrap items-center gap-2 px-2 text-caption">
        <span
          className={cn(
            "rounded-full px-1.5 text-micro font-medium",
            ask.kind === "operator" ? "bg-muted text-muted-foreground" : "bg-brand/10 text-brand",
          )}
        >
          {ask.kind === "operator" ? t(($) => $.mvp.kind_operator) : t(($) => $.mvp.kind_human)}
        </span>
        <AppLink
          href={`${paths.issueDetail(ask.issue.id)}#comment-${ask.comment_id}`}
          newTabTitle={ask.issue.identifier}
          className="min-w-0 flex-1 truncate hover:underline"
        >
          {ask.excerpt || ask.issue.title}
        </AppLink>
        {showRecipient && ask.recipient_id && <ActorAvatar actorType="member" actorId={ask.recipient_id} size="xs" />}
        {ask.created_at && <span className="shrink-0 text-muted-foreground">{ago(ask.created_at)}</span>}
      </div>
      {canReply(ask, userId) && ask.inbox_item_id && (
        <div className="flex flex-wrap gap-2 px-2">
          {ask.replies.map((r) => (
            <SignalReplyButton
              key={r.index}
              item={{ id: ask.inbox_item_id!, issue_id: ask.issue.id }}
              reply={r}
              size="sm"
              variant={r.index === 0 ? "default" : "outline"}
              onPosted={() => void qc.invalidateQueries({ queryKey: issueKeys.mvp(wsId) })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InTheWay({ report, critical }: { report: MvpReport; critical: Set<string> }) {
  const { t } = useT("issues");
  const { getActorName } = useActorName();
  const stuck: { key: string; label: string; items: MvpIssue[] }[] = [
    { key: "held", label: t(($) => $.mvp.stuck_held), items: report.stuck.held },
    { key: "blocked", label: t(($) => $.mvp.stuck_blocked), items: report.stuck.blocked_no_blocker },
    { key: "idle", label: t(($) => $.mvp.stuck_idle, { hours: report.config.idle_hours }), items: report.stuck.idle },
  ];
  return (
    <Section title={t(($) => $.mvp.in_the_way_title)}>
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="text-body font-medium">{t(($) => $.mvp.asks_title)}</h3>
          {report.humans.length === 0 ? (
            <p className="text-body text-muted-foreground">{t(($) => $.mvp.asks_empty)}</p>
          ) : (
            report.humans.map((g) => (
              <div key={g.recipient_id || "nobody"} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {g.recipient_id && <ActorAvatar actorType="member" actorId={g.recipient_id} size="sm" />}
                  <span className="font-medium">{g.recipient_id ? getActorName("member", g.recipient_id) : t(($) => $.mvp.nobody)}</span>
                  <span className="text-caption text-muted-foreground">{t(($) => $.mvp.cards_blocked, { count: g.cards_blocked })}</span>
                </div>
                {g.asks.map((a) => (
                  <AskLine key={a.comment_id} ask={a} critical={critical} />
                ))}
              </div>
            ))
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {stuck.map((s) => (
            <Expandable key={s.key} label={s.label} count={s.items.length}>
              {s.items.length === 0 ? (
                <p className="px-2 text-caption text-muted-foreground">{t(($) => $.mvp.stuck_empty)}</p>
              ) : (
                s.items.map((i) => <IssueLine key={i.id} issue={i} critical={critical} />)
              )}
            </Expandable>
          ))}
        </div>
      </div>
    </Section>
  );
}

function Expandable({
  label,
  count,
  children,
  extra,
  defaultOpen = false,
}: {
  label: ReactNode;
  count?: number;
  children: ReactNode;
  extra?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-surface-hover"
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {count != null && <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{count}</span>}
      </button>
      {extra}
      {open && <div className="flex flex-col pl-4">{children}</div>}
    </div>
  );
}

function AgentQuestions({ report, critical }: { report: MvpReport; critical: Set<string> }) {
  const { t } = useT("issues");
  return (
    <Section title={t(($) => $.mvp.questions_title)} hint={t(($) => $.mvp.questions_hint)}>
      {report.agent_questions.length === 0 ? (
        <p className="text-body text-muted-foreground">{t(($) => $.mvp.questions_empty)}</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {report.agent_questions.map((a) => (
            <AskLine key={a.comment_id} ask={a} critical={critical} showRecipient />
          ))}
        </div>
      )}
    </Section>
  );
}

function StatusCounts({ group }: { group: MvpGroup }) {
  const wsId = useWorkspaceId();
  const { statuses, categoryOf, colorOf, iconOf, labelOf } = useIssueStatuses(wsId);
  const counts = orderedStatusCounts(group.by_status, statuses.map((s) => s.key));
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption text-muted-foreground">
      {counts.map(([status, n]) => (
        <span key={status} className="flex items-center gap-1" title={labelOf(status)}>
          <StatusIcon status={status} color={colorOf(status)} icon={iconOf(status)} category={categoryOf(status)} className="h-3 w-3" />
          <span className="tabular-nums">{n}</span>
          <span className="hidden sm:inline">{labelOf(status)}</span>
        </span>
      ))}
    </span>
  );
}

function ProgressBar({ group }: { group: MvpGroup }) {
  const pct = percentDone(group);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="h-full rounded-full bg-chart-1" style={{ width: `${pct}%` }} />
    </div>
  );
}

function GroupRow({ title, group, critical }: { title: ReactNode; group: MvpGroup; critical: Set<string> }) {
  const { t } = useT("issues");
  return (
    <Expandable
      label={title}
      count={group.open}
      extra={
        <div className="flex flex-col gap-1.5 pl-6">
          <ProgressBar group={group} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-caption text-muted-foreground tabular-nums">
              {t(($) => $.mvp.pillar_progress, { done: group.done, total: group.total, open: group.open })}
            </span>
            <StatusCounts group={group} />
          </div>
        </div>
      }
    >
      {group.open_items.length === 0 ? (
        <p className="px-2 text-caption text-muted-foreground">{t(($) => $.mvp.no_open_cards)}</p>
      ) : (
        group.open_items.map((i) => <IssueLine key={i.id} issue={i} critical={critical} />)
      )}
    </Expandable>
  );
}

function Pillars({ report, critical }: { report: MvpReport; critical: Set<string> }) {
  const { t } = useT("issues");
  const open = report.pillars.filter((p) => p.open > 0);
  const finished = report.pillars.filter((p) => p.open === 0);
  return (
    <Section title={t(($) => $.mvp.pillars_title)}>
      <div className="flex flex-col gap-3">
        {open.map((p) => (
          <GroupRow
            key={p.issue.id}
            title={
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-caption font-normal text-muted-foreground tabular-nums">{p.issue.identifier}</span>
                <span className="truncate">{p.issue.title}</span>
              </span>
            }
            group={p}
            critical={critical}
          />
        ))}
        {report.standalone.total > 0 && (
          <GroupRow title={t(($) => $.mvp.standalone)} group={report.standalone} critical={critical} />
        )}
        {finished.length > 0 && (
          <Expandable label={t(($) => $.mvp.finished, { count: finished.length })}>
            {finished.map((p) => (
              <IssueLine key={p.issue.id} issue={p.issue} critical={critical} showBlockers={false} />
            ))}
          </Expandable>
        )}
      </div>
    </Section>
  );
}
