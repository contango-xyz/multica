"use client";

// Smart inbox dashboard (contango, docs/contango/SMART-INBOX.md): what to do
// first, how much is waiting, and the squad's health, above the list. Built
// only from the reader's own inbox entries; nothing is fetched for it.

import { ExternalLink } from "lucide-react";
import {
  doThisFirst,
  smartCounters,
  squadHealth,
  type SmartEntry,
  type SmartSection,
} from "@multica/core/inbox/smart";
import {
  useSmartInboxFilters,
  useSmartInboxFilterStore,
} from "@multica/core/inbox/smart-filter-store";
import type { InboxItem } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { getInboxDisplayTitle } from "./inbox-display";

/** "9h", "2d", "15m": the wait in the list's own time units. */
export function useWaitText() {
  const { t } = useT("inbox");
  return (hours: number): string => {
    if (hours < 1) return t(($) => $.list.time.minutes, { count: Math.max(1, Math.floor(hours * 60)) });
    if (hours < 24) return t(($) => $.list.time.hours, { count: Math.floor(hours) });
    return t(($) => $.list.time.days, { count: Math.floor(hours / 24) });
  };
}

/** The rank reason in plain words: "urgent · blocks 4 cards · waiting 9h". */
export function usePlainReason() {
  const { t } = useT("inbox");
  const wait = useWaitText();
  return (entry: SmartEntry): string => {
    const parts: string[] = [];
    const p = entry.reason.priority;
    if (p === "urgent" || p === "high") parts.push(t(($) => $.smart.priority[p]).toLowerCase());
    if (entry.reason.blocks > 0) parts.push(t(($) => $.smart.dashboard.blocks_cards, { count: entry.reason.blocks }));
    parts.push(t(($) => $.smart.dashboard.waiting_for, { age: wait(entry.waitedHours) }));
    return parts.join(" · ");
  };
}

function Chip({
  children,
  pressed,
  tone = "default",
  onClick,
}: {
  children: React.ReactNode;
  pressed?: boolean;
  tone?: "default" | "red" | "amber";
  onClick?: () => void;
}) {
  const toneClass =
    tone === "red"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : tone === "amber"
        ? "border-warning/50 bg-warning/10 text-foreground"
        : "text-foreground";
  if (!onClick) {
    return <span className={cn("inline-flex h-7 items-center rounded-md border px-2 text-caption", toneClass)}>{children}</span>;
  }
  return (
    <Button
      variant="outline"
      size="xs"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn("min-h-7", toneClass, pressed && "ring-1 ring-ring")}
    >
      {children}
    </Button>
  );
}

function DoFirstItem({
  rank,
  entry,
  onSelect,
}: {
  rank: number;
  entry: SmartEntry;
  onSelect: (item: InboxItem) => void;
}) {
  const { t } = useT("inbox");
  const reason = usePlainReason();
  const action = entry.signal?.actions[0];
  return (
    <li className="flex min-w-0 items-start gap-3 rounded-md border bg-background p-2">
      <span aria-hidden className="w-6 shrink-0 text-center text-display-sm font-semibold leading-none text-muted-foreground">
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onSelect(entry.item)}
          className="block min-h-11 w-full truncate text-left text-body font-semibold outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring lg:min-h-0"
        >
          <span className="sr-only">{rank}. </span>
          {getInboxDisplayTitle(entry.item)}
        </button>
        <p className="truncate text-caption text-muted-foreground">{reason(entry)}</p>
      </div>
      {action ? (
        <Button
          size="sm"
          className="min-h-11 max-w-[45%] shrink-0 lg:min-h-0"
          render={<a href={action.url} target="_blank" rel="noopener noreferrer" />}
          nativeButton={false}
        >
          <span className="truncate">{action.label}</span>
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="min-h-11 shrink-0 lg:min-h-0" onClick={() => onSelect(entry.item)}>
          {t(($) => $.smart.dashboard.open)}
        </Button>
      )}
    </li>
  );
}

/**
 * `sections` are the reader's whole active inbox (before any filter), so the
 * panel keeps counting what is filtered out of the list below.
 */
export function SmartDashboard({
  wsId,
  sections,
  onSelect,
  compact = false,
}: {
  wsId: string;
  sections: SmartSection[];
  onSelect: (item: InboxItem) => void;
  /** Phones: "Do this first" and one counters line. */
  compact?: boolean;
}) {
  const { t } = useT("inbox");
  const wait = useWaitText();
  const filters = useSmartInboxFilters(wsId);
  const focusGroup = useSmartInboxFilterStore((s) => s.focusGroup);
  const toggleNeedsYouOnly = useSmartInboxFilterStore((s) => s.toggleNeedsYouOnly);
  const toggleUrgentOnly = useSmartInboxFilterStore((s) => s.toggleUrgentOnly);
  const top = doThisFirst(sections);
  const counters = smartCounters(sections);
  const health = squadHealth(sections);
  const oldest = top.length
    ? sections
        .flatMap((s) => s.entries)
        .filter((e) => e.needsYou)
        .reduce((a, b) => (b.waitedHours > a.waitedHours ? b : a))
    : null;

  const doFirst = (
    <section aria-labelledby="smart-do-first" className="min-w-0">
      <h2 id="smart-do-first" className="pb-1 text-caption font-medium text-muted-foreground">
        {t(($) => $.smart.dashboard.do_first)}
      </h2>
      {top.length === 0 ? (
        <p className="rounded-md border bg-background p-3 text-body text-muted-foreground">
          {t(($) => $.smart.dashboard.nothing_waiting)}
        </p>
      ) : (
        <ol className={cn("grid gap-2", !compact && "lg:grid-cols-3")}>
          {top.map((entry, i) => (
            <DoFirstItem key={entry.item.id} rank={i + 1} entry={entry} onSelect={onSelect} />
          ))}
        </ol>
      )}
    </section>
  );

  if (compact) {
    return (
      <div data-testid="smart-dashboard" className="space-y-2 border-b px-4 py-3">
        {doFirst}
        {counters.waiting > 0 && (
          <button
            type="button"
            aria-pressed={filters.needsYouOnly}
            onClick={() => toggleNeedsYouOnly(wsId)}
            className="min-h-11 w-full truncate text-left text-caption text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {[
              t(($) => $.smart.dashboard.waiting, { count: counters.waiting }),
              counters.oldestWaitHours != null
                ? t(($) => $.smart.dashboard.oldest, { age: wait(counters.oldestWaitHours) })
                : null,
              counters.urgent > 0 ? t(($) => $.smart.dashboard.urgent, { count: counters.urgent }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </button>
        )}
      </div>
    );
  }

  const hasHealth = health.stalled + health.blocking + health.alerts.length > 0;
  return (
    <div data-testid="smart-dashboard" className="space-y-2 border-b bg-muted/30 px-4 py-3">
      {doFirst}
      <div role="group" aria-label={t(($) => $.smart.dashboard.dashboard)} className="flex flex-wrap items-center gap-1.5">
        <Chip pressed={filters.needsYouOnly} onClick={() => toggleNeedsYouOnly(wsId)}>
          {t(($) => $.smart.dashboard.waiting, { count: counters.waiting })}
        </Chip>
        {counters.byGroup.map(({ id, count }) => (
          <Chip
            key={id}
            pressed={filters.groups.length === 1 && filters.groups[0] === id}
            onClick={() => focusGroup(wsId, id)}
          >
            {t(($) => $.smart.sections[id])} · {count}
          </Chip>
        ))}
        {oldest && counters.oldestWaitHours != null && (
          <Chip tone={counters.oldestWaitHours > 24 ? "red" : counters.oldestWaitHours > 4 ? "amber" : "default"} onClick={() => onSelect(oldest.item)}>
            {t(($) => $.smart.dashboard.oldest, { age: wait(counters.oldestWaitHours) })}
          </Chip>
        )}
        {counters.urgent > 0 && (
          <Chip tone="red" pressed={filters.urgentOnly} onClick={() => toggleUrgentOnly(wsId)}>
            {t(($) => $.smart.dashboard.urgent, { count: counters.urgent })}
          </Chip>
        )}
      </div>
      {hasHealth && (
        <div role="group" aria-label={t(($) => $.smart.dashboard.health)} className="flex flex-wrap items-center gap-1.5">
          {health.alerts.map((alert) => (
            <Chip key={alert.item.id} tone="red" onClick={() => onSelect(alert.item)}>
              {getInboxDisplayTitle(alert.item)}
            </Chip>
          ))}
          {health.stalled > 0 && (
            <Chip tone="amber" onClick={() => focusGroup(wsId, "stalled")}>
              {t(($) => $.smart.dashboard.stalled, { count: health.stalled })}
            </Chip>
          )}
          {health.blocking > 0 && (
            <Chip tone="amber" onClick={() => focusGroup(wsId, "blocking")}>
              {t(($) => $.smart.dashboard.blocking, { count: health.blocking })}
            </Chip>
          )}
        </div>
      )}
    </div>
  );
}
