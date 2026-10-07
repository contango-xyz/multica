/**
 * Issues tab: "All" + the workspace's saved views (web order, minus views
 * hidden on web). A view's filters are evaluated by the server via
 * POST /api/issues/table/rows — the same query web builds — so a view lists
 * the same issues on both clients. Status + priority quick filters
 * (useMyIssuesViewStore) narrow whatever chip is selected.
 *
 * The route stays `my-issues` so existing links keep working.
 */
import { useEffect, useMemo } from "react";
import { Pressable, ScrollView, SectionList, View } from "react-native";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type {
  IssuePriority,
  IssueStatus,
  IssueTableQuerySpec,
} from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/ui/header";
import { HeaderActions } from "@/components/ui/app-header-actions";
import { StatusIcon } from "@/components/ui/status-icon";
import { IssueRow } from "@/components/issue/issue-row";
import { IssuesLoading } from "@/components/issue/issues-loading";
import {
  issueTableRowsInfiniteOptions,
  issueViewListOptions,
  issueViewPrefOptions,
} from "@/data/queries/issue-views";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useMyIssuesViewStore } from "@/data/stores/my-issues-view-store";
import { useIssuesChipStore } from "@/data/stores/issues-chip-store";
import { useClearFiltersOnWorkspaceChange } from "@/lib/use-clear-filters-on-workspace-change";
import { PRIORITY_LABEL } from "@/lib/issue-status";
import { useT } from "@/lib/i18n";
import { useIssueStatuses } from "@/lib/use-issue-statuses";
import { groupIssuesByStatus } from "@/lib/group-issues-by-status";
import { composeIssuesChips, resolveSelectedChip, type IssuesChip } from "@/lib/issues-chips";
import { buildIssueTableQuery } from "@/lib/view-table-query";
import { applyCollapsed } from "@/lib/collapsed-sections";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";

// Key filler for a disabled rows query (plan is "empty" / "pending").
const PLACEHOLDER_SPEC: IssueTableQuerySpec = {
  scope: { kind: "workspace" },
  filters: {},
  sort: { field: "created_at", direction: "desc" },
};

export default function IssuesTab() {
  const isFocused = useIsFocused();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { t } = useT("issues");

  const statusFilters = useMyIssuesViewStore((s) => s.statusFilters);
  const priorityFilters = useMyIssuesViewStore((s) => s.priorityFilters);
  useClearFiltersOnWorkspaceChange(useMyIssuesViewStore.getState().clearFilters, wsId);

  const views = useQuery(issueViewListOptions(wsId));
  const prefs = useQuery(issueViewPrefOptions(wsId));
  const chips = useMemo(
    () => composeIssuesChips(views.data, prefs.data?.prefs),
    [views.data, prefs.data],
  );

  const remembered = useIssuesChipStore((s) => (wsId ? s.rememberedByWs[wsId] ?? null : null));
  useEffect(() => {
    if (wsId) void useIssuesChipStore.getState().hydrate(wsId);
  }, [wsId]);
  const selected = resolveSelectedChip(chips, remembered);
  const selectChip = (chip: IssuesChip) => {
    if (wsId) useIssuesChipStore.getState().remember(wsId, chip.id);
  };

  // The catalog also decides which status columns a list-mode view loads
  // (cancelled / archived hidden, as on web), so the rows wait for it.
  const catalog = useIssueStatuses();
  const plan = useMemo(
    () =>
      buildIssueTableQuery(
        selected.kind === "all" ? { kind: "all" } : { kind: "view", view: selected.view },
        { statuses: statusFilters, priorities: priorityFilters },
        catalog,
      ),
    [selected, statusFilters, priorityFilters, catalog],
  );

  const rows = useInfiniteQuery({
    // A match-nothing or catalog-pending plan never reaches the server: an
    // empty filter list would be read as "no filter".
    ...issueTableRowsInfiniteOptions(wsId, plan.kind === "query" ? plan.spec : PLACEHOLDER_SPEC),
    enabled: !!wsId && plan.kind === "query",
  });
  const issues = useMemo(
    () =>
      plan.kind === "query"
        ? rows.data?.pages.flatMap((page) => page.rows.map((row) => row.issue)) ?? []
        : [],
    [plan.kind, rows.data],
  );
  const collapsed = useIssuesChipStore((s) => (wsId ? s.collapsedByWs[wsId]?.[selected.id] : undefined));
  const sections = useMemo(
    () => applyCollapsed(groupIssuesByStatus(issues, catalog.statuses), collapsed ?? []),
    [issues, catalog.statuses, collapsed],
  );

  const hasActiveFilters = statusFilters.length > 0 || priorityFilters.length > 0;
  const openFilter = () => {
    if (!wsSlug) return;
    router.push({
      pathname: "/[workspace]/issues-filter",
      params: { workspace: wsSlug, scope: "my" },
    });
  };
  const refreshAll = () => {
    void views.refetch();
    void prefs.refetch();
    void rows.refetch();
  };

  const loading = plan.kind === "pending" || (plan.kind === "query" && rows.isLoading);
  const showEmptyState = !loading && !rows.error && issues.length === 0;
  const emptyMessage = hasActiveFilters
    ? t("empty.filtered")
    : selected.kind === "all"
      ? t("empty.all")
      : t("empty.view");

  return (
    <View className="flex-1 bg-background">
      <Header title={t("navigation:tabs.issues")} right={<HeaderActions />} />
      <ChipToolbar
        chips={chips}
        selectedId={selected.id}
        allLabel={t("tabs.all")}
        onSelect={selectChip}
        onOpenFilter={openFilter}
        hasActiveFilters={hasActiveFilters}
      />
      {hasActiveFilters ? (
        <ActiveFilterChips
          statusFilters={statusFilters}
          priorityFilters={priorityFilters}
          statusLabelOf={catalog.labelOf}
          onClearStatus={(s) =>
            useMyIssuesViewStore.getState().toggleStatusFilter(s)
          }
          onClearPriority={(p) =>
            useMyIssuesViewStore.getState().togglePriorityFilter(p)
          }
        />
      ) : null}
      {loading ? (
        <IssuesLoading />
      ) : plan.kind === "query" && rows.error ? (
        <View className="px-4 gap-3 pt-4">
          <Text className="text-sm text-destructive">
            {t("errors.load_failed", {
              message: rows.error instanceof Error ? rows.error.message : "unknown",
            })}
          </Text>
          <Button variant="outline" onPress={() => rows.refetch()}>
            <Text>{t("common:actions.retry")}</Text>
          </Button>
        </View>
      ) : showEmptyState ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          ItemSeparatorComponent={() => (
            <View className="h-px bg-border ml-4" />
          )}
          renderSectionHeader={({ section }) => (
            <SectionHeader
              status={section.status}
              count={section.count}
              collapsed={section.collapsed}
              onToggle={() => {
                if (wsId) useIssuesChipStore.getState().toggleSection(wsId, selected.id, section.status);
              }}
            />
          )}
          contentContainerClassName="pb-6"
          renderItem={({ item }) => (
            <IssueRow
              issue={item}
              onPress={() => {
                if (wsSlug) router.push(`/${wsSlug}/issue/${item.id}`);
              }}
            />
          )}
          onEndReached={() => {
            if (rows.hasNextPage && !rows.isFetchingNextPage) void rows.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          refreshing={isFocused && plan.kind === "query" && rows.isRefetching && !rows.isFetchingNextPage}
          onRefresh={refreshAll}
        />
      )}
    </View>
  );
}

/**
 * Outline icon button matching the pill height so the toolbar row reads as
 * one visual group. Mirrors web `IssuesHeader` / `MyIssuesHeader` filter
 * trigger (`packages/views/my-issues/components/my-issues-header.tsx:174`),
 * which is also `variant="outline"` + icon-sized — NOT the ghost-style we'd
 * get from <IconButton>. Square (`w-9`) with `px-0` to suppress the sm
 * default `px-3`.
 */
function FilterButton({
  onPress,
  hasActiveFilters,
}: {
  onPress: () => void;
  hasActiveFilters: boolean;
}) {
  const { t } = useT("issues");
  const { colorScheme } = useColorScheme();
  return (
    <View style={{ position: "relative" }} className="ml-2">
      <Button
        variant="outline"
        size="sm"
        onPress={onPress}
        accessibilityLabel={t("header_filter")}
        className="w-9 px-0"
      >
        <Ionicons
          name="options-outline"
          size={16}
          color={THEME[colorScheme].mutedForeground}
        />
      </Button>
      {hasActiveFilters ? (
        <View
          pointerEvents="none"
          className="absolute top-1 right-1 size-1.5 rounded-full bg-brand"
        />
      ) : null}
    </View>
  );
}

/**
 * Horizontally scrolling chip row ("All" + saved views) with the Filter
 * button pinned on the right — same pill styling as the old scope toolbar.
 */
function ChipToolbar({
  chips,
  selectedId,
  allLabel,
  onSelect,
  onOpenFilter,
  hasActiveFilters,
}: {
  chips: IssuesChip[];
  selectedId: string;
  allLabel: string;
  onSelect: (chip: IssuesChip) => void;
  onOpenFilter: () => void;
  hasActiveFilters: boolean;
}) {
  return (
    <View className="flex-row items-center px-4 pt-2 pb-2">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-1 pr-2"
      >
        {chips.map((chip) => {
          const active = chip.id === selectedId;
          const label = chip.kind === "all" ? allLabel : chip.view.name;
          return (
            <Button
              key={chip.id}
              variant="outline"
              size="sm"
              onPress={() => onSelect(chip)}
              className={active ? "bg-accent" : ""}
              accessibilityState={{ selected: active }}
            >
              <Text
                numberOfLines={1}
                className={active ? "text-accent-foreground" : "text-muted-foreground"}
              >
                {label}
              </Text>
            </Button>
          );
        })}
      </ScrollView>
      <FilterButton
        onPress={onOpenFilter}
        hasActiveFilters={hasActiveFilters}
      />
    </View>
  );
}

function ActiveFilterChips({
  statusFilters,
  priorityFilters,
  statusLabelOf,
  onClearStatus,
  onClearPriority,
}: {
  statusFilters: IssueStatus[];
  priorityFilters: IssuePriority[];
  /** Resolves a status KEY — which can be a custom one — to its label. */
  statusLabelOf: (statusKey: string) => string;
  onClearStatus: (s: IssueStatus) => void;
  onClearPriority: (p: IssuePriority) => void;
}) {
  const { t } = useT("issues");
  return (
    <View className="flex-row flex-wrap gap-1.5 px-4 pb-2">
      {statusFilters.map((s) => (
        <Chip key={`s-${s}`} label={statusLabelOf(s)} onClear={() => onClearStatus(s)} />
      ))}
      {priorityFilters.map((p) => (
        <Chip key={`p-${p}`} label={t(PRIORITY_LABEL[p])} onClear={() => onClearPriority(p)} />
      ))}
    </View>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  const { colorScheme } = useColorScheme();
  return (
    <Pressable
      onPress={onClear}
      className="flex-row items-center gap-1 pl-2.5 pr-2 py-1 rounded-full border border-border bg-secondary/40 active:bg-secondary"
    >
      <Text className="text-xs text-foreground">{label}</Text>
      <Ionicons
        name="close"
        size={12}
        color={THEME[colorScheme].mutedForeground}
      />
    </Pressable>
  );
}

// The section header names its concrete built-in or custom status. Tapping it
// collapses / expands the section (remembered per chip on the device).
function SectionHeader({
  status,
  count,
  collapsed,
  onToggle,
}: {
  status: IssueStatus;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const catalog = useIssueStatuses();
  const { colorScheme } = useColorScheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      className="flex-row items-center gap-2 px-4 py-2 bg-background active:bg-secondary"
    >
      <Ionicons
        name={collapsed ? "chevron-forward" : "chevron-down"}
        size={12}
        color={THEME[colorScheme].mutedForeground}
      />
      {/* Category keys resolve to their canonical lifecycle glyph. */}
      <StatusIcon status={status} category={catalog.categoryOf(status)} icon={catalog.iconOf(status)} color={catalog.colorOf(status)} size={14} />
      <Text className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
        {catalog.labelOf(status)}
      </Text>
      <Text className="text-xs text-muted-foreground/60">{count}</Text>
    </Pressable>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <View className="flex-1 items-center justify-center px-6">
      <Text className="text-sm text-muted-foreground text-center">
        {message}
      </Text>
    </View>
  );
}
