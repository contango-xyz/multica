import type { ReactNode } from "react";
import { Users } from "@multica/ui/icons";

/**
 * A role group mention (`mention://group/<id>`, contango patch 48): styled like
 * a person's mention, with a people glyph so "@devops" reads as a group. It has
 * no hover card or link; the server expands it to whoever is on duty.
 */
export function GroupMentionChip({ children }: { children: ReactNode }) {
  return (
    <span className="mention whitespace-nowrap" data-mention-type="group">
      <Users className="mr-0.5 inline size-3 align-[-0.125em]" />
      {children}
    </span>
  );
}
