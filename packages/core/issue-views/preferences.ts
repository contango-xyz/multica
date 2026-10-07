"use client";

import { useCallback } from "react";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { IssueViewPreference } from "../api/schemas";
import { useWorkspaceSlug } from "../paths/hooks";
import { getCurrentSlug } from "../platform/workspace-storage";
import type { IssueViewScope } from "./queries";

/**
 * A preference container: a view surface, the user's starred sidebar views,
 * or the sidebar's Projects section.
 */
export type IssueViewPreferenceScope =
  | IssueViewScope
  | { scope_type: "sidebar" | "sidebar_projects"; scope_id?: null };

export { EMPTY_VIEW_BAR_PREFS, applyViewBarPrefs, type ViewBarPrefs } from "./view-bar-prefs";
import { EMPTY_VIEW_BAR_PREFS, type ViewBarPrefs } from "./view-bar-prefs";

/** A whole preference document; scopes other than view bars add their own keys. */
export type IssueViewPreferenceDoc = Partial<ViewBarPrefs> & Record<string, unknown>;

export const issueViewPrefKeys = {
  all: (wsId: string) => ["issue-view-prefs", wsId] as const,
  scope: (wsId: string, scope: IssueViewPreferenceScope) =>
    [...issueViewPrefKeys.all(wsId), scope.scope_type, scope.scope_id ?? null] as const,
};

export function issueViewPreferenceOptions(wsId: string, scope: IssueViewPreferenceScope) {
  return queryOptions({
    queryKey: issueViewPrefKeys.scope(wsId, scope),
    queryFn: () => api.getIssueViewPreference(scope),
    enabled: !!wsId,
  });
}

interface PreferenceWrite {
  prefs: IssueViewPreferenceDoc;
  workspaceId: string;
  workspaceSlug?: string;
}

/**
 * Whole-document upsert with an optimistic patch: show/hide toggles and
 * drag-reorder are the canonical optimistic case (locally predictable, same
 * screen, trivial rollback). Returns `save(prefs)`.
 */
export function useUpdateIssueViewPreference(wsId: string, scope: IssueViewPreferenceScope) {
  const queryClient = useQueryClient();
  const routeSlug = useWorkspaceSlug();
  const queryKey = issueViewPrefKeys.scope(wsId, scope);
  const { mutate } = useMutation({
    mutationKey: queryKey,
    // Each write replaces the whole document and builds on the one before it,
    // so writes to one document go out one at a time, in order: run side by
    // side, an older write could land last and undo a newer one.
    scope: { id: queryKey.join(":") },
    // A queued write can go out after the user has switched workspace, so the
    // write names its own workspace rather than inherit the current one.
    mutationFn: ({ prefs, workspaceSlug }: PreferenceWrite) =>
      api.putIssueViewPreference({ ...scope, prefs }, workspaceSlug),
    onMutate: async ({ prefs, workspaceId }) => {
      const key = issueViewPrefKeys.scope(workspaceId, scope);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<IssueViewPreference>(key);
      const optimistic: IssueViewPreference = {
        scope_type: scope.scope_type,
        scope_id: scope.scope_id ?? null,
        // Non-empty: an empty updated_at means "never saved" to readers.
        updated_at: previous?.updated_at || new Date().toISOString(),
        prefs: { ...EMPTY_VIEW_BAR_PREFS, ...prefs },
      };
      queryClient.setQueryData<IssueViewPreference>(key, optimistic);
      return { previous };
    },
    onError: (_err, { workspaceId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(issueViewPrefKeys.scope(workspaceId, scope), context.previous);
      }
    },
    onSettled: (_data, _err, { workspaceId }) => {
      const key = issueViewPrefKeys.scope(workspaceId, scope);
      // A later write still queued refetches when it settles; refetching now
      // could paint this older document over its optimistic one.
      if (queryClient.isMutating({ mutationKey: key, exact: true }) === 1) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
  return useCallback(
    (prefs: IssueViewPreferenceDoc) =>
      mutate({ prefs, workspaceId: wsId, workspaceSlug: routeSlug ?? getCurrentSlug() ?? undefined }),
    [mutate, wsId, routeSlug],
  );
}
