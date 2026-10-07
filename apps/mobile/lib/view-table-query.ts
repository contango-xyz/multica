/**
 * Saved view (or "All") → POST /api/issues/table/rows query. Mirrors the
 * filter mapping in web's packages/views/issues/surface/
 * use-issue-surface-controller.ts so a view returns the same issues on both
 * clients. The view blob is sanitised by core's baselineFromQuery first.
 *
 * The result is a plan, not always a query: the server reads an empty list
 * as "no filter", so a dimension that matches nothing must skip the request
 * ("empty"), and list/board surfaces wait for the status catalog ("pending")
 * exactly like web does before choosing which status columns to load.
 */
import type { IssueView } from "@multica/core/api/schemas";
import { baselineFromQuery } from "@multica/core/issue-views/baseline";
import { assigneeTypesForActorKind } from "@multica/core/issues/surface/scope";
import type {
  IssuePriority,
  IssueStatus,
  IssueStatusEntry,
  IssueTableFilters,
  IssueTableQuerySpec,
  IssueTableSortField,
} from "@multica/core/types";
import { BUILT_IN_STATUS_ORDER, isBuiltInIssueStatus } from "./issue-status";

export type IssuesChipSource = { kind: "all" } | { kind: "view"; view: IssueView };

export type IssuesQueryPlan =
  | { kind: "query"; spec: IssueTableQuerySpec }
  | { kind: "empty" }
  | { kind: "pending" };

export interface StatusCatalogLike {
  isLoaded: boolean;
  statuses: IssueStatusEntry[];
}

// Mirrors DEFAULT_HIDDEN_STATUSES in packages/core/issues/stores/view-store.ts.
// Saved views don't store hidden statuses, so web opens every view with these.
const DEFAULT_HIDDEN_STATUSES: readonly string[] = ["cancelled"];

export interface QuickFilter {
  statuses: IssueStatus[];
  priorities: IssuePriority[];
}

const SORT_FIELDS: readonly string[] = [
  "position", "status", "priority", "title", "created_at", "updated_at",
  "last_activity", "start_date", "due_date",
];
const DEFAULT_SORT = { field: "created_at", direction: "desc" } as const;

/** null = no constraint on this dimension; [] = match nothing. */
export function intersectFilter<T extends string>(fixed: T[], quick: T[]): T[] | null {
  if (fixed.length === 0 && quick.length === 0) return null;
  if (fixed.length === 0) return quick;
  if (quick.length === 0) return fixed;
  const q = new Set(quick);
  return fixed.filter((v) => q.has(v));
}

function sortFrom(display: Record<string, unknown>): IssueTableQuerySpec["sort"] {
  const field = display.sortBy;
  const direction = display.sortDirection;
  const validField =
    typeof field === "string" && (SORT_FIELDS.includes(field) || field.startsWith("property:"));
  if (!validField) return { ...DEFAULT_SORT };
  // Web never sends a direction for manual order, so it is always ascending.
  if (field === "position") return { field: "position", direction: "asc" };
  return {
    field: field as IssueTableSortField,
    direction: direction === "asc" || direction === "desc" ? direction : "desc",
  };
}

/**
 * Mirror of core's visibleStatusKeys (packages/core/issues/status-category.ts),
 * which mobile can't import (its module pulls web hooks). With an explicit
 * status filter: the filtered keys the catalog knows (archived/cancelled
 * included — an explicit pick restores them). Without: every active column
 * minus the default-hidden ones.
 */
function visibleStatuses(selected: IssueStatus[] | null, catalog: StatusCatalogLike): IssueStatus[] {
  const known = new Set(catalog.statuses.map((entry) => entry.key));
  if (selected) {
    return selected.filter((key) => isBuiltInIssueStatus(key) || known.has(key));
  }
  const active = [
    ...BUILT_IN_STATUS_ORDER.filter((key) => !known.has(key)),
    ...catalog.statuses.filter((entry) => !entry.archived_at).map((entry) => entry.key),
  ];
  return active.filter((key) => !DEFAULT_HIDDEN_STATUSES.includes(key));
}

export function buildIssueTableQuery(
  source: IssuesChipSource,
  quick: QuickFilter,
  catalog: StatusCatalogLike,
): IssuesQueryPlan {
  const view = source.kind === "view" ? source.view : null;
  const raw = baselineFromQuery(view?.query ?? {}).raw;
  const display = view?.display ?? {};

  const statuses = intersectFilter(raw.statusFilters, quick.statuses);
  const priorities = intersectFilter(raw.priorityFilters, quick.priorities);
  if (statuses?.length === 0 || priorities?.length === 0) return { kind: "empty" };

  const filters: IssueTableFilters = {};
  // Web's table layout lists every status; list/board (and "All") load only
  // the visible status columns, which needs the catalog.
  if (display.viewMode === "table") {
    if (statuses) filters.statuses = statuses;
  } else {
    if (!catalog.isLoaded) return { kind: "pending" };
    const visible = visibleStatuses(statuses, catalog);
    if (visible.length === 0) return { kind: "empty" };
    filters.statuses = visible;
  }
  if (priorities) filters.priorities = priorities;
  if (raw.assigneeFilters.length > 0) filters.assignees = raw.assigneeFilters;
  if (raw.includeNoAssignee) filters.include_no_assignee = true;
  if (raw.creatorFilters.length > 0) filters.creators = raw.creatorFilters;
  if (raw.projectFilters.length > 0) filters.project_ids = raw.projectFilters;
  if (raw.includeNoProject) filters.include_no_project = true;
  if (raw.projectStatusFilters.length > 0) filters.project_statuses = raw.projectStatusFilters;
  if (raw.labelFilters.length > 0) filters.label_ids = raw.labelFilters;
  if (Object.keys(raw.propertyFilters).length > 0) filters.properties = raw.propertyFilters;
  filters.include_sub_issues = display.showSubIssues !== false;

  const variant =
    view?.scope_variant === "members" || view?.scope_variant === "agents" ? view.scope_variant : undefined;
  const assigneeTypes = assigneeTypesForActorKind(variant);

  return {
    kind: "query",
    spec: {
      scope: { kind: "workspace", ...(assigneeTypes ? { assignee_types: assigneeTypes } : {}) },
      filters,
      sort: sortFrom(display),
    },
  };
}
