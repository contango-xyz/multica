import type { InboxItem } from "../types";

// Contango patch 48: a `mentioned` item that reached the reader through a role
// group (@devops) carries `details.via_group = {id, handle}`. Details are typed
// as strings, but this one is an object on the wire, so it is read defensively.
export function viaGroupHandle(item: Pick<InboxItem, "type" | "details">): string | null {
  if (item.type !== "mentioned") return null;
  const raw: unknown = (item.details as Record<string, unknown> | null)?.via_group;
  if (!raw || typeof raw !== "object") return null;
  const handle = (raw as { handle?: unknown }).handle;
  return typeof handle === "string" && handle !== "" ? handle : null;
}
