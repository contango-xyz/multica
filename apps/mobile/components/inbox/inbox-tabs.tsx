/**
 * Inbox tabs on the phone (contango patch 45, owner 2026-11-13: "the small
 * screen makes dealing with tickets quite cumbersome"). The phone layout of
 * web's InboxTabsView (packages/views/inbox/components/smart-tabs.tsx); the
 * rows, ranking, badges and visibility rules are core's buildInboxTabs, so
 * both clients show the same cards on the same tabs.
 *
 * - Today (the home screen): at most 5 big cards, each: what to do, "frees N",
 *   why in one line, and the one-tap answers or "Approve on GitHub". Alerts
 *   are a red banner on top. Nothing else.
 * - Decisions: one row per card; a tap opens the brief sheet (answers at the
 *   bottom of the sheet).
 * - Merges: one card per PR with why it needs a human, CI, review and size,
 *   plus "Approve on GitHub"; post-merge reviews below.
 * - Squad: read-only. Everything else: a quiet list.
 *
 * Every row: swipe left reveals Archive (a tap archives the card), swipe
 * right marks it read. Pull to refresh on every tab. Nothing is archived or
 * opened without a tap: switching tabs opens nothing, and the brief sheet
 * only opens from a tap or a push.
 */
import type { ReactNode } from "react";
import {
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import type { SmartEntry } from "@multica/core/inbox/smart";
import { SQUAD_BUCKETS, type InboxSquad } from "@multica/core/inbox/squad";
import type { InboxItem } from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { SwipeableInboxRow } from "@/components/inbox/swipeable-inbox-row";
import { inboxSquadOptions } from "@/data/queries/inbox";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useColorScheme } from "@/lib/use-color-scheme";
import { THEME } from "@/lib/theme";
import { useT } from "@/lib/i18n";
import { getInboxDisplayTitle } from "@/lib/inbox-display";
import {
  INBOX_TABS,
  cardRef,
  githubButton,
  tabBadge,
  utcTime,
  whyLine,
  type InboxTab,
  type InboxTabsModel,
  type TabRow,
} from "@/lib/inbox-tabs";
import { cn } from "@/lib/utils";
import { useSignalReply } from "./use-signal-reply";

/** What every tab's rows can do. */
export interface TabActions {
  /** Open the row: the brief sheet for a signal, else the card (marks it read first). */
  onOpen: (item: InboxItem) => void;
  /** Archive what the entries stand for (one call per card). */
  onArchive: (entries: SmartEntry[]) => void;
  /** Mark the entries read (one call per card). */
  onMarkRead: (entries: SmartEntry[]) => void;
}

const TAB_ICON: Record<InboxTab, { on: keyof typeof Ionicons.glyphMap; off: keyof typeof Ionicons.glyphMap }> = {
  today: { on: "sunny", off: "sunny-outline" },
  decisions: { on: "help-circle", off: "help-circle-outline" },
  merges: { on: "git-merge", off: "git-merge-outline" },
  squad: { on: "people", off: "people-outline" },
  else: { on: "file-tray", off: "file-tray-outline" },
};

export function InboxTabStrip({
  model,
  tab,
  onChange,
}: {
  model: InboxTabsModel;
  tab: InboxTab;
  onChange: (tab: InboxTab) => void;
}) {
  const { t } = useT("inbox");
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme];
  return (
    <View accessibilityRole="tablist" className="flex-row border-b border-border bg-background">
      {INBOX_TABS.map((id) => {
        const selected = id === tab;
        const badge = tabBadge(model, id);
        return (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={badge ? `${t(`smart.tabs.short.${id}`)}, ${badge}` : t(`smart.tabs.short.${id}`)}
            onPress={() => onChange(id)}
            className="flex-1 items-center gap-0.5 pb-1.5 pt-2 active:bg-secondary"
          >
            <View>
              <Ionicons
                name={selected ? TAB_ICON[id].on : TAB_ICON[id].off}
                size={22}
                color={selected ? colors.brand : colors.mutedForeground}
              />
              {badge > 0 ? (
                <View className="absolute -right-2.5 -top-1 min-w-[18px] items-center rounded-full bg-destructive px-1">
                  <Text className="text-[11px] font-semibold leading-[16px] text-white">{badge}</Text>
                </View>
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              className={cn("text-[11px]", selected ? "font-semibold text-brand" : "text-muted-foreground")}
            >
              {t(`smart.tabs.short.${id}`)}
            </Text>
            <View className={cn("absolute bottom-0 h-0.5 w-10 rounded-full", selected ? "bg-brand" : "bg-transparent")} />
          </Pressable>
        );
      })}
    </View>
  );
}

export function InboxTabPanel({
  model,
  tab,
  onChangeTab,
  actions,
  refreshing,
  onRefresh,
  now,
}: {
  model: InboxTabsModel;
  tab: InboxTab;
  onChangeTab: (tab: InboxTab) => void;
  actions: TabActions;
  /** The time the model was ranked at: absolute times are shown against it. */
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  switch (tab) {
    case "today":
      return <TodayPanel model={model} onChangeTab={onChangeTab} actions={actions} refreshing={refreshing} onRefresh={onRefresh} />;
    case "decisions":
      return <DecisionsPanel rows={model.decisions} now={now} actions={actions} refreshing={refreshing} onRefresh={onRefresh} />;
    case "merges":
      return <MergesPanel model={model} now={now} actions={actions} refreshing={refreshing} onRefresh={onRefresh} />;
    case "squad":
      return <SquadPanel refreshing={refreshing} onRefresh={onRefresh} />;
    case "else":
      return <ElsePanel entries={model.else} actions={actions} refreshing={refreshing} onRefresh={onRefresh} />;
  }
}

// --- Shared bits -------------------------------------------------------------

function Pill({ tone = "default", children }: { tone?: "default" | "accent" | "ok" | "warn" | "bad"; children: ReactNode }) {
  return (
    <View
      className={cn(
        "rounded-full px-2 py-0.5",
        tone === "default" && "bg-secondary",
        tone === "accent" && "bg-brand/15",
        tone === "ok" && "bg-success/15",
        tone === "warn" && "bg-warning/20",
        tone === "bad" && "bg-destructive/15",
      )}
    >
      <Text
        className={cn(
          "text-xs font-medium",
          tone === "default" && "text-muted-foreground",
          tone === "accent" && "text-brand",
          tone === "ok" && "text-success",
          tone === "warn" && "text-foreground",
          tone === "bad" && "text-destructive",
        )}
      >
        {children}
      </Text>
    </View>
  );
}

function Empty({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  const { colorScheme } = useColorScheme();
  return (
    <View className="items-center gap-3 px-8 py-16">
      <Ionicons name={icon} size={40} color={THEME[colorScheme].mutedForeground} />
      <Text className="text-center text-base font-medium text-muted-foreground">{text}</Text>
    </View>
  );
}

function Refresh({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />;
}

function openUrl(url: string) {
  Linking.openURL(url).catch(() => {
    // A URL no app handles: a no-op tap beats a crash.
  });
}

/** A card's swipe wrapper: left reveals Archive, right marks read. */
function SwipeCard({ row, actions, children }: { row: TabRow; actions: TabActions; children: ReactNode }) {
  return (
    <SwipeableInboxRow
      item={row.entry.item}
      onPress={() => actions.onOpen(row.entry.item)}
      onArchive={() => actions.onArchive(row.entries)}
      onMarkRead={() => actions.onMarkRead(row.entries)}
    >
      <View className="bg-background px-4 py-1.5">{children}</View>
    </SwipeableInboxRow>
  );
}

/** The one-tap answers (or the GitHub button for a merge), big enough for a thumb. */
function Answers({ entry, onOpen }: { entry: SmartEntry; onOpen: () => void }) {
  const { t } = useT("inbox");
  const { confirm, busy } = useSignalReply();
  const github = githubButton(entry.signal);
  if (github) {
    return (
      <Button size="lg" variant={github.postMerge ? "outline" : "default"} onPress={() => openUrl(github.url)}>
        <Text>{github.postMerge ? t("smart.tabs.review_on_github") : t("smart.tabs.approve_on_github")}</Text>
      </Button>
    );
  }
  const replies = entry.item.issue_id ? (entry.signal?.replies ?? []) : [];
  if (replies.length === 0) {
    return (
      <Button size="lg" variant="outline" onPress={onOpen}>
        <Text>{t("smart.tabs.open_brief")}</Text>
      </Button>
    );
  }
  return (
    <View className="flex-row flex-wrap gap-2">
      {replies.map((r, i) => (
        <Button
          key={r.index}
          size="lg"
          className="min-w-[45%] flex-1"
          variant={i === 0 ? "default" : "outline"}
          disabled={busy}
          accessibilityLabel={r.label}
          onPress={() => confirm(entry.item, r, { card: cardRef(entry.item) })}
        >
          <Text numberOfLines={1}>{r.label}</Text>
        </Button>
      ))}
    </View>
  );
}

function UnreadDot({ item }: { item: InboxItem }) {
  return item.read ? null : <View className="mt-2 size-2 shrink-0 rounded-full bg-brand" />;
}

// --- Today -------------------------------------------------------------------

function TodayPanel({
  model,
  onChangeTab,
  actions,
  refreshing,
  onRefresh,
}: {
  model: InboxTabsModel;
  onChangeTab: (tab: InboxTab) => void;
  actions: TabActions;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useT("inbox");
  const { rows, more, alerts } = model.today;
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-1 pb-8 pt-2"
      refreshControl={<Refresh refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {alerts.map((a) => (
        // Swipes like every other row (contango patch 47: a "CD is red" banner had no archive).
        <SwipeableInboxRow
          key={a.item.id}
          item={a.item}
          onPress={() => actions.onOpen(a.item)}
          onArchive={() => actions.onArchive([a])}
          onMarkRead={() => actions.onMarkRead([a])}
        >
          <View className="bg-background px-4 pb-1">
            <Pressable
              accessibilityRole="button"
              onPress={() => actions.onOpen(a.item)}
              className="gap-0.5 rounded-xl bg-destructive/10 px-3 py-2.5 active:opacity-70"
            >
              <Text className="text-xs font-semibold uppercase text-destructive">{t("smart.tabs.alert")}</Text>
              <Text className="text-sm font-semibold text-destructive" numberOfLines={2}>
                {getInboxDisplayTitle(a.item)}
              </Text>
            </Pressable>
          </View>
        </SwipeableInboxRow>
      ))}
      {rows.length === 0 ? (
        <Empty icon="checkmark-circle-outline" text={t("smart.tabs.today_empty")} />
      ) : (
        rows.map((row) => <TodayCard key={row.entry.item.id} row={row} actions={actions} />)
      )}
      {more > 0 ? (
        <View className="flex-row flex-wrap items-center justify-center gap-x-1 px-4 pt-3">
          <Text className="text-sm text-muted-foreground">{t("smart.tabs.today_more", { count: more })}</Text>
          <Pressable onPress={() => onChangeTab("decisions")} hitSlop={8}>
            <Text className="text-sm font-medium text-brand">{t("smart.tabs.short.decisions")}</Text>
          </Pressable>
          <Text className="text-sm text-muted-foreground">·</Text>
          <Pressable onPress={() => onChangeTab("merges")} hitSlop={8}>
            <Text className="text-sm font-medium text-brand">{t("smart.tabs.short.merges")}</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

function TodayCard({ row, actions }: { row: TabRow; actions: TabActions }) {
  const { t } = useT("inbox");
  const entry = row.entry;
  const blocks = entry.signal?.rank.blocks ?? 0;
  const why = whyLine(entry);
  const open = () => actions.onOpen(entry.item);
  return (
    <SwipeCard row={row} actions={actions}>
      <View className="gap-2.5 rounded-xl border border-border bg-card p-4">
        <Pressable accessibilityRole="button" onPress={open} className="flex-row gap-2 active:opacity-70">
          <UnreadDot item={entry.item} />
          <Text className="flex-1 text-lg font-semibold leading-6 text-foreground" numberOfLines={3}>
            {getInboxDisplayTitle(entry.item)}
          </Text>
        </Pressable>
        {blocks > 0 ? (
          <View className="flex-row">
            <Pill tone="accent">{t("smart.tabs.frees", { count: blocks })}</Pill>
          </View>
        ) : null}
        {why ? (
          <Text className="text-[15px] leading-5 text-muted-foreground" numberOfLines={1}>
            {why}
          </Text>
        ) : null}
        <Answers entry={entry} onOpen={open} />
      </View>
    </SwipeCard>
  );
}

// --- Decisions ---------------------------------------------------------------

function RowMeta({ row, now }: { row: TabRow; now: number }) {
  const { t } = useT("inbox");
  const entry = row.entry;
  const ref = cardRef(entry.item);
  const blocks = entry.signal?.rank.blocks ?? 0;
  const prio = entry.reason.priority;
  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      {ref ? <Text className="font-mono text-xs text-muted-foreground">{ref}</Text> : null}
      {blocks > 0 ? <Pill tone="accent">{t("smart.tabs.frees", { count: blocks })}</Pill> : null}
      {prio === "urgent" || prio === "high" ? (
        <Pill tone={prio === "urgent" ? "bad" : "warn"}>{t(`smart.priority.${prio}`)}</Pill>
      ) : null}
      {row.entries.length > 1 ? <Pill>{t("smart.tabs.folded", { count: row.entries.length })}</Pill> : null}
      <Text className="text-xs text-muted-foreground">
        {t("smart.tabs.asked", { time: utcTime(entry.signal?.rank.since ?? entry.item.created_at, now) })}
      </Text>
    </View>
  );
}

function DecisionsPanel({
  rows,
  now,
  actions,
  refreshing,
  onRefresh,
}: {
  rows: TabRow[];
  now: number;
  actions: TabActions;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useT("inbox");
  const { colorScheme } = useColorScheme();
  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.entry.item.id}
      contentContainerClassName="pb-8"
      ItemSeparatorComponent={() => <View className="ml-4 h-px bg-border" />}
      ListEmptyComponent={<Empty icon="checkmark-circle-outline" text={t("smart.tabs.decisions_empty")} />}
      refreshing={refreshing}
      onRefresh={onRefresh}
      renderItem={({ item: row }) => (
        <SwipeableInboxRow
          item={row.entry.item}
          onPress={() => actions.onOpen(row.entry.item)}
          onArchive={() => actions.onArchive(row.entries)}
          onMarkRead={() => actions.onMarkRead(row.entries)}
        >
          <Pressable
            accessibilityRole="button"
            onPress={() => actions.onOpen(row.entry.item)}
            className="flex-row items-start gap-2 bg-background px-4 py-3 active:bg-secondary"
          >
            <UnreadDot item={row.entry.item} />
            <View className="min-w-0 flex-1 gap-1">
              <Text
                numberOfLines={2}
                className={cn("text-base leading-5", row.entry.item.read ? "text-foreground" : "font-semibold text-foreground")}
              >
                {getInboxDisplayTitle(row.entry.item)}
              </Text>
              <RowMeta row={row} now={now} />
            </View>
            <Ionicons name="chevron-forward" size={18} color={THEME[colorScheme].mutedForeground} style={{ marginTop: 2 }} />
          </Pressable>
        </SwipeableInboxRow>
      )}
    />
  );
}

// --- Merges ------------------------------------------------------------------

function MergeCard({ row, actions, now }: { row: TabRow; actions: TabActions; now: number }) {
  const { t } = useT("inbox");
  const entry = row.entry;
  const m = entry.signal?.merge ?? null;
  const github = githubButton(entry.signal);
  const ref = cardRef(entry.item);
  const open = () => actions.onOpen(entry.item);
  const fact = (label: string, value: string) => (
    <View className="gap-0.5">
      <Text className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</Text>
      <Text className="text-sm leading-5 text-foreground" numberOfLines={3}>
        {value}
      </Text>
    </View>
  );
  return (
    <SwipeCard row={row} actions={actions}>
      <View className="gap-2.5 rounded-xl border border-border bg-card p-4">
        <Pressable accessibilityRole="button" onPress={open} className="flex-row gap-2 active:opacity-70">
          <UnreadDot item={entry.item} />
          <Text className="flex-1 text-base font-semibold leading-5 text-foreground" numberOfLines={3}>
            {getInboxDisplayTitle(entry.item)}
          </Text>
        </Pressable>
        <View className="flex-row flex-wrap items-center gap-1.5">
          {ref ? <Text className="font-mono text-xs text-muted-foreground">{ref}</Text> : null}
          {m && !github?.postMerge && m.ci !== "unknown" ? (
            <Pill tone={m.ci === "green" ? "ok" : m.ci === "red" ? "bad" : "warn"}>{t(`smart.tabs.ci.${m.ci}`)}</Pill>
          ) : null}
          {m && m.lines > 0 ? <Pill>{t("smart.tabs.size_value", { lines: m.lines, files: m.files })}</Pill> : null}
          {github?.postMerge && m?.mergedAt ? (
            <Text className="text-xs text-muted-foreground">{t("smart.tabs.merged_at", { time: utcTime(m.mergedAt, now) })}</Text>
          ) : null}
        </View>
        {!github?.postMerge ? (
          <>
            {fact(t("smart.tabs.why_human"), m?.risk || whyLine(entry) || "—")}
            {m?.review ? fact(t("smart.tabs.agent_review"), m.review) : null}
          </>
        ) : null}
        {github ? (
          <Button size="lg" variant={github.postMerge ? "outline" : "default"} onPress={() => openUrl(github.url)}>
            <Text>{github.postMerge ? t("smart.tabs.review_on_github") : t("smart.tabs.approve_on_github")}</Text>
          </Button>
        ) : (
          <Button size="lg" variant="outline" onPress={open}>
            <Text>{t("smart.tabs.open_brief")}</Text>
          </Button>
        )}
      </View>
    </SwipeCard>
  );
}

function MergesPanel({
  model,
  now,
  actions,
  refreshing,
  onRefresh,
}: {
  model: InboxTabsModel;
  now: number;
  actions: TabActions;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useT("inbox");
  const { approval, postMerge } = model.merges;
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-1 pb-8 pt-2"
      refreshControl={<Refresh refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {approval.length === 0 ? (
        <Empty icon="git-merge-outline" text={t("smart.tabs.merges_empty")} />
      ) : (
        approval.map((row) => <MergeCard key={row.entry.item.id} row={row} actions={actions} now={now} />)
      )}
      {postMerge.length > 0 ? (
        <>
          <Text className="px-4 pb-1 pt-4 text-xs font-semibold uppercase text-muted-foreground">
            {t("smart.tabs.merged_without_you")}
          </Text>
          {postMerge.map((row) => (
            <MergeCard key={row.entry.item.id} row={row} actions={actions} now={now} />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

// --- Squad -------------------------------------------------------------------

const BUCKET_COLOR: Record<string, string> = {
  people: "bg-warning",
  blocked: "bg-destructive",
  machines: "bg-brand",
  working: "bg-success",
  nobody: "bg-muted-foreground",
  subs: "bg-info",
  seats: "bg-info",
};

function SquadPanel({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
  const { t } = useT("inbox");
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const squad = useQuery(inboxSquadOptions(wsId));
  const refresh = () => {
    onRefresh();
    void squad.refetch();
  };
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-3 px-4 pb-8 pt-3"
      refreshControl={<Refresh refreshing={refreshing || squad.isRefetching} onRefresh={refresh} />}
    >
      {squad.isLoading ? null : squad.data ? (
        <SquadScreen data={squad.data} now={squad.dataUpdatedAt} />
      ) : (
        <Empty icon="people-outline" text={t("smart.tabs.squad_empty")} />
      )}
    </ScrollView>
  );
}

function SquadCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2.5 rounded-xl border border-border bg-card p-4">
      <Text className="text-xs font-semibold uppercase text-muted-foreground">{title}</Text>
      {children}
    </View>
  );
}

/** Read-only: where card time goes, who holds cards, the biggest holds and the inbox load. */
export function SquadScreen({ data, now }: { data: InboxSquad; now: number }) {
  const { t } = useT("inbox");
  const snap = data.snapshot;
  const buckets = SQUAD_BUCKETS.map((id) => ({ id, share: snap?.buckets[id]?.share ?? 0 })).filter((b) => b.share > 0);
  const people = [...(snap?.people ?? [])].filter((p) => p.hours > 0).sort((a, b) => b.hours - a.hours);
  const maxHours = Math.max(1, ...people.map((p) => p.hours));
  const holds = [...(snap?.people_via_blocked ?? [])].sort((a, b) => b.hours - a.hours).slice(0, 5);
  const load = [...data.inbox_load].sort((a, b) => b.decisions + b.merges - (a.decisions + a.merges));
  const pct = (share: number) => `${Math.round(share * 100)}%`;
  return (
    <>
      {snap ? (
        <>
          <Text className="text-sm text-muted-foreground">
            {t("smart.tabs.squad_sub", { hours: Math.round(snap.window_hours ?? 24), time: utcTime(snap.generated_at, now) })}
          </Text>
          {buckets.length > 0 ? (
            <SquadCard title={t("smart.tabs.where_time_goes")}>
              <View
                accessible
                accessibilityLabel={buckets.map((b) => `${t(`smart.tabs.buckets.${b.id}`)} ${pct(b.share)}`).join(", ")}
                className="h-5 flex-row overflow-hidden rounded-md"
              >
                {buckets.map((b) => (
                  <View key={b.id} className={BUCKET_COLOR[b.id]} style={{ width: `${b.share * 100}%` }} />
                ))}
              </View>
              <View className="gap-1">
                {buckets.map((b) => (
                  <View key={b.id} className="flex-row items-center gap-2">
                    <View className={cn("size-2.5 rounded-sm", BUCKET_COLOR[b.id])} />
                    <Text className="flex-1 text-sm text-foreground">{t(`smart.tabs.buckets.${b.id}`)}</Text>
                    <Text className="text-sm tabular-nums text-muted-foreground">{pct(b.share)}</Text>
                  </View>
                ))}
              </View>
            </SquadCard>
          ) : null}
          {people.length > 0 ? (
            <SquadCard title={t("smart.tabs.who_holds")}>
              {people.map((p) => (
                <View key={p.name} className="flex-row items-center gap-2">
                  <Text className="w-24 text-sm text-foreground" numberOfLines={1}>
                    {p.name}
                  </Text>
                  <View className="h-3 flex-1 overflow-hidden rounded bg-muted">
                    <View className="h-full bg-warning" style={{ width: `${(p.hours / maxHours) * 100}%` }} />
                  </View>
                  <Text className="w-12 text-right text-sm tabular-nums text-muted-foreground">
                    {t("smart.tabs.hours_value", { hours: Math.round(p.hours) })}
                  </Text>
                </View>
              ))}
            </SquadCard>
          ) : null}
          {holds.length > 0 ? (
            <SquadCard title={t("smart.tabs.biggest_holds")}>
              {holds.map((h) => (
                <View key={h.key} className="gap-0.5">
                  <Text className="text-sm text-foreground" numberOfLines={2}>
                    <Text className="font-mono text-xs text-muted-foreground">{h.key} </Text>
                    {h.title}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {t("smart.tabs.hold_line", { human: h.human || "—", hours: h.hours.toFixed(1), count: h.cards.length })}
                  </Text>
                </View>
              ))}
            </SquadCard>
          ) : null}
        </>
      ) : (
        <Empty icon="people-outline" text={t("smart.tabs.squad_empty")} />
      )}
      {load.length > 0 ? (
        <SquadCard title={t("smart.tabs.inbox_load")}>
          {load.map((r) => (
            <View key={r.user_id} className="flex-row items-center gap-2">
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                {r.name}
              </Text>
              <Text className="text-xs tabular-nums text-muted-foreground">
                {t("smart.tabs.load_line", { decisions: r.decisions, merges: r.merges, other: r.everything_else })}
              </Text>
            </View>
          ))}
        </SquadCard>
      ) : null}
    </>
  );
}

// --- Everything else ---------------------------------------------------------

function ElsePanel({
  entries,
  actions,
  refreshing,
  onRefresh,
}: {
  entries: SmartEntry[];
  actions: TabActions;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useT("inbox");
  return (
    <FlatList
      data={entries}
      keyExtractor={(e) => e.item.id}
      contentContainerClassName="pb-8"
      ItemSeparatorComponent={() => <View className="ml-16 h-px bg-border" />}
      ListEmptyComponent={<Empty icon="file-tray-outline" text={t("smart.tabs.else_empty")} />}
      refreshing={refreshing}
      onRefresh={onRefresh}
      renderItem={({ item: e }) => (
        <SwipeableInboxRow
          item={e.item}
          onPress={() => actions.onOpen(e.item)}
          onArchive={() => actions.onArchive([e])}
          onMarkRead={() => actions.onMarkRead([e])}
        />
      )}
    />
  );
}
