"use client";

import { useState } from "react";
import type { MvpReport } from "@multica/core/types";
import { useT } from "../../i18n";
import { burndownGeometry, nearestIndex } from "./mvp-helpers";

// Open vs done MVP cards per day (hand-drawn SVG like the dependency graph, no
// chart library). Two series: open in the brand's strong chart step, done in a
// lighter step, a legend plus today's value at each line end, a crosshair
// tooltip and a screen-reader table.

const W = 640;
const H = 220;

export function BurndownChart({ points }: { points: MvpReport["burndown"] }) {
  const { t } = useT("issues");
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;
  const geo = burndownGeometry(points, W, H, { left: 36, top: 12, right: 40, bottom: 24 });
  const last = points.length - 1;
  const h = hover == null ? null : points[hover];
  const fmtDate = (d: string) => d.slice(5);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-caption text-muted-foreground" aria-hidden="true">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-chart-1" />
          {t(($) => $.mvp.series_open)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-chart-3" />
          {t(($) => $.mvp.series_done)}
        </span>
      </div>
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none select-none"
          role="img"
          aria-label={t(($) => $.mvp.burndown_title, { days: points.length - 1 })}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(nearestIndex(geo, points.length, ((e.clientX - r.left) / r.width) * W));
          }}
          onPointerLeave={() => setHover(null)}
        >
          {geo.yTicks.map((v) => (
            <g key={v} className="text-faint-foreground">
              <line x1={geo.plot.left} x2={geo.plot.right} y1={geo.y(v)} y2={geo.y(v)} stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />
              <text x={geo.plot.left - 6} y={geo.y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                {v}
              </text>
            </g>
          ))}
          {[0, Math.floor(last / 2), last].map((i) => (
            <text
              key={i}
              x={geo.x(i)}
              y={H - 6}
              textAnchor={i === 0 ? "start" : i === last ? "end" : "middle"}
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {fmtDate(points[i]!.date)}
            </text>
          ))}
          <path d={geo.donePath} fill="none" className="stroke-chart-3" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={geo.openPath} fill="none" className="stroke-chart-1" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {(["open", "done"] as const).map((k) => (
            <text
              key={k}
              x={geo.plot.right + 6}
              y={geo.y(points[last]![k])}
              dy={points[last]!.open === points[last]!.done ? (k === "open" ? "-0.4em" : "1em") : "0.32em"}
              className="fill-muted-foreground text-[10px] font-medium tabular-nums"
            >
              {points[last]![k]}
            </text>
          ))}
          {hover != null && (
            <g>
              <line x1={geo.x(hover)} x2={geo.x(hover)} y1={geo.plot.top} y2={geo.plot.bottom} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="3 3" />
              <circle cx={geo.x(hover)} cy={geo.y(points[hover]!.open)} r={4} className="fill-chart-1 stroke-background" strokeWidth={2} />
              <circle cx={geo.x(hover)} cy={geo.y(points[hover]!.done)} r={4} className="fill-chart-3 stroke-background" strokeWidth={2} />
            </g>
          )}
        </svg>
        {h && hover != null && (
          <div
            className="pointer-events-none absolute top-1 rounded-md border border-surface-border bg-surface px-2 py-1 text-caption shadow-[var(--surface-shadow)]"
            style={hover > last / 2 ? { right: `${100 - (geo.x(hover) / W) * 100 + 2}%` } : { left: `${(geo.x(hover) / W) * 100 + 2}%` }}
          >
            <div className="font-medium tabular-nums">{h.date}</div>
            <div className="text-muted-foreground tabular-nums">
              {t(($) => $.mvp.series_open)}: <span className="text-foreground">{h.open}</span>
            </div>
            <div className="text-muted-foreground tabular-nums">
              {t(($) => $.mvp.series_done)}: <span className="text-foreground">{h.done}</span>
            </div>
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>{t(($) => $.mvp.burndown_title, { days: points.length - 1 })}</caption>
        <thead>
          <tr>
            <th>{t(($) => $.mvp.date)}</th>
            <th>{t(($) => $.mvp.series_open)}</th>
            <th>{t(($) => $.mvp.series_done)}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td>{p.open}</td>
              <td>{p.done}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
