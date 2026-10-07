/**
 * Collapsible status sections on the Issues tab. Collapsed statuses are
 * remembered per chip ("builtin:all" | "view:<uuid>") on the device — web
 * keeps its list collapse in browser storage, so there is nothing to sync.
 */
import type { IssueStatus } from "@multica/core/types";
import type { IssueSection } from "./group-issues-by-status";

export type CollapsedByChip = Record<string, IssueStatus[]>;

export interface CollapsibleSection extends IssueSection {
  /** Loaded rows in this status, also when collapsed. */
  count: number;
  collapsed: boolean;
}

export function toggleCollapsed(map: CollapsedByChip, chipId: string, status: IssueStatus): CollapsedByChip {
  const current = map[chipId] ?? [];
  const next = current.includes(status) ? current.filter((s) => s !== status) : [...current, status];
  return { ...map, [chipId]: next };
}

export function applyCollapsed(sections: IssueSection[], collapsed: IssueStatus[]): CollapsibleSection[] {
  const hidden = new Set(collapsed);
  return sections.map((section) => {
    const isCollapsed = hidden.has(section.status);
    return {
      status: section.status,
      data: isCollapsed ? [] : section.data,
      count: section.data.length,
      collapsed: isCollapsed,
    };
  });
}
