"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Issue, IssueDependencyRef } from "@multica/core/types";
import { issueStatusCategory } from "@multica/core/issues";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import { StatusIcon } from "./status-icon";
import { useT } from "../../i18n";

// Issue dependencies (Contango fork, issue_dependency): the server resolves both
// sides of every blocked-by edge into `issue.blocked_by` and `issue.blocks`, so
// these sections need no request of their own. Read-only: agents and people
// record dependencies with `multica issue dependency add|remove`.

/** "Blocked by" and "Blocks" in the issue sidebar; each hides when empty. */
export function IssueDependenciesSection({ issue }: { issue: Pick<Issue, "blocked_by" | "blocks"> }) {
  const { t } = useT("issues");
  return (
    <>
      <DependencyList
        title={t(($) => $.dependencies.blocked_by)}
        issues={issue.blocked_by ?? []}
      />
      <DependencyList title={t(($) => $.dependencies.blocks)} issues={issue.blocks ?? []} />
    </>
  );
}

function DependencyList({ title, issues }: { title: string; issues: IssueDependencyRef[] }) {
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { colorOf, iconOf } = useIssueStatuses(wsId);
  const [open, setOpen] = useState(true);
  if (issues.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen(!open)}
      >
        {title}{" "}
        <span className="rounded-xs bg-muted px-1 text-micro font-medium tabular-nums text-muted-foreground">
          {issues.length}
        </span>
        <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="pl-2">
          {issues.map((dep) => (
            <AppLink
              key={dep.id}
              href={paths.issueDetail(dep.id)}
              newTabTitle={dep.identifier}
              className="group flex items-center gap-1.5 rounded-md px-2 -mx-2 py-1.5 text-caption hover:bg-accent/50 transition-colors"
            >
              <StatusIcon
                status={dep.status}
                color={colorOf(dep.status)}
                icon={iconOf(dep.status)}
                category={issueStatusCategory(dep) ?? undefined}
                className="h-3.5 w-3.5 shrink-0"
              />
              <span className="text-muted-foreground shrink-0">{dep.identifier}</span>
              <span className="truncate group-hover:text-foreground">{dep.title}</span>
            </AppLink>
          ))}
        </div>
      )}
    </div>
  );
}

/** True while the dependency still holds: the other issue is neither done nor cancelled. */
export function isOpenDependency(dep: Pick<IssueDependencyRef, "status">): boolean {
  const category = issueStatusCategory(dep);
  return category !== "done" && category !== "closed";
}

/**
 * Compact "Blocked by N" / "Blocks N" beside the identifier in board cards and
 * list rows, counting only open issues. A plain span with a native tooltip
 * listing the identifiers: the row is already a link, and one anchor may not
 * contain another.
 */
export function IssueDependencyMarker({
  issue,
  className,
}: {
  issue: Pick<Issue, "blocked_by" | "blocks">;
  className?: string;
}) {
  const { t } = useT("issues");
  const blockedBy = (issue.blocked_by ?? []).filter(isOpenDependency);
  const blocks = (issue.blocks ?? []).filter(isOpenDependency);
  if (blockedBy.length === 0 && blocks.length === 0) return null;
  const list = (deps: IssueDependencyRef[]) => deps.map((d) => `${d.identifier} ${d.title}`).join("\n");
  return (
    <>
      {blockedBy.length > 0 && (
        <span
          title={list(blockedBy)}
          className={`inline-flex shrink-0 items-center rounded-full border border-warning/40 px-1.5 text-micro font-medium tabular-nums text-warning ${className ?? ""}`}
        >
          {t(($) => $.dependencies.blocked_by_count, { count: blockedBy.length })}
        </span>
      )}
      {blocks.length > 0 && (
        <span
          title={list(blocks)}
          className={`inline-flex shrink-0 items-center rounded-full bg-muted/60 px-1.5 text-micro font-medium tabular-nums text-muted-foreground ${className ?? ""}`}
        >
          {t(($) => $.dependencies.blocks_count, { count: blocks.length })}
        </span>
      )}
    </>
  );
}
