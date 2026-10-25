// @vitest-environment node
import { describe, expect, it } from "vitest";
import { layoutLayers } from "./graph-layout";

const byId = (nodes: ReturnType<typeof layoutLayers>) => Object.fromEntries(nodes.map((n) => [n.id, n]));

describe("layoutLayers", () => {
  it("puts blockers left of what they block, by longest path", () => {
    const nodes = byId(
      layoutLayers(["a", "b", "c", "d"], [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "a", to: "c" },
        { from: "d", to: "c" },
      ]),
    );
    expect(nodes.a!.layer).toBe(0);
    expect(nodes.d!.layer).toBe(0);
    expect(nodes.b!.layer).toBe(1);
    expect(nodes.c!.layer).toBe(2);
  });

  it("ignores edges to hidden nodes and keeps orders dense", () => {
    const nodes = layoutLayers(["a", "c"], [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(nodes.map((n) => [n.id, n.layer, n.order])).toEqual([
      ["a", 0, 0],
      ["c", 0, 1],
    ]);
  });

  it("terminates on a cycle", () => {
    const nodes = layoutLayers(["a", "b"], [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ]);
    expect(nodes).toHaveLength(2);
  });

  it("orders a layer by its blockers' rows", () => {
    const nodes = byId(
      layoutLayers(["x", "y", "late", "early"], [
        { from: "x", to: "early" },
        { from: "y", to: "late" },
      ]),
    );
    expect(nodes.early!.order).toBeLessThan(nodes.late!.order);
  });
});
