// Layered left-to-right layout for the dependency graph: blockers sit in
// earlier columns than the issues they block. Small graphs (tens of nodes), so
// a longest-path layering plus a few barycenter sweeps is enough; no layout
// library needed.

export interface GraphEdge {
  from: string;
  to: string;
}

export interface LayoutNode {
  id: string;
  layer: number;
  /** Position within the layer, top to bottom. */
  order: number;
}

const SWEEPS = 4;

/**
 * Assigns each node a column (layer) and a row (order). Nodes are given in
 * their tie-break order. Edges whose ends are not both in `nodeIds` are
 * ignored. The server refuses cycles; should one exist anyway, the layering
 * stops at the node count instead of looping.
 */
export function layoutLayers(nodeIds: string[], edges: GraphEdge[]): LayoutNode[] {
  const present = new Set(nodeIds);
  const live = edges.filter((e) => present.has(e.from) && present.has(e.to) && e.from !== e.to);
  const preds = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const succs = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of live) {
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
  }

  const layer = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (let pass = 0; pass < nodeIds.length; pass++) {
    let changed = false;
    for (const e of live) {
      const next = layer.get(e.from)! + 1;
      if (next > layer.get(e.to)! && next < nodeIds.length) {
        layer.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns: string[][] = [];
  for (const id of nodeIds) {
    const l = layer.get(id)!;
    (columns[l] ??= []).push(id);
  }
  const dense = columns.filter((c) => c && c.length > 0);

  const position = new Map<string, number>();
  const index = () => dense.forEach((col) => col.forEach((id, i) => position.set(id, i)));
  index();
  const reorder = (col: string[], neighbours: Map<string, string[]>) => {
    const key = new Map<string, number>();
    col.forEach((id, i) => {
      const ns = neighbours.get(id)!.filter((n) => position.has(n));
      key.set(id, ns.length ? ns.reduce((sum, n) => sum + position.get(n)!, 0) / ns.length : i);
    });
    col.sort((a, b) => key.get(a)! - key.get(b)!);
    col.forEach((id, i) => position.set(id, i));
  };
  for (let s = 0; s < SWEEPS; s++) {
    for (let l = 1; l < dense.length; l++) reorder(dense[l]!, preds);
    for (let l = dense.length - 2; l >= 0; l--) reorder(dense[l]!, succs);
  }
  index();

  return dense.flatMap((col, l) => col.map((id, order) => ({ id, layer: l, order })));
}
