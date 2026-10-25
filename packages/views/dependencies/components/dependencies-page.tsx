"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network } from "lucide-react";
import type { DependencyGraphNode } from "@multica/core/types";
import { STATUS_CONFIG } from "@multica/core/issues/config";
import { dependencyGraphOptions } from "@multica/core/issues/queries";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { Switch } from "@multica/ui/components/ui/switch";
import { CollectionPageHeader, CollectionPageState } from "../../layout/collection-page";
import { AppLink } from "../../navigation";
import { StatusIcon } from "../../issues/components/status-icon";
import { useT } from "../../i18n";
import { layoutLayers } from "./graph-layout";

// Workspace dependency graph (Contango fork): every issue on a blocked-by edge,
// blockers on the left, edges pointing at the issue that waits.

/** Cards waiting on an issue before it counts as critical path. */
export const CRITICAL_PATH_MIN = 3;

const NODE_W = 220;
const NODE_H = 52;
const GAP_X = 72;
const GAP_Y = 16;
const PAD = 16;

export function DependenciesPage() {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { categoryOf, colorOf, iconOf } = useIssueStatuses(wsId);
  const { data, isLoading } = useQuery(dependencyGraphOptions(wsId));
  const [hideClosed, setHideClosed] = useState(true);
  const [onlyCritical, setOnlyCritical] = useState(false);

  const graph = useMemo(() => {
    const isCritical = (n: DependencyGraphNode) => (n.critical_path ?? 0) >= CRITICAL_PATH_MIN;
    let nodes = data?.nodes ?? [];
    if (hideClosed) {
      nodes = nodes.filter((n) => {
        const category = categoryOf(n.status);
        return category !== "done" && category !== "closed";
      });
    }
    if (onlyCritical) nodes = nodes.filter(isCritical);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (data?.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to));
    // An issue whose every partner is hidden has nothing to show, except a
    // critical-path issue in the critical-only view.
    const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
    nodes = nodes.filter((n) => linked.has(n.id) || (onlyCritical && isCritical(n)));
    const layout = layoutLayers(nodes.map((n) => n.id), edges);
    const pos = new Map(
      layout.map((l) => [l.id, { x: PAD + l.layer * (NODE_W + GAP_X), y: PAD + l.order * (NODE_H + GAP_Y) }]),
    );
    const width = PAD * 2 + (Math.max(-1, ...layout.map((l) => l.layer)) + 1) * (NODE_W + GAP_X) - GAP_X;
    const height = PAD * 2 + (Math.max(-1, ...layout.map((l) => l.order)) + 1) * (NODE_H + GAP_Y) - GAP_Y;
    return { nodes, edges, pos, width, height, isCritical };
  }, [data, hideClosed, onlyCritical, categoryOf]);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <CollectionPageHeader
        icon={Network}
        title={t(($) => $.dependencies.page_title)}
        count={graph.nodes.length}
        actions={
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-caption text-muted-foreground">
              {t(($) => $.dependencies.hide_closed)}
              <Switch size="sm" checked={hideClosed} onCheckedChange={setHideClosed} />
            </label>
            <label className="flex items-center gap-2 text-caption text-muted-foreground">
              {t(($) => $.dependencies.only_critical)}
              <Switch size="sm" checked={onlyCritical} onCheckedChange={setOnlyCritical} />
            </label>
          </div>
        }
      />
      {isLoading ? null : graph.nodes.length === 0 ? (
        <CollectionPageState icon={Network} title={t(($) => $.dependencies.empty)} />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="relative" style={{ width: graph.width, height: graph.height }}>
            <svg className="absolute inset-0 text-faint-foreground" width={graph.width} height={graph.height} aria-hidden="true">
              <defs>
                <marker id="dependency-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                </marker>
              </defs>
              {graph.edges.map((e) => {
                const a = graph.pos.get(e.from)!;
                const b = graph.pos.get(e.to)!;
                const x1 = a.x + NODE_W;
                const y1 = a.y + NODE_H / 2;
                const x2 = b.x - 2;
                const y2 = b.y + NODE_H / 2;
                const mid = (x1 + x2) / 2;
                return (
                  <path
                    key={`${e.from}-${e.to}`}
                    d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.25}
                    markerEnd="url(#dependency-arrow)"
                  />
                );
              })}
            </svg>
            {graph.nodes.map((n) => {
              const p = graph.pos.get(n.id)!;
              const critical = graph.isCritical(n);
              const color = colorOf(n.status);
              return (
                <AppLink
                  key={n.id}
                  href={paths.issueDetail(n.id)}
                  newTabTitle={n.identifier}
                  title={`${n.identifier} ${n.title}`}
                  className={`group absolute flex overflow-hidden rounded-md border bg-surface text-caption shadow-[var(--surface-shadow)] transition-colors hover:bg-surface-hover ${critical ? "border-warning ring-1 ring-warning/50" : "border-surface-border"}`}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                >
                  <span
                    className={`w-1 shrink-0 ${color ? "" : STATUS_CONFIG[categoryOf(n.status)].dividerColor}`}
                    style={color ? { backgroundColor: color } : undefined}
                  />
                  <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2">
                    <span className="flex items-center gap-1.5">
                      <StatusIcon
                        status={n.status}
                        color={color}
                        icon={iconOf(n.status)}
                        category={categoryOf(n.status)}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className="text-muted-foreground">{n.identifier}</span>
                      {n.critical_path != null && n.critical_path > 0 && (
                        <span
                          title={t(($) => $.dependencies.critical, { count: n.critical_path })}
                          className={`ml-auto rounded-full px-1.5 text-micro font-medium tabular-nums ${critical ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground"}`}
                        >
                          {n.critical_path}
                        </span>
                      )}
                    </span>
                    <span className="truncate font-medium group-hover:text-foreground">{n.title}</span>
                  </span>
                </AppLink>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
