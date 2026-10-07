/**
 * Saved views on the Issues tab (read-only). Views + prefs are workspace
 * scope only — the chip row mirrors web's workspace Issues page.
 */
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { IssueTableQuerySpec } from "@multica/core/types";
import { api } from "@/data/api";

export const ISSUE_TABLE_PAGE_SIZE = 100;

export const issueViewKeys = {
  all: (wsId: string | null) => ["issue-views", wsId] as const,
  views: (wsId: string | null) => [...issueViewKeys.all(wsId), "list", "workspace"] as const,
  prefs: (wsId: string | null) => [...issueViewKeys.all(wsId), "prefs", "workspace"] as const,
  rowsAll: (wsId: string | null) => [...issueViewKeys.all(wsId), "rows"] as const,
  rows: (wsId: string | null, spec: IssueTableQuerySpec) => [...issueViewKeys.rowsAll(wsId), spec] as const,
};

export const issueViewListOptions = (wsId: string | null) =>
  queryOptions({
    queryKey: issueViewKeys.views(wsId),
    queryFn: ({ signal }) => api.listIssueViews({ scope_type: "workspace" }, { signal }),
    enabled: !!wsId,
  });

export const issueViewPrefOptions = (wsId: string | null) =>
  queryOptions({
    queryKey: issueViewKeys.prefs(wsId),
    queryFn: ({ signal }) => api.getIssueViewPreference({ scope_type: "workspace" }, { signal }),
    enabled: !!wsId,
  });

export const issueTableRowsInfiniteOptions = (wsId: string | null, spec: IssueTableQuerySpec) =>
  infiniteQueryOptions({
    queryKey: issueViewKeys.rows(wsId, spec),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.listIssueTableRows(
        {
          query: spec,
          group: { kind: "none" },
          group_key: null,
          hierarchy: { enabled: false },
          parent_id: null,
          page: { limit: ISSUE_TABLE_PAGE_SIZE, cursor: pageParam },
        },
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!wsId,
  });
