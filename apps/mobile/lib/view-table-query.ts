/**
 * Saved view (or "All") → POST /api/issues/table/rows query. Mirrors the
 * filter mapping in web's packages/views/issues/surface/
 * use-issue-surface-controller.ts so a view returns the same issues on both
 * clients. The view blob is sanitised by core's baselineFromQuery first.
 */
import type { IssueView } from "@multica/core/api/schemas";
import { baselineFromQuery } from "@multica/core/issue-views/baseline";
import { assigneeTypesForActorKind } from "@multica/core/issues/surface/scope";
import type {
  IssuePriority,
  IssueStatus,
  IssueTableFilters,
  IssueTableQuerySpec,
  IssueTableSortField,
} from "@multica/core/types";

export type IssuesChipSource = { kind: "all" } | { kind: "view"; view: IssueView };

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
  return {
    field: field as IssueTableSortField,
    direction: direction === "asc" || direction === "desc" ? direction : "desc",
  };
}

export function buildIssueTableQuery(source: IssuesChipSource, quick: QuickFilter): IssueTableQuerySpec {
  if (source.kind === "all") {
    const filters: IssueTableFilters = { include_sub_issues: true };
    const statuses = intersectFilter<IssueStatus>([], quick.statuses);
    const priorities = intersectFilter<IssuePriority>([], quick.priorities);
    if (statuses) filters.statuses = statuses;
    if (priorities) filters.priorities = priorities;
    return { scope: { kind: "workspace" }, filters, sort: { ...DEFAULT_SORT } };
  }

  const { view } = source;
  const raw = baselineFromQuery(view.query).raw;
  const variant =
    view.scope_variant === "members" || view.scope_variant === "agents" ? view.scope_variant : undefined;
  const assigneeTypes = assigneeTypesForActorKind(variant);

  const filters: IssueTableFilters = {};
  const statuses = intersectFilter(raw.statusFilters, quick.statuses);
  const priorities = intersectFilter(raw.priorityFilters, quick.priorities);
  if (statuses) filters.statuses = statuses;
  if (priorities) filters.priorities = priorities;
  if (raw.assigneeFilters.length > 0) filters.assignees = raw.assigneeFilters;
  if (raw.includeNoAssignee) filters.include_no_assignee = true;
  if (raw.creatorFilters.length > 0) filters.creators = raw.creatorFilters;
  if (raw.projectFilters.length > 0) filters.project_ids = raw.projectFilters;
  if (raw.includeNoProject) filters.include_no_project = true;
  if (raw.projectStatusFilters.length > 0) filters.project_statuses = raw.projectStatusFilters;
  if (raw.labelFilters.length > 0) filters.label_ids = raw.labelFilters;
  if (Object.keys(raw.propertyFilters).length > 0) filters.properties = raw.propertyFilters;
  filters.include_sub_issues = view.display.showSubIssues !== false;

  return {
    scope: { kind: "workspace", ...(assigneeTypes ? { assignee_types: assigneeTypes } : {}) },
    filters,
    sort: sortFrom(view.display),
  };
}
