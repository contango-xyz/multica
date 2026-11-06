// Pure pieces of the MVP page (Contango fork, patch 19): numbers and chart
// geometry, kept out of the components so they are tested without a DOM.
import type { MvpAsk, MvpCounts, MvpReport } from "@multica/core/types";

/** Done share of a group's cards, 0–100, rounded down so 99.6% never reads as done. */
export function percentDone(c: Pick<MvpCounts, "done" | "total">): number {
  if (c.total <= 0) return 0;
  return Math.floor((c.done / c.total) * 100);
}

/**
 * Open-card counts in the workspace's status display order; keys the catalog
 * does not know come last, alphabetically.
 */
export function orderedStatusCounts(byStatus: Record<string, number>, order: string[]): [string, number][] {
  const rank = new Map(order.map((k, i) => [k, i]));
  return Object.entries(byStatus)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => {
      const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : a.localeCompare(b);
    });
}

/** Ids of the cards on any critical path, for highlighting them elsewhere. */
export function criticalIds(report: Pick<MvpReport, "critical_paths">): Set<string> {
  return new Set(report.critical_paths.flatMap((c) => c.issues.map((i) => i.id)));
}

/** Whether the viewer can answer an ask with its one-tap replies: the smart-inbox entry is theirs. */
export function canReply(ask: MvpAsk, userId: string | undefined): boolean {
  return !!userId && !!ask.inbox_item_id && ask.recipient_id === userId && ask.replies.length > 0;
}

export interface ChartGeometry {
  width: number;
  height: number;
  /** Plot area inside the padding. */
  plot: { left: number; top: number; right: number; bottom: number };
  yMax: number;
  yTicks: number[];
  x: (i: number) => number;
  y: (v: number) => number;
  openPath: string;
  donePath: string;
}

/** A tidy upper bound and 3–5 ticks for a count axis starting at 0. */
export function niceTicks(max: number): { yMax: number; ticks: number[] } {
  if (max <= 0) return { yMax: 1, ticks: [0, 1] };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const yMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += step) ticks.push(Math.round(v));
  return { yMax, ticks };
}

/** Line chart geometry for the burndown: open and done counts per day. */
export function burndownGeometry(
  points: MvpReport["burndown"],
  width: number,
  height: number,
  pad = { left: 36, top: 12, right: 12, bottom: 24 },
): ChartGeometry {
  const plot = { left: pad.left, top: pad.top, right: width - pad.right, bottom: height - pad.bottom };
  const max = Math.max(0, ...points.map((p) => Math.max(p.open, p.done)));
  const { yMax, ticks } = niceTicks(max);
  const n = points.length;
  const x = (i: number) => (n <= 1 ? plot.left : plot.left + (i / (n - 1)) * (plot.right - plot.left));
  const y = (v: number) => plot.bottom - (v / yMax) * (plot.bottom - plot.top);
  const path = (key: "open" | "done") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  return { width, height, plot, yMax, yTicks: ticks, x, y, openPath: path("open"), donePath: path("done") };
}

/** Index of the point nearest an x position in the chart, for the hover crosshair. */
export function nearestIndex(geo: Pick<ChartGeometry, "plot">, count: number, px: number): number {
  if (count <= 1) return 0;
  const t = (px - geo.plot.left) / (geo.plot.right - geo.plot.left);
  return Math.min(count - 1, Math.max(0, Math.round(t * (count - 1))));
}
