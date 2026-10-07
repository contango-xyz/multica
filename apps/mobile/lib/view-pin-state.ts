/**
 * What a pinned saved view renders as. Mobile only loads the workspace
 * Issues page's views, so a pin it can't find may be a "My issues"/project
 * view or a failed load — never treat that as deleted (tapping a missing pin
 * unpins it on the server, i.e. on web too).
 */
export type ViewPinState =
  | { kind: "loading" }
  | { kind: "view"; name: string }
  | { kind: "unavailable" };

export function viewPinState(
  query: { status: "pending" | "error" | "success"; data: { id: string; name: string }[] | undefined },
  viewId: string,
): ViewPinState {
  if (query.status === "pending") return { kind: "loading" };
  const view = query.status === "success" ? query.data?.find((v) => v.id === viewId) : undefined;
  return view ? { kind: "view", name: view.name } : { kind: "unavailable" };
}
