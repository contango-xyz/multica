import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

// Contango fork (patch 48): role mention groups (@devops, @fe, ...).

export const memberGroupKeys = {
  list: (wsId: string) => ["member-groups", wsId] as const,
};

// No realtime event announces a group edit, so the list goes stale after a
// few minutes instead of the default "never"; the next editor mount refreshes it.
const MEMBER_GROUPS_STALE_MS = 5 * 60_000;

export function memberGroupListOptions(wsId: string) {
  return queryOptions({
    queryKey: memberGroupKeys.list(wsId),
    queryFn: () => api.listMemberGroups(),
    enabled: !!wsId,
    staleTime: MEMBER_GROUPS_STALE_MS,
  });
}
