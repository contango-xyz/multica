"use client";

import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { IssueViewPreference } from "../api/schemas";
import type { IssueViewScope } from "./queries";

export { EMPTY_VIEW_BAR_PREFS, applyViewBarPrefs, type ViewBarPrefs } from "./view-bar-prefs";
import type { ViewBarPrefs } from "./view-bar-prefs";

export const issueViewPrefKeys = {
  all: (wsId: string) => ["issue-view-prefs", wsId] as const,
  scope: (wsId: string, scope: IssueViewScope) =>
    [...issueViewPrefKeys.all(wsId), scope.scope_type, scope.scope_id ?? null] as const,
};

export function issueViewPreferenceOptions(wsId: string, scope: IssueViewScope) {
  return queryOptions({
    queryKey: issueViewPrefKeys.scope(wsId, scope),
    queryFn: () => api.getIssueViewPreference(scope),
    enabled: !!wsId,
  });
}

/**
 * Whole-document upsert with an optimistic patch: show/hide toggles and
 * drag-reorder are the canonical optimistic case (locally predictable, same
 * screen, trivial rollback).
 */
export function useUpdateIssueViewPreference(wsId: string, scope: IssueViewScope) {
  const queryClient = useQueryClient();
  const queryKey = issueViewPrefKeys.scope(wsId, scope);
  return useMutation({
    mutationFn: (prefs: ViewBarPrefs) =>
      api.putIssueViewPreference({ ...scope, prefs }),
    onMutate: async (prefs) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<IssueViewPreference>(queryKey);
      const optimistic: IssueViewPreference = {
        scope_type: scope.scope_type,
        scope_id: scope.scope_id ?? null,
        updated_at: previous?.updated_at ?? "",
        prefs: { ...prefs },
      };
      queryClient.setQueryData<IssueViewPreference>(queryKey, optimistic);
      return { previous };
    },
    onError: (_err, _prefs, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}
