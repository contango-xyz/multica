"use client";

import type { ReactNode } from "react";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import type { WakeupPreview } from "@multica/core/types";
import { AppLink, resolveClickIntent, useIntentNavigate } from "../../navigation";

/**
 * Hover delays for the activity indicator and the "Waiting on" line, which sit
 * in the same slot on dense rows. Why these values: issue-agent-activity-indicator.
 */
export const WAIT_HOVER_OPEN_DELAY_MS = 900;
export const WAIT_HOVER_CLOSE_DELAY_MS = 150;

const LINK_CLASS = "cursor-pointer underline-offset-2 hover:text-foreground hover:underline";

/** The issue a wakeup is waiting on, when it waits on another issue. */
export function waitedIssue(wakeup: Pick<WakeupPreview, "condition">) {
  const condition = wakeup.condition;
  return condition?.type === "other_issue"
    ? { id: condition.issue_id, identifier: condition.identifier }
    : null;
}

export type WaitedIssue = NonNullable<ReturnType<typeof waitedIssue>>;

export interface IssueKeyPart {
  text: string;
  isKey: boolean;
}

/**
 * Cuts text around this workspace's issue keys. Only the workspace's own prefix
 * counts: the issue route resolves no other, and "GPT-5" is not a card.
 */
export function splitIssueKeys(text: string, prefix: string): IssueKeyPart[] {
  if (!prefix) return [{ text, isKey: false }];
  const pattern = new RegExp(`\\b${prefix.replace(/\W/g, "\\$&")}-\\d+\\b`, "gi");
  const parts: IssueKeyPart[] = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) parts.push({ text: text.slice(end, match.index), isKey: false });
    parts.push({ text: match[0], isKey: true });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end), isKey: false });
  return parts;
}

export function useIssueKeyParts(text: string) {
  return splitIssueKeys(text, useCurrentWorkspace()?.issue_prefix ?? "");
}

interface IssueRefProps {
  /** Issue id or key; the issue route accepts both. */
  routeId: string;
  /** Desktop tab title for clicks that open a new tab. */
  tabTitle?: string;
  /**
   * Inside another link or row, where a nested anchor is invalid HTML. Renders
   * the same span-as-link as IssueDuplicateOfMarker: it keeps the press from
   * starting a drag and the click from opening the row.
   */
  inRow?: boolean;
  children: ReactNode;
}

const stopPress = (e: React.SyntheticEvent) => e.stopPropagation();
const stop = (e: React.SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

function InRowIssueRef({ href, tabTitle, children }: { href: string; tabTitle?: string; children: ReactNode }) {
  const navigate = useIntentNavigate();
  return (
    <span
      role="link"
      tabIndex={0}
      onMouseDown={stopPress}
      onPointerDown={stopPress}
      onClick={(e) => {
        stop(e);
        navigate(href, resolveClickIntent(e), tabTitle);
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        stop(e);
        navigate(href, "background-tab", tabTitle);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        stop(e);
        navigate(href, "push", tabTitle);
      }}
      className={LINK_CLASS}
    >
      {children}
    </span>
  );
}

export function IssueRef({ routeId, tabTitle, inRow = false, children }: IssueRefProps) {
  const href = useWorkspacePaths().issueDetail(routeId);
  return inRow ? (
    <InRowIssueRef href={href} tabTitle={tabTitle}>
      {children}
    </InRowIssueRef>
  ) : (
    <AppLink href={href} newTabTitle={tabTitle} className={LINK_CLASS}>
      {children}
    </AppLink>
  );
}

/**
 * A wake sentence with the waited-on issue linked. Only the key is the link, so
 * the rest of the sentence still belongs to the row around it; a condition
 * saved without its key links the whole sentence instead.
 */
export function WaitedIssueText({
  text,
  issue,
  inRow,
}: {
  text: string;
  issue: WaitedIssue;
  inRow?: boolean;
}) {
  const at = issue.identifier ? text.indexOf(issue.identifier) : -1;
  if (!issue.identifier || at < 0) {
    return (
      <IssueRef routeId={issue.id} tabTitle={issue.identifier} inRow={inRow}>
        {text}
      </IssueRef>
    );
  }
  return (
    <>
      {text.slice(0, at)}
      <IssueRef routeId={issue.id} tabTitle={issue.identifier} inRow={inRow}>
        {issue.identifier}
      </IssueRef>
      {text.slice(at + issue.identifier.length)}
    </>
  );
}

/** Free text with its issue keys linked and everything else left as text. */
export function IssueKeysText({ parts, inRow }: { parts: IssueKeyPart[]; inRow?: boolean }) {
  return (
    <>
      {parts.map((part, index) =>
        part.isKey ? (
          <IssueRef key={index} routeId={part.text} tabTitle={part.text} inRow={inRow}>
            {part.text}
          </IssueRef>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
