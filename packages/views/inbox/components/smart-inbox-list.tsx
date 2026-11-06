"use client";

// Smart inbox list for the two-pane layout (contango, docs/contango/SMART-INBOX.md):
// Classic's rows, grouped into Smart's ranked sections. Selection, archive and
// the row context menu are the classic ones; each section header adds its
// count, its top entry's reason and section actions.

import { useCallback, useRef, type KeyboardEvent } from "react";
import { Archive, CheckCheck, ChevronRight, Inbox, MoreHorizontal } from "@multica/ui/icons";
import { inboxRowKey } from "@multica/core/inbox/filter-store";
import { ageTint, type SmartEntry, type SmartSection } from "@multica/core/inbox/smart";
import { isEditableShortcutTarget } from "@multica/core/shortcuts";
import { isImeComposing } from "@multica/core/utils";
import type { InboxItem } from "@multica/core/types";
import { IconButton } from "@multica/ui/components/common/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { useT } from "../../i18n";
import { InboxListItem } from "./inbox-list-item";
import { useReasonText } from "./smart-inbox";

export function SmartInboxList({
  sections,
  selectedKey,
  onSelect,
  onAction,
  onArchiveSection,
  onMarkSectionRead,
  onOpenArchived,
  emptyLabel,
}: {
  sections: SmartSection[];
  selectedKey: string;
  onSelect: (item: InboxItem) => void;
  onAction: (id: string) => void;
  onArchiveSection: (entries: SmartEntry[]) => void;
  onMarkSectionRead: (entries: SmartEntry[]) => void;
  onOpenArchived: () => void;
  emptyLabel?: string;
}) {
  const { t } = useT("inbox");
  const scrollRef = useRef<HTMLDivElement>(null);
  const flat = sections.flatMap((s) => s.entries.map((e) => e.item));

  const select = useCallback(
    (item: InboxItem) => {
      scrollRef.current?.focus({ preventScroll: true });
      onSelect(item);
    },
    [onSelect],
  );

  // Arrow keys walk the rows across sections, like Classic's list.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.defaultPrevented || isImeComposing(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isEditableShortcutTarget(event.target)) return;
    event.preventDefault();
    const current = flat.findIndex((item) => inboxRowKey(item) === selectedKey);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      current < 0
        ? step === 1 ? 0 : flat.length - 1
        : Math.min(Math.max(current + step, 0), flat.length - 1);
    const item = flat[next];
    if (!item || next === current) return;
    scrollRef.current
      ?.querySelector(`[data-inbox-row-key="${CSS.escape(inboxRowKey(item))}"]`)
      ?.scrollIntoView({ block: "nearest" });
    onSelect(item);
  };

  const archivedEntry = (
    <button
      type="button"
      onClick={onOpenArchived}
      className="mt-1 flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-caption text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex size-7 shrink-0 items-center justify-center">
        <Archive className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{t(($) => $.list.archived_title)}</span>
      <ChevronRight className="size-4 shrink-0 text-faint-foreground" />
    </button>
  );

  return (
    <div
      ref={scrollRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden outline-none"
    >
      <div className="px-2 py-1">
        {sections.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Inbox className="mb-3 h-8 w-8 text-faint-foreground" />
            <p className="text-body">{emptyLabel ?? t(($) => $.smart.empty)}</p>
          </div>
        ) : (
          sections.map((section) => (
            <SmartListSection
              key={section.id}
              section={section}
              selectedKey={selectedKey}
              onSelect={select}
              onAction={onAction}
              onArchiveSection={() => onArchiveSection(section.entries)}
              onMarkSectionRead={() => onMarkSectionRead(section.entries)}
            />
          ))
        )}
        {archivedEntry}
      </div>
    </div>
  );
}

function SmartListSection({
  section,
  selectedKey,
  onSelect,
  onAction,
  onArchiveSection,
  onMarkSectionRead,
}: {
  section: SmartSection;
  selectedKey: string;
  onSelect: (item: InboxItem) => void;
  onAction: (id: string) => void;
  onArchiveSection: () => void;
  onMarkSectionRead: () => void;
}) {
  const { t } = useT("inbox");
  const reasonText = useReasonText();
  const headingId = `smart-section-${section.id}`;
  const top = section.entries[0]!;
  return (
    <section aria-labelledby={headingId} className="pt-2 first:pt-1">
      <div className="flex items-center gap-1 px-2">
        <h2
          id={headingId}
          className="flex min-w-0 flex-1 items-center whitespace-nowrap py-1 text-caption text-muted-foreground"
        >
          <span className="font-medium text-foreground">{t(($) => $.smart.sections[section.id])}</span>
          <span className="tabular-nums">&nbsp;· {section.entries.length}</span>
          <span className="min-w-0 truncate">&nbsp;· {reasonText(top)}</span>
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                label={t(($) => $.smart.section_actions)}
                tooltipSide="bottom"
                size="icon-xs"
                className="shrink-0 text-muted-foreground"
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuItem onClick={onMarkSectionRead}>
              <CheckCheck className="h-4 w-4" />
              {t(($) => $.smart.mark_section_read)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onArchiveSection}>
              <Archive className="h-4 w-4" />
              {t(($) => $.smart.archive_section)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ul>
        {section.entries.map((entry) => {
          const key = inboxRowKey(entry.item);
          return (
            <li key={entry.item.id} data-inbox-row-key={key}>
              <InboxListItem
                item={entry.item}
                view="inbox"
                isSelected={key === selectedKey}
                inSmartSection
                priority={
                  entry.reason.priority === "urgent" || entry.reason.priority === "high"
                    ? entry.reason.priority
                    : undefined
                }
                ageTint={ageTint(entry)}
                waitingSince={entry.signal?.rank.since ?? undefined}
                onClick={() => onSelect(entry.item)}
                onAction={() => onAction(entry.item.id)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
