/**
 * A smart-inbox signal's brief (contango, docs/contango/SMART-INBOX.md "iOS"),
 * shown in the inbox/[id] sheet. Mirrors web's SignalBrief + SmartInboxDetail
 * (packages/views/inbox/components/smart-inbox.tsx) and, since patch 45, the
 * tabs' brief (packages/views/inbox/components/smart-tabs.tsx BriefBody and
 * MergeCard): summary and why it ranks here; then the feeder's brief (What's
 * going on / We recommend / If you say nothing) or the body as plain text; a
 * merge ask's facts (why it needs you, CI, agent review, size).
 *
 * The answers sit in a footer below the scrolling text, within thumb reach:
 * one-tap replies first (confirmed with a native alert, like web's dialog) or
 * "Approve on GitHub" for a merge, then the link actions, Open card and
 * Archive. Card links in actions open the issue in-app. Nothing here is
 * archived or answered without a tap.
 */
import { useEffect } from "react";
import { Linking, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { signalDetails } from "@multica/core/inbox/smart";
import type { InboxItem } from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { issueDetailOptions } from "@/data/queries/issues";
import { useArchiveInbox, useMarkInboxRead } from "@/data/mutations/inbox";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";
import { timeAgo } from "@/lib/time-ago";
import { cardIdFromUrl } from "@/lib/smart-inbox";
import { githubButton } from "@/lib/inbox-tabs";
import { cn } from "@/lib/utils";
import { useSignalReply } from "./use-signal-reply";

export function SignalDetail({ item }: { item: InboxItem }) {
  const { t } = useT("inbox");
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const wsSlug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const signal = signalDetails(item);
  const issueId = item.issue_id;
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, issueId ?? ""),
    enabled: !!wsId && !!issueId,
  });
  const { mutate: markRead } = useMarkInboxRead();
  const archive = useArchiveInbox();
  const { confirm, busy } = useSignalReply();

  // Opened from a push, the row was never tapped: read it here.
  const unread = !item.read;
  useEffect(() => {
    if (unread) markRead(item.id);
  }, [item.id, unread, markRead]);

  const openIssue = (id: string) => {
    if (!wsSlug) return;
    // The sheet is replaced by the issue, so back lands on the inbox
    // (same pattern as the search modal).
    router.replace({ pathname: "/[workspace]/issue/[id]", params: { workspace: wsSlug, id } });
  };

  const openUrl = (url: string) => {
    Linking.openURL(url).catch(() => {
      // A URL no app handles: a no-op tap beats a crash.
    });
  };

  const openAction = (url: string) => {
    const cardId = cardIdFromUrl(url, wsSlug);
    if (cardId) openIssue(cardId);
    else openUrl(url);
  };

  const onArchive = () => {
    archive.mutate(item.id);
    router.back();
  };

  const reasonParts: string[] = [];
  if (signal && signal.rank.priority !== "none") {
    reasonParts.push(t(`smart.priority.${signal.rank.priority}`));
  }
  if (signal && signal.rank.blocks > 0) {
    reasonParts.push(t("smart.blocks", { count: signal.rank.blocks }));
  }
  reasonParts.push(timeAgo(signal?.rank.since ?? item.created_at));

  const github = githubButton(signal);
  // A merge ask is approved on GitHub (owner: people look at the code), so
  // its replies are not offered here, as on web's tabs.
  const replies = issueId && !github ? (signal?.replies ?? []) : [];
  const actions = (signal?.actions ?? []).filter((a) => !github || a.url !== github.url);
  const brief = signal?.brief ?? null;
  const merge = signal?.merge ?? null;
  const hasPrimary = replies.length > 0 || !!github;

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-4 py-5"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1">
          {signal ? (
            <Text className="text-xs font-semibold uppercase text-muted-foreground">
              {t(`smart.sections.${signal.group}`)}
            </Text>
          ) : null}
          {signal?.summary ? (
            <Text className="text-base leading-6 text-muted-foreground">
              {signal.summary}
            </Text>
          ) : null}
          <Text className="text-xs text-muted-foreground">
            {reasonParts.join(" · ")}
          </Text>
        </View>

        {brief ? (
          <View className="gap-4">
            {brief.situation ? (
              <BriefField label={t("smart.tabs.going")} value={brief.situation} />
            ) : null}
            {brief.recommend ? (
              <BriefField label={t("smart.tabs.recommend")} value={brief.recommend} />
            ) : null}
            <BriefField
              label={t("smart.tabs.if_silent")}
              value={brief.default || t("smart.tabs.nothing_happens")}
              accent={brief.defaultApplies}
            />
          </View>
        ) : item.body ? (
          <Text selectable className="text-base leading-6 text-foreground">
            {item.body}
          </Text>
        ) : null}

        {merge && !merge.postMerge ? (
          <View className="gap-3 rounded-lg border border-border bg-card p-3">
            <BriefField label={t("smart.tabs.why_human")} value={merge.risk || "—"} />
            <BriefField label={t("smart.tabs.agent_review")} value={merge.review || "—"} />
            <View className="flex-row gap-4">
              {merge.ci !== "unknown" ? (
                <BriefField label={t("smart.tabs.ci_label")} value={t(`smart.tabs.ci.${merge.ci}`)} />
              ) : null}
              {merge.lines > 0 ? (
                <BriefField
                  label={t("smart.tabs.size")}
                  value={t("smart.tabs.size_value", { lines: merge.lines, files: merge.files })}
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </ScrollView>

      {/* Answers at the bottom of the sheet: within thumb reach. */}
      <View className="gap-2 border-t border-border bg-background px-4 pb-8 pt-3">
        {github ? (
          <Button
            variant={github.postMerge ? "outline" : "default"}
            onPress={() => openUrl(github.url)}
            accessibilityLabel={github.postMerge ? t("smart.tabs.review_on_github") : t("smart.tabs.approve_on_github")}
          >
            <Text numberOfLines={1}>
              {github.postMerge ? t("smart.tabs.review_on_github") : t("smart.tabs.approve_on_github")}
            </Text>
          </Button>
        ) : null}
        {/* The recommended reply is the primary button. */}
        {replies.map((r, i) => (
          <Button
            key={`reply-${r.index}`}
            variant={i === 0 ? "default" : "outline"}
            disabled={busy}
            onPress={() => confirm(item, r, { card: issue?.identifier, onDone: () => router.back() })}
            accessibilityLabel={r.label}
          >
            <Text numberOfLines={1}>{r.label}</Text>
          </Button>
        ))}
        {actions.map((a, i) => (
          <Button
            key={`${a.url}-${i}`}
            variant={i === 0 && !hasPrimary ? "default" : "outline"}
            onPress={() => openAction(a.url)}
            accessibilityLabel={a.label}
          >
            <Text numberOfLines={1}>{a.label}</Text>
          </Button>
        ))}
        <View className="flex-row gap-2">
          {issueId ? (
            <Button
              className="flex-1"
              variant={hasPrimary || actions.length ? "outline" : "default"}
              onPress={() => openIssue(issueId)}
            >
              <Text numberOfLines={1}>
                {issue?.identifier
                  ? t("smart.open_card", { card: issue.identifier })
                  : t("smart.open_issue")}
              </Text>
            </Button>
          ) : null}
          <Button className="flex-1" variant="outline" onPress={onArchive} disabled={busy}>
            <Text>{t("actions.archive")}</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}

function BriefField({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <View className={cn("gap-0.5", accent && "border-l-[3px] border-l-warning pl-2.5")}>
      <Text className="text-xs font-semibold uppercase text-muted-foreground">{label}</Text>
      <Text selectable className="text-base leading-6 text-foreground">
        {value}
      </Text>
    </View>
  );
}
