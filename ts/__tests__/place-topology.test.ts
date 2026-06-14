import { describe, expect, it } from "vitest";
import { NODE_R, SPINE_X, placeTopology } from "../place-topology.js";
import type { Meta } from "../model.js";
import type { AgentStep, BandRef, Step, Topology } from "../topology.js";

// ---------------------------------------------------------------------------
// Builders — hand-built tree IR literals only (the analyzer is upstream).
// ---------------------------------------------------------------------------

const span = { start: 0, end: 0 };

const agent = (label: string, phase: string | null, over: Partial<AgentStep> = {}): AgentStep => ({
  kind: "agent",
  label,
  phase,
  multiplicity: { kind: "one" },
  span,
  ...over,
});

const band = (title: string, inMeta = true): BandRef => ({ title, inMeta });

const topo = (steps: Step[], bands: BandRef[], over: Partial<Topology> = {}): Topology => ({
  steps,
  bands,
  notes: [],
  hasOrchestration: true,
  ...over,
});

const meta = (titles: string[], over: Partial<Meta> = {}): Meta => ({
  name: "wf",
  description: "d",
  phases: titles.map((title) => ({ title })),
  ...over,
});

/** The downward invariant: no edge ever points up (loops are badges, not edges). */
const everyEdgeFlowsDown = (layout: ReturnType<typeof placeTopology>): boolean =>
  layout.edges.every((e) => {
    const from = layout.nodes.find((n) => n.id === e.from);
    const to = layout.nodes.find((n) => n.id === e.to);
    return !!from && !!to && from.y <= to.y;
  });

describe("placeTopology — skeleton", () => {
  it("single agent, one phase → one lane, one centered node, no edges", () => {
    const layout = placeTopology(topo([agent("do the thing", "Solo")], [band("Solo")]), meta(["Solo"]));
    expect(layout.lanes).toHaveLength(1);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
    const [n] = layout.nodes;
    expect(n.kind).toBe("agent");
    expect(n.x).toBe(SPINE_X);
    expect(n.phase).toBe(0);
    expect(layout.lanes[0].empty).toBe(false);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(2 * NODE_R);
  });

  it("two phases, one agent each → two stacked lanes + one mostly-vertical seq edge", () => {
    const layout = placeTopology(
      topo([agent("first", "P1"), agent("second", "P2")], [band("P1"), band("P2")]),
      meta(["P1", "P2"]),
    );
    expect(layout.lanes).toHaveLength(2);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);

    const [edge] = layout.edges;
    expect(edge.kind).toBe("seq");
    const [p0, p1] = edge.points;
    expect(Math.abs(p1.x - p0.x)).toBeLessThan(1); // vertical
    expect(p1.y).toBeGreaterThan(p0.y); // downward

    // lanes stacked top→down, not overlapping
    expect(layout.lanes[1].yTop).toBeGreaterThanOrEqual(layout.lanes[0].yBot - 1);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });

  it("carries the phase model onto its lane (tint/chip source), body-only bands carry none", () => {
    const layout = placeTopology(
      topo([agent("a", "P1"), agent("b", "Body")], [band("P1"), band("Body", false)]),
      meta(["P1"], { phases: [{ title: "P1", model: "opus" }] }),
    );
    expect(layout.lanes[0].model).toBe("opus");
    expect(layout.lanes[1].model).toBeUndefined();
  });

  it("an empty middle band collapses to a slim strip the flow passes through", () => {
    const layout = placeTopology(
      topo([agent("a", "P1"), agent("c", "P3")], [band("P1"), band("P2"), band("P3")]),
      meta(["P1", "P2", "P3"]),
    );
    expect(layout.lanes).toHaveLength(3);
    expect(layout.lanes[0].empty).toBe(false);
    expect(layout.lanes[1].empty).toBe(true); // the strip
    expect(layout.lanes[2].empty).toBe(false);

    // stacked in order, strip wedged between the two content lanes
    expect(layout.lanes[1].yTop).toBeGreaterThanOrEqual(layout.lanes[0].yBot - 1);
    expect(layout.lanes[2].yTop).toBeGreaterThanOrEqual(layout.lanes[1].yBot - 1);

    // the single seq edge flows from P1 straight past the strip into P3
    expect(layout.edges).toHaveLength(1);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });

  it("a trailing empty band becomes a strip at the bottom", () => {
    const layout = placeTopology(
      topo([agent("a", "P1")], [band("P1"), band("P2")]),
      meta(["P1", "P2"]),
    );
    expect(layout.lanes[1].empty).toBe(true);
    expect(layout.lanes[1].yTop).toBeGreaterThanOrEqual(layout.lanes[0].yBot - 1);
  });

  it("is a total function: an unknown step kind degrades to a placeholder, never throws", () => {
    const bogus = { kind: "frobnicate", phase: "P1", span } as unknown as Step;
    const t = topo([bogus], [band("P1")]);
    const m = meta(["P1"]);
    expect(() => placeTopology(t, m)).not.toThrow();
    const layout = placeTopology(t, m);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].kind).toBe("task");
    expect(layout.lanes[0].empty).toBe(false);
  });

  it("a body with no bands still lands its nodes in one lane", () => {
    const layout = placeTopology(topo([agent("x", null)], []), meta([]));
    expect(layout.lanes).toHaveLength(1);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].phase).toBe(0);
  });

  it("is deterministic for the same input", () => {
    const t = topo([agent("a", "P1"), agent("b", "P2")], [band("P1"), band("P2")]);
    const m = meta(["P1", "P2"]);
    expect(JSON.stringify(placeTopology(t, m))).toBe(JSON.stringify(placeTopology(t, m)));
  });
});
