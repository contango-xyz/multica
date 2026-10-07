/**
 * Push lifecycle for a logged-in workspace session: register the device,
 * decide foreground presentation, route taps (also cold-start taps), keep
 * the app badge in sync with the unread inbox count. The badge is the total
 * across workspaces — the same number the server sends with each push.
 */
import { useEffect } from "react";
import { router, usePathname } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { registerForPush } from "@/data/push-registration";
import { inboxUnreadSummaryOptions } from "@/data/queries/inbox";
import { useChatSessionPickerStore } from "@/data/stores/chat-session-picker-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { parsePushData, pushTarget, shouldPresentInForeground } from "@/lib/push-routing";

let currentPathname = "";

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = parsePushData(notification.request.content.data);
    const show = shouldPresentInForeground(data, {
      activeChatSessionId: useChatSessionPickerStore.getState().activeSessionId,
      onChatTab: currentPathname.endsWith("/chat"),
    });
    return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: true };
  },
});

function openFromResponse(response: Notifications.NotificationResponse | null) {
  const data = parsePushData(response?.notification.request.content.data);
  if (!data) return;
  const target = pushTarget(data);
  if (target.pathname === "/[workspace]/chat") {
    useChatSessionPickerStore.getState().requestSelect(target.chatSessionId);
  }
  router.navigate({ pathname: target.pathname, params: target.params } as never);
}

export function usePushNotifications(): void {
  currentPathname = usePathname();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { data: unreadTotal } = useQuery({
    ...inboxUnreadSummaryOptions(wsId),
    select: (summary) => summary.reduce((sum, s) => sum + s.count, 0),
  });

  useEffect(() => {
    void registerForPush();
    void Notifications.getLastNotificationResponseAsync().then(openFromResponse);
    const sub = Notifications.addNotificationResponseReceivedListener(openFromResponse);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (typeof unreadTotal === "number") void Notifications.setBadgeCountAsync(unreadTotal);
  }, [unreadTotal]);
}
