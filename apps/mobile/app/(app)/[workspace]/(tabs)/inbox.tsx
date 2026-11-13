import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  SectionList,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { InboxItem } from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Header } from "@/components/ui/header";
import { IconButton } from "@/components/ui/icon-button";
import { HeaderActions } from "@/components/ui/app-header-actions";
import { SwipeableInboxRow } from "@/components/inbox/swipeable-inbox-row";
import { inboxListOptions } from "@/data/queries/inbox";
import {
  useArchiveAllInbox,
  useArchiveAllReadInbox,
  useArchiveCompletedInbox,
  useArchiveInbox,
  useMarkAllInboxRead,
  useMarkInboxRead,
} from "@/data/mutations/inbox";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useAuthStore } from "@/data/auth-store";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";
import { useT } from "@/lib/i18n";
import {
  deduplicateInboxItems,
  getInboxNavigationTarget,
} from "@/lib/inbox-display";
import { buildSmartList } from "@/lib/smart-inbox";
import {
  ARCHIVE_CONFIRM_OVER,
  archiveIds,
  buildMobileInboxTabs,
  unreadIds,
  type InboxTab,
  type InboxTabsModel,
} from "@/lib/inbox-tabs";
import { useInboxTabsStore } from "@/data/inbox-tabs-store";
import {
  InboxTabPanel,
  InboxTabStrip,
  type TabActions,
} from "@/components/inbox/inbox-tabs";
import type { SmartEntry } from "@multica/core/inbox/smart";

/** The entries a tab's "…" actions act on (Squad has none). */
function tabEntries(model: InboxTabsModel, tab: InboxTab): SmartEntry[] {
  switch (tab) {
    case "today":
      return [...model.today.alerts, ...model.today.rows.flatMap((r) => r.entries)];
    case "decisions":
      return model.decisions.flatMap((r) => r.entries);
    case "merges":
      return [...model.merges.approval, ...model.merges.postMerge].flatMap((r) => r.entries);
    case "else":
      return model.else;
    case "squad":
      return [];
  }
}

export default function Inbox() {
  const { t } = useT("inbox");
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { colorScheme } = useColorScheme();
  const { data: rawItems, dataUpdatedAt, isLoading, error, refetch, isRefetching } = useQuery(
    inboxListOptions(wsId),
  );
  // Dedup + drop archived to match web/desktop. See CLAUDE.md
  // "Behavioral parity" → inbox dedup incident.
  const data = useMemo(
    () => deduplicateInboxItems(rawItems ?? []),
    [rawItems],
  );
  // Smart inbox (contango): the server flag on /api/me decides, as on web
  // and desktop where Smart is the flagged user's default. Mobile has no
  // Classic toggle. Ranked as of the list's last update (fetch, focus,
  // realtime, local write), not every minute like web.
  const smart = useAuthStore((s) => s.user?.smart_inbox === true);
  // Inbox tabs (contango patch 45): the server's inbox_tabs flag (needs
  // smart_inbox too, as on web) plus the device's Settings > Inbox choice.
  // Today is the home screen: the inbox always opens on it.
  const tabsFlag = useAuthStore((s) => s.user?.inbox_tabs === true);
  const tabsMode = useInboxTabsStore((s) => s.mode);
  const hydrateTabsMode = useInboxTabsStore((s) => s.hydrate);
  useEffect(() => hydrateTabsMode(), [hydrateTabsMode]);
  const tabs = smart && tabsFlag && tabsMode === "tabs";
  const [tab, setTab] = useState<InboxTab>("today");
  const sections = useMemo(
    () => (smart && !tabs ? buildSmartList(rawItems ?? [], dataUpdatedAt || 0) : []),
    [smart, tabs, rawItems, dataUpdatedAt],
  );
  const tabsModel = useMemo(
    () => (tabs ? buildMobileInboxTabs(rawItems ?? [], dataUpdatedAt || 0) : null),
    [tabs, rawItems, dataUpdatedAt],
  );
  const markRead = useMarkInboxRead();
  const markAllRead = useMarkAllInboxRead();
  const archive = useArchiveInbox();
  const archiveAll = useArchiveAllInbox();
  const archiveAllRead = useArchiveAllReadInbox();
  const archiveCompleted = useArchiveCompletedInbox();

  const onPressItem = useCallback((item: InboxItem) => {
    // Read on every opening: a read row can hide older unread notifications.
    // The mutation patches synchronously before iOS captures the source
    // snapshot for the native stack push transition.
    markRead.mutate(item.id);
    const target = getInboxNavigationTarget(item, wsSlug, String(Date.now()));
    if (target) router.push(target);
  }, [markRead, wsSlug]);

  // Tabs: a swipe or a list action acts on every card a row stands for, one
  // request per card (the server's read and archive are issue-wide).
  const tabActions: TabActions = {
    onOpen: onPressItem,
    onArchive: (entries) => archiveIds(entries).forEach((id) => archive.mutate(id)),
    onMarkRead: (entries) => unreadIds(entries).forEach((id) => markRead.mutate(id)),
  };

  // Tabs' header menu: this list's read/archive first (web's per-list "…"
  // menu, asking first above 3 cards), then the whole inbox's mark-read.
  const onPressTabsMenu = (model: InboxTabsModel) => {
    const entries = tabEntries(model, tab);
    const ids = archiveIds(entries);
    const listName = t(`smart.tabs.short.${tab}`);
    const options: string[] = [t("common:actions.cancel")];
    const run: (() => void)[] = [() => {}];
    if (ids.length > 0) {
      options.push(t("smart.tabs.mark_tab_read", { tab: listName }));
      run.push(() => tabActions.onMarkRead(entries));
      options.push(t("smart.tabs.archive_tab", { tab: listName, count: ids.length }));
      run.push(() => {
        if (ids.length <= ARCHIVE_CONFIRM_OVER) {
          tabActions.onArchive(entries);
          return;
        }
        Alert.alert(
          t("smart.tabs.confirm_archive_title", { count: ids.length }),
          t("smart.tabs.confirm_archive_description"),
          [
            { text: t("common:actions.cancel"), style: "cancel" },
            {
              text: t("smart.tabs.confirm_archive"),
              style: "destructive",
              onPress: () => tabActions.onArchive(entries),
            },
          ],
        );
      });
    }
    options.push(t("actions.mark_all_read"));
    run.push(() => markAllRead.mutate());
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: 0,
        destructiveButtonIndex: ids.length > 0 ? 2 : undefined,
        title: t("title"),
      },
      (i) => run[i]?.(),
    );
  };

  // Trailing batch menu — mirrors web's dropdown
  // (packages/views/inbox/components/inbox-page.tsx). "Mark all read" is
  // first (most common batch op); "Archive all" is destructive so it gets
  // the iOS red treatment + Alert confirm.
  const onPressMenu = () => {
    const options = [
      t("common:actions.cancel"),
      t("actions.mark_all_read"),
      t("actions.archive_all_read"),
      t("actions.archive_completed"),
      t("actions.archive_all"),
    ];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: 0,
        destructiveButtonIndex: 4,
        title: t("title"),
      },
      (i) => {
        if (i === 1) markAllRead.mutate();
        else if (i === 2) archiveAllRead.mutate();
        else if (i === 3) archiveCompleted.mutate();
        else if (i === 4) {
          Alert.alert(
            t("archive.confirm_title"),
            t("archive.confirm_body"),
            [
              { text: t("common:actions.cancel"), style: "cancel" },
              {
                text: t("actions.archive_all"),
                style: "destructive",
                onPress: () => archiveAll.mutate(),
              },
            ],
          );
        }
      },
    );
  };

  return (
    <View className="flex-1 bg-background">
      <Header
        title={t("title")}
        right={
          <>
            <IconButton
              name="ellipsis-horizontal"
              onPress={() => (tabsModel ? onPressTabsMenu(tabsModel) : onPressMenu())}
              accessibilityLabel={t("actions.inbox_actions")}
            />
            <HeaderActions />
          </>
        }
      />
      {isLoading ? (
        <InboxLoading />
      ) : error ? (
        <View className="px-4 gap-3 pt-4">
          <Text className="text-sm text-destructive">
            {t("errors.load_failed", {
              message: error instanceof Error ? error.message : "unknown",
            })}
          </Text>
          <Button variant="outline" onPress={() => refetch()}>
            <Text>{t("common:actions.retry")}</Text>
          </Button>
        </View>
      ) : tabsModel ? (
        <View className="flex-1">
          <InboxTabStrip model={tabsModel} tab={tab} onChange={setTab} />
          <InboxTabPanel
            model={tabsModel}
            tab={tab}
            onChangeTab={setTab}
            actions={tabActions}
            refreshing={isRefetching}
            onRefresh={refetch}
            now={dataUpdatedAt}
          />
        </View>
      ) : !data || data.length === 0 ? (
        <InboxEmpty iconColor={THEME[colorScheme].mutedForeground} />
      ) : smart ? (
        <SectionList
          sections={sections}
          keyExtractor={(entry) => entry.item.id}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <View className="flex-row items-center gap-2 bg-background px-4 pb-1 pt-4">
              <Text className="text-xs font-semibold uppercase text-muted-foreground">
                {t(`smart.sections.${section.id}`)}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {section.data.length}
              </Text>
            </View>
          )}
          ItemSeparatorComponent={() => (
            <View className="h-px bg-border ml-16" />
          )}
          contentContainerClassName="pb-6"
          renderItem={({ item: entry }) => (
            <SwipeableInboxRow
              item={entry.item}
              inSmartSection
              onPress={() => onPressItem(entry.item)}
              onArchive={() => archive.mutate(entry.item.id)}
            />
          )}
          refreshing={isRefetching}
          onRefresh={refetch}
        />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => (
            <View className="h-px bg-border ml-16" />
          )}
          contentContainerClassName="pb-6"
          renderItem={({ item }) => (
            <SwipeableInboxRow
              item={item}
              onPress={() => onPressItem(item)}
              onArchive={() => archive.mutate(item.id)}
            />
          )}
          refreshing={isRefetching}
          onRefresh={refetch}
        />
      )}
    </View>
  );
}

// Loading state — 6 row-shaped Skeletons matching InboxRow's layout
// (avatar circle + two text lines). Perceived perf wins over a centered
// spinner because the eye immediately sees the list-like structure.
function InboxLoading() {
  return (
    <View className="px-4 pt-4 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <View key={i} className="flex-row gap-3">
          <Skeleton className="size-9 rounded-full" />
          <View className="flex-1 gap-2 pt-1">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </View>
        </View>
      ))}
    </View>
  );
}

function InboxEmpty({ iconColor }: { iconColor: string }) {
  const { t } = useT("inbox");

  return (
    <View className="flex-1 items-center justify-center px-8 gap-3">
      <Ionicons name="mail-open-outline" size={42} color={iconColor} />
      <Text className="text-base font-medium text-foreground text-center">
        {t("empty.title")}
      </Text>
      <Text className="text-sm text-muted-foreground text-center">
        {t("empty.body")}
      </Text>
    </View>
  );
}
