"use client";

// Smart inbox view (contango, docs/contango/SMART-INBOX.md): the same entries
// as the classic list, grouped by kind and ranked so the first screen is what
// needs you. One column at every width; each row is two lines plus one action,
// and tapping a row opens a focused detail rather than the issue thread. The
// header keeps everything Classic offers (filters, bulk actions) plus the
// smart filters.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  BookCheck,
  CheckCheck,
  ChevronDown,
  ExternalLink,
  Inbox,
  List,
  ListChecks,
  MoreHorizontal,
} from "@multica/ui/icons";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { inboxListOptions, useInboxUnreadCount } from "@multica/core/inbox/queries";
import { buildSmartRows, smartRowUnreadIds } from "@multica/core/inbox/smart-fold";
import {
  useArchiveAllInbox,
  useArchiveAllReadInbox,
  useArchiveCompletedInbox,
  useArchiveInbox,
  useMarkAllInboxRead,
  useMarkInboxRead,
} from "@multica/core/inbox/mutations";
import {
  filterInboxItems,
  inboxFiltersForPrioritySupport,
  inboxPriorityFilterSupport,
  useInboxFilters,
} from "@multica/core/inbox/filter-store";
import {
  buildSmartSections,
  type SmartEntry,
  type SmartSection,
  type SmartSectionId,
} from "@multica/core/inbox/smart";
import {
  filterSmartSections,
  smartInboxFilterCount,
  useSmartInboxFilters,
  useSmartInboxFilterStore,
} from "@multica/core/inbox/smart-filter-store";
import { Button } from "@multica/ui/components/ui/button";
import { IconButton } from "@multica/ui/components/common/icon-button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useIsCompact } from "@multica/ui/hooks/use-mobile";
import { cn } from "@multica/ui/lib/utils";
import { PAGE_GUTTER, PageHeader } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { useIssueSurfaceActivity } from "../../issues/surface/activity";
import { useT } from "../../i18n";
import { useTimeAgo } from "./inbox-list-item";
import { useTypeLabels } from "./inbox-detail-label";
import { getInboxDisplayTitle } from "./inbox-display";
import { InboxFilterMenu } from "./inbox-filter-menu";
import { SmartDashboard } from "./smart-dashboard";

// 44px: the minimum comfortable tap target on a phone.
const TAP = "min-h-11";
// Rows a collapsed-to-preview section shows on a phone.
const PHONE_PREVIEW = 3;
const SECTION_IDS: SmartSectionId[] = [
  "merge",
  "decision",
  "access",
  "stalled",
  "blocking",
  "alert",
  "mentions",
  "fyi",
];


function useErrorToast() {
  return (fallback: string) => (err: unknown) =>
    toast.error(err instanceof Error && err.message ? err.message : fallback);
}

export function SmartInboxPage({ headerAccessory }: { headerAccessory?: ReactNode }) {
  const { t } = useT("inbox");
  const wsId = useWorkspaceId();
  const { data: raw = [], isLoading } = useQuery(inboxListOptions(wsId));
  const unreadCount = useInboxUnreadCount(wsId);
  const markRead = useMarkInboxRead();
  const archive = useArchiveInbox();
  const markAllRead = useMarkAllInboxRead();
  const archiveAll = useArchiveAllInbox();
  const archiveAllRead = useArchiveAllReadInbox();
  const archiveCompleted = useArchiveCompletedInbox();
  const onError = useErrorToast();

  // Classic filters, applied to the same entries the way Classic applies them.
  const filters = useInboxFilters(wsId);
  const priorityFilterSupport = inboxPriorityFilterSupport(raw);
  const effectiveFilters = useMemo(
    () => inboxFiltersForPrioritySupport(filters, priorityFilterSupport),
    [filters, priorityFilterSupport],
  );
  const { activityByIssueId } = useIssueSurfaceActivity();
  const activeIssueIds = useMemo(() => new Set(activityByIssueId.keys()), [activityByIssueId]);
  const smartFilters = useSmartInboxFilters(wsId);

  // Re-rank once a minute so waiting entries climb while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  // One row per card; a card's entries fold into its action signal.
  const rows = useMemo(() => buildSmartRows(raw), [raw]);
  const items = rows.items;
  const allSections = useMemo(() => buildSmartSections(items, now), [items, now]);
  const sections = useMemo(() => {
    const filtered = filterInboxItems(items, effectiveFilters, {
      activeIssueIds: effectiveFilters.idleOnly ? activeIssueIds : undefined,
    });
    return filterSmartSections(buildSmartSections(filtered, now), smartFilters);
  }, [items, effectiveFilters, activeIssueIds, now, smartFilters]);

  const [openId, setOpenId] = useState<string | null>(null);
  // Resolved against the unfiltered sections: opening marks the entry read,
  // which must not drop the detail under an unread-only filter.
  const open = useMemo(() => {
    for (const s of allSections) {
      const hit = s.entries.find((e) => e.item.id === openId);
      if (hit) return hit;
    }
    return null;
  }, [allSections, openId]);

  const openEntry = (entry: SmartEntry) => {
    setOpenId(entry.item.id);
    for (const id of smartRowUnreadIds(rows, entry.item)) markRead.mutate(id);
  };
  const handleArchive = (id: string) => {
    if (openId === id) setOpenId(null);
    archive.mutate(id, {
      onSuccess: () => toast.success(t(($) => $.toasts.archived)),
      onError: onError(t(($) => $.errors.archive_failed)),
    });
  };
  const archiveSection = (section: SmartSection) => {
    void Promise.allSettled(section.entries.map((e) => archive.mutateAsync(e.item.id))).then(
      (results) => {
        if (results.some((r) => r.status === "rejected")) toast.error(t(($) => $.errors.archive_failed));
        else toast.success(t(($) => $.toasts.archived));
      },
    );
  };
  const markSectionRead = (section: SmartSection) => {
    const unread = section.entries.flatMap((e) => smartRowUnreadIds(rows, e.item));
    void Promise.allSettled(unread.map((id) => markRead.mutateAsync(id))).then((results) => {
      if (results.some((r) => r.status === "rejected")) toast.error(t(($) => $.errors.mark_read_failed));
    });
  };

  if (open) {
    return (
      <SmartInboxDetail
        entry={open}
        onBack={() => setOpenId(null)}
        onArchive={() => handleArchive(open.item.id)}
      />
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-x-hidden">
      <PageHeader>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate text-body font-semibold">{t(($) => $.page.title)}</h1>
          {unreadCount > 0 && (
            <span className="text-caption text-muted-foreground tabular-nums">{unreadCount}</span>
          )}
        </div>
        {headerAccessory}
        <InboxFilterMenu
          wsId={wsId}
          items={items}
          priorityFilterSupport={priorityFilterSupport}
          activeIssueIds={activeIssueIds}
        />
        <SmartFilterMenu wsId={wsId} />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                label={t(($) => $.smart.bulk_menu)}
                tooltipSide="bottom"
                className="text-muted-foreground"
              />
            }
          >
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuItem
              onClick={() => markAllRead.mutate(undefined, { onError: onError(t(($) => $.errors.mark_all_read_failed)) })}
            >
              <CheckCheck className="h-4 w-4" />
              {t(($) => $.menu.mark_all_read)}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => archiveAll.mutate(undefined, { onError: onError(t(($) => $.errors.archive_all_failed)) })}
            >
              <Archive className="h-4 w-4" />
              {t(($) => $.menu.archive_all)}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => archiveAllRead.mutate(undefined, { onError: onError(t(($) => $.errors.archive_all_read_failed)) })}
            >
              <BookCheck className="h-4 w-4" />
              {t(($) => $.menu.archive_all_read)}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => archiveCompleted.mutate(undefined, { onError: onError(t(($) => $.errors.archive_completed_failed)) })}
            >
              <ListChecks className="h-4 w-4" />
              {t(($) => $.menu.archive_completed)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-2xl pb-6">
          {!isLoading && <SmartDashboard wsId={wsId} sections={allSections} onSelect={(item) => {
            const entry = allSections.flatMap((x) => x.entries).find((e) => e.item.id === item.id);
            if (entry) openEntry(entry);
          }} compact />}
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : sections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Inbox className="mb-3 h-8 w-8 text-faint-foreground" />
              <p className="text-body">
                {allSections.length > 0 ? t(($) => $.filters.empty) : t(($) => $.smart.empty)}
              </p>
            </div>
          ) : (
            sections.map((section) => (
              <SmartSectionView
                key={section.id}
                section={section}
                onOpen={openEntry}
                onArchive={handleArchive}
                onArchiveAll={() => archiveSection(section)}
                onMarkRead={() => markSectionRead(section)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function SmartFilterMenu({ wsId }: { wsId: string }) {
  const { t } = useT("inbox");
  const filters = useSmartInboxFilters(wsId);
  const toggleGroup = useSmartInboxFilterStore((s) => s.toggleGroup);
  const toggleNeedsYouOnly = useSmartInboxFilterStore((s) => s.toggleNeedsYouOnly);
  const toggleUrgentOnly = useSmartInboxFilterStore((s) => s.toggleUrgentOnly);
  const clear = useSmartInboxFilterStore((s) => s.clearSmartFilters);
  const count = smartInboxFilterCount(filters);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton
            variant={count > 0 ? "default" : "ghost"}
            size="icon-sm"
            label={t(($) => $.smart.filters.tooltip)}
            tooltipSide="bottom"
            className={cn(
              "text-muted-foreground",
              count > 0 && "w-auto gap-1 bg-brand px-2 text-white hover:bg-brand/90",
            )}
          />
        }
      >
        <List className="size-4" />
        {count > 0 && <span className="text-caption tabular-nums">{count}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        <DropdownMenuCheckboxItem
          checked={filters.needsYouOnly}
          onCheckedChange={() => toggleNeedsYouOnly(wsId)}
        >
          {t(($) => $.smart.filters.needs_you)}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filters.urgentOnly}
          onCheckedChange={() => toggleUrgentOnly(wsId)}
        >
          {t(($) => $.smart.filters.urgent_only)}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {SECTION_IDS.map((id) => (
          <DropdownMenuCheckboxItem
            key={id}
            checked={filters.groups.includes(id)}
            onCheckedChange={() => toggleGroup(wsId, id)}
          >
            {t(($) => $.smart.sections[id])}
          </DropdownMenuCheckboxItem>
        ))}
        {count > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => clear(wsId)}>{t(($) => $.filters.clear)}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SmartSectionView({
  section,
  onOpen,
  onArchive,
  onArchiveAll,
  onMarkRead,
}: {
  section: SmartSection;
  onOpen: (entry: SmartEntry) => void;
  onArchive: (id: string) => void;
  onArchiveAll: () => void;
  onMarkRead: () => void;
}) {
  const { t } = useT("inbox");
  const isCompact = useIsCompact();
  const reasonText = useReasonText();
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const headingId = `smart-${section.id}`;
  const top = section.entries[0]!;
  const hidden = isCompact && !showAll ? Math.max(0, section.entries.length - PHONE_PREVIEW) : 0;
  const visible = hidden > 0 ? section.entries.slice(0, PHONE_PREVIEW) : section.entries;
  const label = (
    <>
      <span className="font-medium text-foreground">{t(($) => $.smart.sections[section.id])}</span>
      <span className="tabular-nums"> · {section.entries.length}</span>
      <span className="min-w-0 truncate"> · {reasonText(top)}</span>
    </>
  );
  return (
    <section aria-labelledby={headingId} className="pt-3">
      <div className={cn("flex items-center gap-1", PAGE_GUTTER)}>
        <h2 id={headingId} className="flex min-w-0 flex-1 text-caption text-muted-foreground">
          {isCompact ? (
            // Phones: the header folds the section.
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((c) => !c)}
              className={cn(TAP, "flex min-w-0 flex-1 items-center gap-1 whitespace-nowrap text-left outline-none focus-visible:ring-1 focus-visible:ring-ring")}
            >
              <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", collapsed && "-rotate-90")} />
              {label}
            </button>
          ) : (
            <span className="flex min-w-0 items-center whitespace-nowrap py-1">{label}</span>
          )}
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                label={t(($) => $.smart.section_actions)}
                tooltipSide="bottom"
                className={cn("shrink-0 text-muted-foreground", isCompact && "size-11")}
              />
            }
          >
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuItem onClick={onMarkRead}>
              <CheckCheck className="h-4 w-4" />
              {t(($) => $.smart.mark_section_read)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onArchiveAll}>
              <Archive className="h-4 w-4" />
              {t(($) => $.smart.archive_section)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!collapsed && (
        <>
          <ul>
            {visible.map((entry) => (
              <SmartInboxRow
                key={entry.item.id}
                entry={entry}
                showReason={section.id !== "fyi"}
                onOpen={() => onOpen(entry)}
                onArchive={() => onArchive(entry.item.id)}
              />
            ))}
          </ul>
          {hidden > 0 && (
            <div className={PAGE_GUTTER}>
              <Button variant="ghost" size="sm" className={cn(TAP, "w-full text-muted-foreground")} onClick={() => setShowAll(true)}>
                {t(($) => $.smart.show_more, { count: hidden })}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function useLine2() {
  const typeLabels = useTypeLabels();
  return (entry: SmartEntry): string => {
    if (entry.signal) return entry.signal.summary;
    const preview = (entry.item.body ?? "").replace(/\s+/g, " ").trim();
    return preview || typeLabels[entry.item.type] || entry.item.type;
  };
}

export function useReasonText() {
  const { t } = useT("inbox");
  const timeAgo = useTimeAgo();
  return (entry: SmartEntry): string => {
    const parts: string[] = [];
    if (entry.reason.priority !== "none") {
      parts.push(t(($) => $.smart.priority[entry.reason.priority]));
    }
    if (entry.reason.blocks > 0) {
      parts.push(t(($) => $.smart.blocks, { count: entry.reason.blocks }));
    }
    parts.push(timeAgo(entry.signal?.rank.since ?? entry.item.created_at));
    return parts.join(" · ");
  };
}

/** The one primary action: the signal's first action, else open the issue. */
function PrimaryAction({ entry, className }: { entry: SmartEntry; className?: string }) {
  const { t } = useT("inbox");
  const { push } = useNavigation();
  const wsPaths = useWorkspacePaths();
  const action = entry.signal?.actions[0];
  if (action) {
    return (
      <Button
        variant="outline"
        size="sm"
        className={cn(TAP, "max-w-[40%] shrink-0", className)}
        render={<a href={action.url} target="_blank" rel="noopener noreferrer" />}
        nativeButton={false}
      >
        <span className="truncate">{action.label}</span>
      </Button>
    );
  }
  if (!entry.item.issue_id) return null;
  const issueId = entry.item.issue_id;
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(TAP, "shrink-0", className)}
      onClick={() => push(wsPaths.issueDetail(issueId))}
    >
      {entry.signal ? t(($) => $.smart.open_issue) : t(($) => $.smart.open)}
    </Button>
  );
}

function SmartInboxRow({
  entry,
  showReason,
  onOpen,
  onArchive,
}: {
  entry: SmartEntry;
  showReason: boolean;
  onOpen: () => void;
  onArchive: () => void;
}) {
  const { t } = useT("inbox");
  const line2 = useLine2();
  const reasonText = useReasonText();
  const timeAgo = useTimeAgo();
  const unread = !entry.item.read;
  return (
    <li className={cn("group flex w-full items-center gap-1 py-1", PAGE_GUTTER)}>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          TAP,
          "flex min-w-0 flex-1 flex-col justify-center rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          {unread && <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand" />}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-body",
              unread && "font-medium",
            )}
          >
            {getInboxDisplayTitle(entry.item)}
          </span>
          {/* Phones keep line 1 for the title: the full reason shows from sm
              up, and in the detail; line 2 already says why it's here. */}
          {showReason && (
            <span className="hidden shrink-0 text-caption text-muted-foreground sm:inline">
              {reasonText(entry)}
            </span>
          )}
          <span className={cn("shrink-0 text-caption text-muted-foreground", showReason && "sm:hidden")}>
            {timeAgo(entry.signal?.rank.since ?? entry.item.created_at)}
          </span>
        </span>
        <span className="block w-full truncate text-caption text-muted-foreground">
          {line2(entry)}
        </span>
      </button>
      <PrimaryAction entry={entry} />
      {/* Hover/focus on pointer devices; always there (muted) on touch. */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t(($) => $.list.archive_tooltip)}
        title={t(($) => $.list.archive_tooltip)}
        onClick={onArchive}
        className={cn(
          "shrink-0 text-muted-foreground",
          "[@media(hover:none)]:size-11",
          "[@media(hover:hover)]:invisible [@media(hover:hover)]:group-hover:visible [@media(hover:hover)]:group-focus-within:visible",
        )}
      >
        <Archive className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

/**
 * The smart part of a signal's detail: why it's here, the ask, and its
 * actions. Phones show it as the whole focused detail; the two-pane layout
 * shows it compactly above the issue thread.
 */
export function SignalBrief({
  entry,
  compact = false,
  showTitleAndBody = true,
}: {
  entry: SmartEntry;
  /** Above the issue thread: tighter spacing, buttons in one row. */
  compact?: boolean;
  /** Off where the surrounding detail already shows the title and body. */
  showTitleAndBody?: boolean;
}) {
  const line2 = useLine2();
  const reasonText = useReasonText();
  const { item, signal } = entry;
  const body = signal && showTitleAndBody ? item.body : null;
  return (
    <div data-testid="signal-brief" className={cn(compact ? "space-y-2" : "space-y-4")}>
      <header className="space-y-1">
        {showTitleAndBody &&
          (compact ? (
            <h2 className="break-words text-body font-semibold">{getInboxDisplayTitle(item)}</h2>
          ) : (
            <h1 className="break-words text-title font-semibold">{getInboxDisplayTitle(item)}</h1>
          ))}
        <p className="break-words text-body text-muted-foreground">{line2(entry)}</p>
        <p className="text-caption text-muted-foreground">{reasonText(entry)}</p>
      </header>
      {body && <p className="whitespace-pre-wrap break-words text-body">{body}</p>}
      {signal && signal.actions.length > 0 && (
        <div className={cn("flex gap-2", compact ? "flex-row flex-wrap" : "flex-col sm:flex-row sm:flex-wrap")}>
          {signal.actions.map((action, i) => (
            <Button
              key={`${action.url}-${i}`}
              variant={i === 0 ? "default" : "outline"}
              size={compact ? "sm" : "default"}
              className={compact ? undefined : TAP}
              render={<a href={action.url} target="_blank" rel="noopener noreferrer" />}
              nativeButton={false}
            >
              <span className="truncate">{action.label}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function SmartInboxDetail({
  entry,
  onBack,
  onArchive,
}: {
  entry: SmartEntry;
  onBack: () => void;
  onArchive: () => void;
}) {
  const { t } = useT("inbox");
  const { push } = useNavigation();
  const wsPaths = useWorkspacePaths();
  const { item, signal } = entry;
  const issueId = item.issue_id;
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-x-hidden">
      <div className={cn("flex h-12 shrink-0 items-center gap-2 border-b", PAGE_GUTTER)}>
        <Button variant="ghost" size="sm" onClick={onBack} className={cn(TAP, "-ml-2 gap-1.5 text-muted-foreground")}>
          <ArrowLeft className="h-4 w-4" />
          {t(($) => $.smart.back)}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <article className={cn("mx-auto w-full max-w-2xl space-y-4 py-4", PAGE_GUTTER)}>
          <SignalBrief entry={entry} />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {issueId && (
              <Button
                variant={signal?.actions.length ? "outline" : "default"}
                className={TAP}
                onClick={() => push(wsPaths.issueDetail(issueId))}
              >
                {t(($) => $.smart.open_issue)}
              </Button>
            )}
            <Button variant="outline" className={TAP} onClick={onArchive}>
              <Archive className="h-3.5 w-3.5" />
              {t(($) => $.detail.archive)}
            </Button>
          </div>
        </article>
      </div>
    </div>
  );
}
