"use client";

import { memo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { useWorkspaceId } from "@multica/core/hooks";
import { propertyListOptions } from "@multica/core/properties";
import type { AgentTask, Issue } from "@multica/core/types";
import { Clock3, TriangleAlert } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { selectIssueTasks } from "../surface/activity";

/** Workspace custom property an ops job fills with why a card is idle. */
const WAITING_ON_PROPERTY_NAME = "Waiting on";
const WARNING_PREFIX = /^⚠️?\s*/;

/** Same test as the activity badge: it shows "Working" or "Queued". */
function selectHasActiveTask(snapshot: AgentTask[], issueId: string) {
  const { running, queued } = selectIssueTasks(snapshot, issueId);
  return running.length + queued.length > 0;
}

const WaitingOnLine = memo(function WaitingOnLine({
  issueId,
  value,
  className,
}: {
  issueId: string;
  value: string;
  className?: string;
}) {
  const wsId = useWorkspaceId();
  const select = useCallback(
    (snapshot: AgentTask[]) => selectHasActiveTask(snapshot, issueId),
    [issueId],
  );
  // A boolean select, so a snapshot change re-renders only the lines it flips.
  const { data: agentActive = false } = useQuery({
    ...agentTaskSnapshotOptions(wsId),
    select,
  });
  if (agentActive) return null;

  const isWarning = WARNING_PREFIX.test(value);
  const Icon = isWarning ? TriangleAlert : Clock3;
  return (
    <span
      data-slot="issue-waiting-on"
      title={value}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-micro",
        isWarning ? "text-warning" : "text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {isWarning ? value.replace(WARNING_PREFIX, "") : value}
      </span>
    </span>
  );
});

/**
 * One line on a board card or list row saying why nothing is happening on the
 * issue: its "Waiting on" custom property. Renders nothing (no placeholder)
 * while the value is empty or an agent is on the issue.
 *
 * Every row reads the one shared property-list query, and only rows that
 * carry a value subscribe to the task snapshot.
 */
export function IssueWaitingOn({
  issue,
  className,
}: {
  issue: Pick<Issue, "id" | "properties">;
  className?: string;
}) {
  const wsId = useWorkspaceId();
  const { data: properties = [] } = useQuery(propertyListOptions(wsId));
  const property = properties.find((p) => p.name === WAITING_ON_PROPERTY_NAME);
  const raw = property ? issue.properties?.[property.id] : undefined;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  return <WaitingOnLine issueId={issue.id} value={value} className={className} />;
}
