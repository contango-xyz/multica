import type { MemberGroup } from "@multica/core/types";

/**
 * Role groups (contango patch 48) the @ suggestions offer for `query`, in the
 * server's order: matched on handle, name and description, like web's
 * mention-suggestion.tsx. They sit after @all and before people.
 */
export function matchMentionGroups(groups: readonly MemberGroup[], query: string): MemberGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  return groups.filter(
    (g) =>
      g.handle.toLowerCase().includes(q) ||
      g.name.toLowerCase().includes(q) ||
      g.description.toLowerCase().includes(q),
  );
}
