"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { propertyListOptions } from "@multica/core/properties";
import type { IssuePropertyValues } from "@multica/core/types";
import { Clock3, TriangleAlert } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";

/** Workspace custom property an ops job fills with why a card is idle. */
const WAITING_ON_PROPERTY_NAME = "Waiting on";
const WARNING_PREFIX = /^⚠️?\s*/;

function WaitingOnLine({ properties }: { properties: IssuePropertyValues }) {
  const wsId = useWorkspaceId();
  const { data: definitions = [] } = useQuery(propertyListOptions(wsId));
  const definition = definitions.find((p) => p.name === WAITING_ON_PROPERTY_NAME);
  const raw = definition ? properties[definition.id] : undefined;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;

  const isWarning = WARNING_PREFIX.test(value);
  const Icon = isWarning ? TriangleAlert : Clock3;
  const tone = isWarning ? "text-warning" : "text-muted-foreground";
  return (
    <span
      data-slot="issue-waiting-on"
      title={value}
      className="inline-flex shrink-0 items-center gap-1"
    >
      <Icon className={cn("size-3", tone)} aria-hidden="true" />
      <span className={cn("max-w-36 truncate text-micro", tone)}>
        {isWarning ? value.replace(WARNING_PREFIX, "") : value}
      </span>
    </span>
  );
}

/**
 * The issue's "Waiting on" custom property, drawn like the wake label in the
 * agent activity indicator, which renders it as its last fallback. An issue
 * with no property values never subscribes to the shared property list.
 */
export function IssueWaitingOn({ properties }: { properties: IssuePropertyValues }) {
  if (Object.keys(properties).length === 0) return null;
  return <WaitingOnLine properties={properties} />;
}
