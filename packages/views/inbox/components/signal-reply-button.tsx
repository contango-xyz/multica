"use client";

// One-tap answers (contango patch 18, docs/contango/SMART-INBOX.md): a signal
// can offer replies such as "Approve: agree". Tapping one asks for
// confirmation (phones make accidental taps easy), then the server posts the
// reply on the card as the reader, exactly like a typed reply, and archives
// the signal.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check } from "@multica/ui/icons";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useReplyToSignal } from "@multica/core/inbox/mutations";
import { issueDetailOptions } from "@multica/core/issues/queries";
import type { SignalReply } from "@multica/core/inbox/smart";
import type { InboxItem } from "@multica/core/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

export function SignalReplyButton({
  item,
  reply,
  variant = "default",
  size = "default",
  className,
  onPosted,
}: {
  item: Pick<InboxItem, "id" | "issue_id">;
  reply: Pick<SignalReply, "index" | "label" | "content">;
  variant?: "default" | "outline";
  size?: "default" | "sm";
  className?: string;
  /** Called after the server posted the reply (the MVP page refreshes its asks). */
  onPosted?: () => void;
}) {
  const { t } = useT("inbox");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const post = useReplyToSignal();
  const issueId = item.issue_id;
  // The card's key for the question; the dialog reads fine without it.
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, issueId ?? ""),
    enabled: open && !!issueId,
  });
  if (!issueId) return null;

  const confirm = () =>
    post.mutate(
      { id: item.id, index: reply.index, content: reply.content },
      {
        onSuccess: () => {
          setOpen(false);
          onPosted?.();
          toast.success(t(($) => $.smart.reply.posted, { content: reply.content }));
        },
        onError: (err) => {
          toast.error(err instanceof Error && err.message ? err.message : t(($) => $.smart.reply.failed));
        },
      },
    );

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={cn("min-w-0", className)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Check className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{reply.label}</span>
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!post.isPending) setOpen(next);
        }}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">
              {issue?.identifier
                ? t(($) => $.smart.reply.confirm_title_on, { content: reply.content, card: issue.identifier })
                : t(($) => $.smart.reply.confirm_title, { content: reply.content })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.smart.reply.confirm_description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={post.isPending}>{t(($) => $.smart.reply.cancel)}</AlertDialogCancel>
            <AlertDialogAction disabled={post.isPending} aria-busy={post.isPending} onClick={confirm}>
              {t(($) => $.smart.reply.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
