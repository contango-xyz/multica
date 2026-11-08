"use client";

import { memo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, TriangleAlert } from "@multica/ui/icons";
import { issueSystemWakeupsOptions, issueWakeupsOptions } from "@multica/core/issues";
import type { IssueWakeup, SystemWakeup } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { useWakeupText } from "./wakeup-presentation";
import { IssueRef, waitedIssue, type WaitedIssue } from "./wait-issue-links";

const CHIP_CLASS = "inline-flex h-7 max-w-72 min-w-0 items-center rounded-full border border-border text-caption hover:bg-accent";

/**
 * The chip when it waits on another issue. A link can't live inside the chip's
 * button, so the label is a link and the icon and count still open the Wakeups
 * section.
 */
function WaitedIssueChip({
  issue,
  label,
  count,
  openLabel,
  onOpen,
}: {
  issue: WaitedIssue;
  label: string;
  count: number;
  openLabel: string;
  onOpen: () => void;
}) {
  return (
    <span className={cn(CHIP_CLASS, "text-foreground")}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        className="inline-flex h-full shrink-0 items-center rounded-l-full pl-2.5 pr-1.5 max-sm:rounded-full max-sm:pr-2.5 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Bell className="size-3.5" aria-hidden="true" />
      </button>
      <span title={label} className={cn("min-w-0 truncate max-sm:hidden", count > 1 ? "pr-1.5" : "pr-2.5")}>
        <IssueRef routeId={issue.id} tabTitle={issue.identifier}>
          {label}
        </IssueRef>
      </span>
      {count > 1 && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel}
          className="inline-flex h-full shrink-0 items-center rounded-r-full pr-2.5 tabular-nums text-muted-foreground max-sm:pl-0 focus-visible:outline-2 focus-visible:outline-ring"
        >
          +{count - 1}
        </button>
      )}
    </span>
  );
}

/**
 * Picks what the header says an issue is waiting for: the first rule waiting
 * on an event or condition, else the soonest scheduled one, else the
 * sub-issue system rule. A rule the platform paused is shown only when
 * nothing else is waiting, because it needs someone to look at it.
 */
export function primaryWakeup(rules: readonly IssueWakeup[], system: readonly SystemWakeup[]) {
  const enabled = rules.filter((w) => w.enabled);
  const waiting = enabled.filter((w) => w.kind === "event");
  const scheduled = enabled
    .filter((w) => w.kind !== "event")
    .sort((a, b) => Date.parse(a.next_fire_at ?? "") - Date.parse(b.next_fire_at ?? ""));
  const systemRule = system.find((r) => r.enabled && !r.blocked && r.target);
  const count = enabled.length + (systemRule ? 1 : 0);
  const rule = waiting[0] ?? scheduled[0];
  if (rule) return { kind: "rule" as const, rule, count };
  if (systemRule) return { kind: "system" as const, rule: systemRule, count };
  const paused = rules.find((w) => !w.enabled && w.paused_reason);
  if (paused) return { kind: "paused" as const, rule: paused, count: 1 };
  return null;
}

/**
 * One line in the issue header saying what the issue is waiting for, e.g.
 * "Emacs is waiting for Jiayuan to reply +2". Opens the Wakeups section.
 */
export const IssueWakeupHeaderChip = memo(function IssueWakeupHeaderChip({
  issueId,
  onOpen,
}: {
  issueId: string;
  onOpen: () => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const text = useWakeupText();
  const { data: rules = [] } = useQuery(issueWakeupsOptions(wsId, issueId));
  const { data: system = [] } = useQuery(issueSystemWakeupsOptions(wsId, issueId));
  const primary = primaryWakeup(rules, system);
  if (!primary) return null;
  const label = String(
    primary.kind === "rule"
      ? text.headline(primary.rule)
      : primary.kind === "system"
        ? t(($) => $.wakeups.wait.header, {
            agent: primary.rule.target?.name ?? "",
            what:
              primary.rule.staged && primary.rule.stage !== null
                ? t(($) => $.wakeups.wait.children_stage, { stage: primary.rule.stage })
                : t(($) => $.wakeups.wait.children_all),
          })
        : t(($) => $.wakeups.wait.paused),
  );
  const Icon = primary.kind === "paused" ? TriangleAlert : Bell;
  const waited = primary.kind === "rule" ? waitedIssue(primary.rule) : null;
  const openLabel = `${label}${primary.count > 1 ? ` +${primary.count - 1}` : ""} · ${t(($) => $.wakeups.wait.open)}`;
  if (waited) {
    return <WaitedIssueChip issue={waited} label={label} count={primary.count} openLabel={openLabel} onOpen={onOpen} />;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      aria-label={openLabel}
      className={cn(
        CHIP_CLASS,
        "gap-1.5 px-2.5 focus-visible:outline-2 focus-visible:outline-ring",
        primary.kind === "paused" ? "text-warning" : "text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate max-sm:hidden">{label}</span>
      {primary.count > 1 && (
        <span className="shrink-0 tabular-nums text-muted-foreground">+{primary.count - 1}</span>
      )}
    </button>
  );
});
