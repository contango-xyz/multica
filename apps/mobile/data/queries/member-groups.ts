import { queryOptions } from "@tanstack/react-query";
import { api } from "@/data/api";

// Role mention groups (contango patch 48). No realtime event announces a group
// edit, so the list refreshes after a few minutes instead of never.
export const memberGroupListOptions = (wsId: string | null) =>
  queryOptions({
    queryKey: ["member-groups", wsId] as const,
    queryFn: ({ signal }) => api.listMemberGroups({ signal }),
    enabled: !!wsId,
    staleTime: 5 * 60_000,
  });
