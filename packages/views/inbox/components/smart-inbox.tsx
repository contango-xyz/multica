"use client";

// Smart inbox view (contango, docs/contango/SMART-INBOX.md): the same entries
// as the classic list, grouped and ranked so the first screen is what needs
// you. One column at every width; each row is two lines plus one action, and
// tapping a row opens a focused detail rather than the issue thread.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Archive, ExternalLink, Inbox } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { deduplicateInboxItems, inboxListOptions } from "@multica/core/inbox/queries";
import { useArchiveInbox, useMarkInboxRead } from "@multica/core/inbox/mutations";
import {
  buildSmartSections,
  type SmartEntry,
  type SmartSectionId,
} from "@multica/core/inbox/smart";
import type { InboxItem } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { PAGE_GUTTER, PageHeader } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useTimeAgo } from "./inbox-list-item";
import { useTypeLabels } from "./inbox-detail-label";
import { getInboxDisplayTitle } from "./inbox-display";

// 44px: the minimum comfortable tap target on a phone.
const TAP = "min-h-11";

/** Signals one row each; other entries grouped per issue like the classic list. */
export function smartInboxItems(raw: InboxItem[]): InboxItem[] {
  const signals = raw.filter((i) => i.type === "signal" && !i.archived);
  const others = deduplicateInboxItems(raw.filter((i) => i.type !== "signal"));
  return [...signals, ...others];
}

export function SmartInboxPage({ headerAccessory }: { headerAccessory?: ReactNode }) {
  const { t } = useT("inbox");
  const wsId = useWorkspaceId();
  const { data: raw = [], isLoading } = useQuery(inboxListOptions(wsId));
  const markRead = useMarkInboxRead();
  const archive = useArchiveInbox();
  // Re-rank once a minute so waiting entries climb while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const sections = useMemo(
    () => buildSmartSections(smartInboxItems(raw), now),
    [raw, now],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const open = useMemo(() => {
    for (const s of sections) {
      const hit = s.entries.find((e) => e.item.id === openId);
      if (hit) return hit;
    }
    return null;
  }, [sections, openId]);

  const openEntry = (entry: SmartEntry) => {
    setOpenId(entry.item.id);
    if (!entry.item.read) markRead.mutate(entry.item.id);
  };
  const handleArchive = (id: string) => {
    setOpenId(null);
    archive.mutate(id, {
      onSuccess: () => toast.success(t(($) => $.toasts.archived)),
      onError: () => toast.error(t(($) => $.errors.archive_failed)),
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
        </div>
        {headerAccessory}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-2xl pb-6">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : sections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Inbox className="mb-3 h-8 w-8 text-faint-foreground" />
              <p className="text-body">{t(($) => $.smart.empty)}</p>
            </div>
          ) : (
            sections.map((section) => (
              <section key={section.id} aria-labelledby={`smart-${section.id}`} className="pt-3">
                <h2
                  id={`smart-${section.id}`}
                  className={cn("pb-1 text-caption font-medium text-muted-foreground", PAGE_GUTTER)}
                >
                  <SectionTitle id={section.id} /> · {section.entries.length}
                </h2>
                <ul>
                  {section.entries.map((entry) => (
                    <SmartInboxRow
                      key={entry.item.id}
                      entry={entry}
                      showReason={section.id === "waiting"}
                      onOpen={() => openEntry(entry)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ id }: { id: SmartSectionId }) {
  const { t } = useT("inbox");
  return <>{t(($) => $.smart.sections[id])}</>;
}

function useLine2() {
  const typeLabels = useTypeLabels();
  return (entry: SmartEntry): string => {
    if (entry.signal) return entry.signal.summary;
    const preview = (entry.item.body ?? "").replace(/\s+/g, " ").trim();
    return preview || typeLabels[entry.item.type] || entry.item.type;
  };
}

function useReasonText() {
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
}: {
  entry: SmartEntry;
  showReason: boolean;
  onOpen: () => void;
}) {
  const line2 = useLine2();
  const reasonText = useReasonText();
  const timeAgo = useTimeAgo();
  const unread = !entry.item.read;
  return (
    <li className={cn("flex w-full items-center gap-2 py-1", PAGE_GUTTER)}>
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
          <span className={cn("min-w-0 flex-1 truncate text-body", unread && "font-medium")}>
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
    </li>
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
  const line2 = useLine2();
  const reasonText = useReasonText();
  const { item, signal } = entry;
  const body = signal ? item.body : null;
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
          <header className="space-y-1">
            <h1 className="break-words text-title font-semibold">{getInboxDisplayTitle(item)}</h1>
            <p className="break-words text-body text-muted-foreground">{line2(entry)}</p>
            <p className="text-caption text-muted-foreground">{reasonText(entry)}</p>
          </header>
          {body && (
            <p className="whitespace-pre-wrap break-words text-body">{body}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {signal?.actions.map((action, i) => (
              <Button
                key={`${action.url}-${i}`}
                variant={i === 0 ? "default" : "outline"}
                className={TAP}
                render={<a href={action.url} target="_blank" rel="noopener noreferrer" />}
                nativeButton={false}
              >
                <span className="truncate">{action.label}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </Button>
            ))}
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
