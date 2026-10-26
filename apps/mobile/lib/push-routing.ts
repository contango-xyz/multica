/**
 * Push notification payload → screen. Mirrors getInboxNavigationTarget
 * (lib/inbox-display.ts) so a tap lands where tapping the inbox row would.
 * The server puts routing data under `body` (the key expo-notifications
 * exposes as content.data); top-level data is accepted too.
 */
import type { InboxItem } from "@multica/core/types";
import { getInboxNavigationTarget } from "./inbox-display";

export type PushData =
  | { kind: "inbox"; workspace_slug: string; item_id: string; type?: string; issue_id?: string; comment_id?: string }
  | { kind: "chat"; workspace_slug: string; session_id: string };

export type PushTarget =
  | { pathname: "/[workspace]/issue/[id]"; params: { workspace: string; id: string; highlight?: string } }
  | { pathname: "/[workspace]/inbox/[id]"; params: { workspace: string; id: string } }
  | { pathname: "/[workspace]/inbox"; params: { workspace: string } }
  | { pathname: "/[workspace]/chat"; params: { workspace: string }; chatSessionId: string };

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

export function parsePushData(raw: unknown): PushData | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const src = obj.body && typeof obj.body === "object" ? (obj.body as Record<string, unknown>) : obj;
  const workspace_slug = str(src.workspace_slug);
  if (!workspace_slug) return null;
  if (src.kind === "inbox") {
    const item_id = str(src.item_id);
    if (!item_id) return null;
    const type = str(src.type);
    const issue_id = str(src.issue_id);
    const comment_id = str(src.comment_id);
    return {
      kind: "inbox",
      workspace_slug,
      item_id,
      ...(type ? { type } : {}),
      ...(issue_id ? { issue_id } : {}),
      ...(comment_id ? { comment_id } : {}),
    };
  }
  if (src.kind === "chat") {
    const session_id = str(src.session_id);
    return session_id ? { kind: "chat", workspace_slug, session_id } : null;
  }
  return null;
}

export function pushTarget(data: PushData): PushTarget {
  const workspace = data.workspace_slug;
  if (data.kind === "chat") {
    return { pathname: "/[workspace]/chat", params: { workspace }, chatSessionId: data.session_id };
  }
  // Same rule as tapping the inbox row; a push only carries the fields it needs.
  const row = getInboxNavigationTarget(
    {
      id: data.item_id,
      type: data.type,
      issue_id: data.issue_id ?? null,
      details: data.comment_id ? { comment_id: data.comment_id } : {},
    } as unknown as InboxItem,
    workspace,
    "",
  );
  if (row?.pathname === "/[workspace]/issue/[id]") {
    return {
      pathname: row.pathname,
      params: { workspace, id: row.params.id, ...(data.comment_id ? { highlight: data.comment_id } : {}) },
    };
  }
  if (row?.pathname === "/[workspace]/inbox/[id]") {
    return { pathname: row.pathname, params: { workspace, id: row.params.id } };
  }
  return { pathname: "/[workspace]/inbox", params: { workspace } };
}

export function shouldPresentInForeground(
  data: PushData | null,
  ctx: { activeChatSessionId: string | null; onChatTab: boolean },
): boolean {
  if (data?.kind !== "chat") return true;
  return !(ctx.onChatTab && ctx.activeChatSessionId === data.session_id);
}

/**
 * Returns a gate that admits each key once. Notification taps are keyed by
 * the notification id: getLastNotificationResponseAsync keeps returning the
 * last tap, and the workspace layout remounts on every workspace switch.
 */
export function createOnceGate(): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
