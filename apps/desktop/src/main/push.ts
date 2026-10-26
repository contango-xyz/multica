import { pushNotifications } from "electron";

export type PushRoute =
  | { kind: "inbox"; slug: string; itemId: string; issueKey: string }
  | { kind: "chat"; slug: string; sessionId: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : "");

// Routing data from the server's APNs payload (`body`, see server/internal/push).
export function routeForPushPayload(userInfo: unknown): PushRoute | null {
  const body = (userInfo as { body?: Record<string, unknown> } | null)?.body;
  if (!body || typeof body !== "object") return null;
  const slug = str(body.workspace_slug);
  if (!slug) return null;
  if (body.kind === "inbox") {
    const itemId = str(body.item_id);
    if (!itemId) return null;
    return { kind: "inbox", slug, itemId, issueKey: str(body.issue_id) || itemId };
  }
  if (body.kind === "chat") {
    const sessionId = str(body.session_id);
    return sessionId ? { kind: "chat", slug, sessionId } : null;
  }
  return null;
}

// Mirrors `paths.workspace(slug).chatSession(id)` in packages/core/paths/paths.ts;
// main does not import @multica/core, so keep the two in sync by hand.
export function chatSessionPath(slug: string, sessionId: string): string {
  return `/${encodeURIComponent(slug)}/chat?session=${encodeURIComponent(sessionId)}`;
}

export async function registerForPush(): Promise<{ token: string } | { error: string }> {
  if (process.platform !== "darwin") return { error: "unsupported" };
  try {
    return { token: await pushNotifications.registerForAPNSNotifications() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
