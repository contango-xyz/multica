import { deduplicateInboxItems } from "@multica/core/inbox/queries";
import type { InboxItem } from "@multica/core/types";

/**
 * The rows the Smart inbox lists (contango): every active signal on its own,
 * plus the other entries grouped per issue like the classic list.
 */
export function smartInboxItems(raw: InboxItem[]): InboxItem[] {
  const signals = raw.filter((i) => i.type === "signal" && !i.archived);
  const others = deduplicateInboxItems(raw.filter((i) => i.type !== "signal"));
  return [...signals, ...others];
}
