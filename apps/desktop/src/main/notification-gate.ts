/**
 * Main-process authority for native notification eligibility. Renderer focus
 * is window-local, so only main can answer whether any Multica window is in
 * the foreground and collapse the same realtime event from N renderers.
 */
export class NotificationGate {
  private readonly seenItemIds = new Set<string>();

  constructor(private readonly maxRememberedItems = 1_000) {}

  shouldShow(
    itemId: string,
    anyWindowFocused: boolean,
    pushActive = false,
  ): boolean {
    if (pushActive) return false; // APNs already shows this one
    const normalizedItemId = itemId.trim();
    if (!normalizedItemId) return false;
    if (this.seenItemIds.has(normalizedItemId)) return false;

    this.seenItemIds.add(normalizedItemId);
    if (this.seenItemIds.size > this.maxRememberedItems) {
      const oldest = this.seenItemIds.values().next().value;
      if (typeof oldest === "string") this.seenItemIds.delete(oldest);
    }
    return !anyWindowFocused;
  }
}

// An Electron Notification that gets garbage collected loses its click
// handler; macOS then only activates the app. Hold each one until it ends.
const retained = new Set<object>();
export function retainNotification(n: {
  once(e: "click" | "close", cb: () => void): unknown;
}): void {
  retained.add(n);
  const release = () => retained.delete(n);
  n.once("click", release);
  n.once("close", release);
}
export function retainedNotificationCount(): number {
  return retained.size;
}

export interface NativeNotificationPayload {
  slug: string;
  itemId: string;
  issueKey: string;
  title: string;
  body: string;
}

export function parseNativeNotificationPayload(
  value: unknown,
): NativeNotificationPayload | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const limits: Record<keyof NativeNotificationPayload, number> = {
    slug: 256,
    itemId: 256,
    issueKey: 256,
    title: 512,
    body: 2_000,
  };
  const result = {} as NativeNotificationPayload;
  for (const key of Object.keys(limits) as (keyof NativeNotificationPayload)[]) {
    const field = candidate[key];
    const mayBeEmpty = key === "slug" || key === "body";
    if (
      typeof field !== "string" ||
      (!mayBeEmpty && !field.trim()) ||
      field.length > limits[key]
    ) {
      return null;
    }
    result[key] = field;
  }
  return result;
}
