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

// Electron drops clicks on a push while the app runs: the click only activates
// the app, with nothing saying which push it was. A push received shortly
// before an activation is taken as the one clicked. A click from Notification
// Centre after the window only brings the app forward.
export const PUSH_CLICK_WINDOW_MS = 10_000;

export class RecentPush {
  private route: PushRoute | null = null;
  private at = 0;

  received(route: PushRoute | null, now = Date.now()): void {
    this.route = route;
    this.at = now;
  }

  takeOnActivate(now = Date.now()): PushRoute | null {
    const route = this.route && now - this.at <= PUSH_CLICK_WINDOW_MS ? this.route : null;
    this.route = null;
    return route;
  }
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
