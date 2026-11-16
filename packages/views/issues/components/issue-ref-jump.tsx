"use client";

import { useCallback, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueStatusCategory } from "@multica/core/issues";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { isImeComposing } from "@multica/core/utils";
import { CornerDownLeft, Loader2, Search, X } from "@multica/ui/icons";
import { Input } from "@multica/ui/components/ui/input";
import { IconButton } from "@multica/ui/components/common/icon-button";
import { cn } from "@multica/ui/lib/utils";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useIssueRefLookup, type IssueRefLookup } from "../hooks/use-issue-ref-lookup";
import { StatusIcon } from "./status-icon";

/**
 * Find an issue by id from a search box (contango patch 50).
 *
 * Wraps a search input: when what is typed reads as an issue id of this
 * workspace (`CTG-2850`, `ctg 2850`, `#2850`, `2850`, a pasted link), a pinned
 * "Go to" row opens under the box with that exact issue, whatever its status
 * and whatever the screen's filters hide, or says the id doesn't exist. Enter
 * in the box opens it (Cmd/Ctrl+Enter: new tab on desktop).
 *
 * The lookup is an exact indexed read (`useIssueRefLookup`), never the
 * full-text search.
 */
export function IssueRefJump({
  query,
  onOpened,
  showHint = false,
  className,
  children,
}: {
  query: string;
  /** Called after the issue opened, e.g. to clear a box that only jumps. */
  onOpened?: () => void;
  /** Explain what the box takes when the text is not an id. */
  showHint?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const lookup = useIssueRefLookup(query);
  const open = useOpenIssueRef(onOpened);
  const [focused, setFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || isImeComposing(event)) return;
    // While the lookup is in flight Enter opens the id's page all the same.
    if (lookup.state !== "found" && lookup.state !== "loading") return;
    event.preventDefault();
    open(lookup.identifier, event.metaKey || event.ctrlKey);
  };
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setFocused(false);
  };

  const showRow = focused && (lookup.state !== "none" || (showHint && query.trim().length > 0));

  return (
    <div
      ref={rootRef}
      className={cn("relative", className)}
      onKeyDown={handleKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    >
      {children}
      {showRow && (
        <div
          data-issue-ref-jump
          className="absolute left-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <IssueRefJumpRow lookup={lookup} onOpen={open} />
        </div>
      )}
    </div>
  );
}

function useOpenIssueRef(onOpened?: () => void) {
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  return useCallback(
    (identifier: string, newTab = false) => {
      const path = paths.issueDetail(identifier);
      if (newTab && navigation.openInNewTab) navigation.openInNewTab(path, identifier);
      else navigation.push(path);
      onOpened?.();
    },
    [navigation, onOpened, paths],
  );
}

/** The pinned row: the issue to open, a lookup in flight, or "doesn't exist". */
export function IssueRefJumpRow({
  lookup,
  onOpen,
}: {
  lookup: IssueRefLookup;
  onOpen: (identifier: string, newTab?: boolean) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const workspace = useCurrentWorkspace();
  const { colorOf, iconOf } = useIssueStatuses(wsId);
  const muted = "flex min-h-8 items-center gap-2 px-2 py-1 text-caption text-muted-foreground";

  if (lookup.state === "none") {
    const example = `${workspace?.issue_prefix || "MUL"}-123`;
    return <div className={muted}>{t(($) => $.id_jump.hint, { example })}</div>;
  }
  if (lookup.state === "loading") {
    return (
      <div className={muted} role="status">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        {t(($) => $.id_jump.looking_up, { identifier: lookup.identifier })}
      </div>
    );
  }
  if (lookup.state !== "found") {
    return (
      <div className={muted} role="status">
        {lookup.state === "missing"
          ? t(($) => $.id_jump.missing, { identifier: lookup.identifier })
          : t(($) => $.id_jump.failed, { identifier: lookup.identifier })}
      </div>
    );
  }

  const { issue } = lookup;
  const handleClick = (event: MouseEvent<HTMLButtonElement>) =>
    onOpen(lookup.identifier, event.metaKey || event.ctrlKey);
  return (
    <button
      type="button"
      // Keep focus in the search box, so the row is still there on mouseup.
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleClick}
      aria-label={t(($) => $.id_jump.go_to, { identifier: lookup.identifier })}
      className="flex min-h-8 w-full items-center gap-2 rounded-sm bg-accent px-2 py-1 text-left text-body outline-none hover:bg-accent/80 focus-visible:ring-1 focus-visible:ring-ring"
    >
      <StatusIcon
        status={issue.status}
        color={colorOf(issue.status)}
        icon={iconOf(issue.status)}
        category={issueStatusCategory(issue) ?? undefined}
        className="size-4 shrink-0"
      />
      <span className="shrink-0 text-caption font-medium text-muted-foreground">{lookup.identifier}</span>
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      <span className="flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
        {t(($) => $.id_jump.open)}
        <CornerDownLeft className="size-3" />
      </span>
    </button>
  );
}

/**
 * "Go to ID" box for issue screens without a search box of their own (board,
 * list, swimlane). It only jumps: it never filters the screen.
 */
export function IssueIdJumpInput({ className }: { className?: string }) {
  const { t } = useT("issues");
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const clear = useCallback(() => {
    setValue("");
    inputRef.current?.blur();
  }, []);
  const label = t(($) => $.id_jump.placeholder);

  return (
    <IssueRefJump query={value} onOpened={clear} showHint className={cn("shrink-0", className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        type="text"
        role="searchbox"
        inputMode="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isImeComposing(event)) {
            event.preventDefault();
            clear();
          }
        }}
        aria-label={label}
        placeholder={label}
        className="h-7 w-28 pl-7 pr-6 text-caption transition-[width] focus:w-44"
      />
      {value && (
        <IconButton
          type="button"
          variant="ghost"
          size="icon-xs"
          label={t(($) => $.table.search_clear)}
          tooltipSide="bottom"
          onClick={() => setValue("")}
          className="absolute right-0.5 top-0.5 text-muted-foreground"
        >
          <X className="size-3" />
        </IconButton>
      )}
    </IssueRefJump>
  );
}
