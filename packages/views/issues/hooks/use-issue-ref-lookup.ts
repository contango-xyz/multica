"use client";

import { useQuery } from "@tanstack/react-query";
import { issueIdentifierOptions } from "@multica/core/issues/queries";
import { parseIssueRef } from "@multica/core/issues/issue-ref";
import { useCurrentWorkspace } from "@multica/core/paths";
import type { Issue } from "@multica/core/types";

export type IssueRefLookup =
  | { state: "none"; identifier: null; issue: null }
  | { state: "loading" | "missing" | "error"; identifier: string; issue: null }
  | { state: "found"; identifier: string; issue: Issue };

/**
 * Find-by-id for search boxes (contango patch 50): when `text` reads as an
 * issue id of the current workspace (`CTG-2850`, `ctg 2850`, `#2850`, `2850`,
 * a pasted issue link), look that one issue up with the exact
 * `GET /api/issues/{identifier}` read (unique `(workspace_id, number)` index),
 * whatever its status and whatever the screen's filters hide. Shares the
 * autolink's cache entry, so a known id answers without a request.
 */
export function useIssueRefLookup(text: string): IssueRefLookup {
  const workspace = useCurrentWorkspace();
  const wsId = workspace?.id ?? "";
  const identifier = wsId ? parseIssueRef(text, workspace?.issue_prefix) : null;
  const { data, isError, isPending } = useQuery({
    ...issueIdentifierOptions(wsId, identifier ?? ""),
    enabled: identifier !== null,
    retry: 1,
  });

  if (identifier === null) return { state: "none", identifier: null, issue: null };
  if (data) return { state: "found", identifier: data.identifier || identifier, issue: data };
  if (data === null) return { state: "missing", identifier, issue: null };
  if (isError) return { state: "error", identifier, issue: null };
  return { state: isPending ? "loading" : "missing", identifier, issue: null };
}
