/**
 * A smart-inbox signal's brief (contango, docs/contango/SMART-INBOX.md "iOS"),
 * shown in the inbox/[id] sheet. Mirrors web's SignalBrief + SmartInboxDetail
 * (packages/views/inbox/components/smart-inbox.tsx): summary, why it ranks
 * here, the body as plain text, one-tap replies first (confirmed with a
 * native alert, like web's dialog), then the link actions, Open card and
 * Archive. Card links in actions open the issue in-app.
 */
import { useEffect } from "react";
import { Alert, Linking, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { signalDetails, type SignalReply } from "@multica/core/inbox/smart";
import type { InboxItem } from "@multica/core/types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { issueDetailOptions } from "@/data/queries/issues";
import {
  useArchiveInbox,
  useMarkInboxRead,
  useReplyToSignal,
} from "@/data/mutations/inbox";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";
import { timeAgo } from "@/lib/time-ago";
import { cardIdFromUrl, signalReplyError } from "@/lib/smart-inbox";

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
  const reply = useReplyToSignal();

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

  const openAction = (url: string) => {
    const cardId = cardIdFromUrl(url, wsSlug);
    if (cardId) {
      openIssue(cardId);
      return;
    }
    Linking.openURL(url).catch(() => {
      // A URL no app handles: a no-op tap beats a crash.
    });
  };

  const confirmReply = (r: SignalReply) => {
    if (!issueId) return;
    const title = issue?.identifier
      ? t("smart.reply.confirm_title_on", { content: r.content, card: issue.identifier })
      : t("smart.reply.confirm_title", { content: r.content });
    Alert.alert(title, t("smart.reply.confirm_description"), [
      { text: t("smart.reply.cancel"), style: "cancel" },
      {
        text: t("smart.reply.confirm"),
        onPress: () => {
          reply.mutate(
            { id: item.id, issueId, index: r.index, content: r.content },
            {
              onSuccess: () => router.back(),
              onError: (err) => {
                const e = signalReplyError(err);
                Alert.alert(
                  t("smart.reply.failed"),
                  "key" in e ? t(e.key) : e.message,
                );
              },
            },
          );
        },
      },
    ]);
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

  const replies = issueId ? (signal?.replies ?? []) : [];
  const actions = signal?.actions ?? [];
  const busy = reply.isPending;

  return (
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

      {item.body ? (
        <Text selectable className="text-base leading-6 text-foreground">
          {item.body}
        </Text>
      ) : null}

      <View className="gap-2">
        {/* One-tap answers first: the recommended reply is the primary button. */}
        {replies.map((r, i) => (
          <Button
            key={`reply-${r.index}`}
            variant={i === 0 ? "default" : "outline"}
            disabled={busy}
            onPress={() => confirmReply(r)}
            accessibilityLabel={r.label}
          >
            <Text numberOfLines={1}>{r.label}</Text>
          </Button>
        ))}
        {actions.map((a, i) => (
          <Button
            key={`${a.url}-${i}`}
            variant={i === 0 && replies.length === 0 ? "default" : "outline"}
            onPress={() => openAction(a.url)}
            accessibilityLabel={a.label}
          >
            <Text numberOfLines={1}>{a.label}</Text>
          </Button>
        ))}
        {issueId ? (
          <Button
            variant={replies.length || actions.length ? "outline" : "default"}
            onPress={() => openIssue(issueId)}
          >
            <Text>
              {issue?.identifier
                ? t("smart.open_card", { card: issue.identifier })
                : t("smart.open_issue")}
            </Text>
          </Button>
        ) : null}
        <Button variant="outline" onPress={onArchive} disabled={busy}>
          <Text>{t("actions.archive")}</Text>
        </Button>
      </View>
    </ScrollView>
  );
}
