/**
 * The Issues tab chip row: "All" + the workspace Issues page's saved views,
 * in the user's web order minus views hidden on web. Web's other built-ins
 * (members / agents) are intentionally not shown on mobile.
 */
import type { IssueView } from "@multica/core/api/schemas";
import { applyViewBarPrefs, type ViewBarPrefs } from "@multica/core/issue-views/view-bar-prefs";

export const ALL_CHIP_ID = "builtin:all";

export type IssuesChip =
  | { id: typeof ALL_CHIP_ID; kind: "all" }
  | { id: `view:${string}`; kind: "view"; view: IssueView };

const ALL_CHIP: IssuesChip = { id: ALL_CHIP_ID, kind: "all" };

export function composeIssuesChips(
  views: IssueView[] | undefined,
  prefs: ViewBarPrefs | undefined,
): IssuesChip[] {
  const viewChips: IssuesChip[] = (views ?? [])
    .filter((view) => view.scope_type === "workspace")
    .map((view) => ({ id: `view:${view.id}` as const, kind: "view" as const, view }));
  const items = [ALL_CHIP, ...viewChips].map((chip) => ({ barItemId: chip.id, chip }));
  const { visible } = applyViewBarPrefs(items, prefs, ALL_CHIP_ID);
  const rest = visible.map((item) => item.chip).filter((chip) => chip.kind === "view");
  return [ALL_CHIP, ...rest];
}

export function resolveSelectedChip(chips: IssuesChip[], rememberedId: string | null): IssuesChip {
  return chips.find((chip) => chip.id === rememberedId) ?? ALL_CHIP;
}
