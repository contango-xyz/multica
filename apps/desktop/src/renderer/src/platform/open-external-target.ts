import { getActiveTab, splitTabUrl, useTabStore } from "../stores/tab-store";

// Notification clicks and opened links name an exact target (a chat session,
// an inbox selection). Tab dedup focuses an existing tab for the same page
// and keeps that tab's own URL as its view state, which is right for in-app
// opens but here would show the previously selected item. After the normal
// navigation, move a focused tab of the same page onto the exact target.
export function openExternalTarget(path: string, push: (path: string) => void): void {
  push(path);
  const store = useTabStore.getState();
  const active = getActiveTab(store);
  if (!active || active.url === path) return;
  if (splitTabUrl(active.url).pathname !== splitTabUrl(path).pathname) return;
  store.navigateActiveSession(path);
}
