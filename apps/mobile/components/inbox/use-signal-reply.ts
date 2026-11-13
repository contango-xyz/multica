/**
 * A signal's one-tap answer, confirmed with a native alert first (phones make
 * accidental taps easy; web's SignalReplyButton asks too), then posted on the
 * card as the reader. Shared by the brief sheet and the inbox tabs' cards.
 */
import { Alert } from "react-native";
import type { SignalReply } from "@multica/core/inbox/smart";
import type { InboxItem } from "@multica/core/types";
import { useReplyToSignal } from "@/data/mutations/inbox";
import { useT } from "@/lib/i18n";
import { signalReplyError } from "@/lib/smart-inbox";

export function useSignalReply() {
  const { t } = useT("inbox");
  const reply = useReplyToSignal();

  const confirm = (
    item: InboxItem,
    r: SignalReply,
    opts: { card?: string | null; onDone?: () => void } = {},
  ) => {
    const issueId = item.issue_id;
    if (!issueId) return;
    const title = opts.card
      ? t("smart.reply.confirm_title_on", { content: r.content, card: opts.card })
      : t("smart.reply.confirm_title", { content: r.content });
    Alert.alert(title, t("smart.reply.confirm_description"), [
      { text: t("smart.reply.cancel"), style: "cancel" },
      {
        text: t("smart.reply.confirm"),
        onPress: () => {
          reply.mutate(
            { id: item.id, issueId, index: r.index, content: r.content },
            {
              onSuccess: () => opts.onDone?.(),
              onError: (err) => {
                const e = signalReplyError(err);
                Alert.alert(t("smart.reply.failed"), "key" in e ? t(e.key) : e.message);
              },
            },
          );
        },
      },
    ]);
  };

  return { confirm, busy: reply.isPending };
}
