import { describe, expect, it } from "vitest";
import {
  NODE_R,
  SPINE_X,
  closeLaneGaps,
  placeTopology,
  reserveLaneHeights,
} from "../place-topology.js";
import type { Meta } from "../model.js";
import type {
  AgentStep,
  BandRef,
  BranchStep,
  LoopStep,
  Multiplicity,
  ParallelStep,
  PipelineStep,
  Step,
  Topology,
} from "../topology.js";

// ---------------------------------------------------------------------------
// Builders — hand-built tree IR literals only (the analyzer is upstream).
// ---------------------------------------------------------------------------

const span = { start: 0, end: 0 };

const agent = (label: string, phase: string | null, over: Partial<AgentStep> = {}): AgentStep => ({
  kind: "agent",
  label,
  phase,
  multiplicity: { kind: "one" },
  labelExplicit: false,
  span,
  ...over,
});

const band = (title: string, inMeta = true): BandRef => ({ title, inMeta });

const topo = (steps: Step[], bands: BandRef[], over: Partial<Topology> = {}): Topology => ({
  steps,
  bands,
  notes: [],
  hasOrchestration: true,
  requiredLevel: 1,
  recognizerLevel: 1,
  ...over,
});

const meta = (titles: string[], over: Partial<Meta> = {}): Meta => ({
  name: "wf",
  description: "d",
  phases: titles.map((title) => ({ title })),
  ...over,
});

const fanout = (
  multiplicity: Multiplicity,
  body: Step[],
  phase: string | null,
): ParallelStep => ({ kind: "parallel", form: "fanout", multiplicity, body, phase, span });

const branches = (arms: Step[][], phase: string | null): ParallelStep => ({
  kind: "parallel",
  form: "branches",
  branches: arms,
  phase,
  span,
});

const pipeline = (items: Multiplicity, stages: Step[][], phase: string | null): PipelineStep => ({
  kind: "pipeline",
  items,
  stages,
  phase,
  span,
});

const branch = (
  conditionLabel: string,
  thenSteps: Step[],
  elseSteps: Step[],
  phase: string | null,
): BranchStep => ({ kind: "branch", conditionLabel, thenSteps, elseSteps, phase, span });

const loop = (
  loopKind: LoopStep["loopKind"],
  conditionLabel: string,
  body: Step[],
  phase: string | null,
): LoopStep => ({ kind: "loop", loopKind, conditionLabel, body, phase, span });

/** The downward invariant: no edge ever points up (loops are badges, not edges). */
const everyEdgeFlowsDown = (layout: ReturnType<typeof placeTopology>): boolean =>
  layout.edges.every((e) => {
    const from = layout.nodes.find((n) => n.id === e.from);
    const to = layout.nodes.find((n) => n.id === e.to);
    return !!from && !!to && from.y <= to.y;
  });

const ofKind = (layout: ReturnType<typeof placeTopology>, kind: string) =>
  layout.nodes.filter((n) => n.kind === kind);
const edgesOfKind = (layout: ReturnType<typeof placeTopology>, kind: string) =>
  layout.edges.filter((e) => e.kind === kind);
/** Every node of `kind` is the source of at least one edge — no dangling. */
const allHaveOnward = (layout: ReturnType<typeof placeTopology>, ids: string[]) =>
  ids.every((id) => layout.edges.some((e) => e.from === id));

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

  it("a trailing empty band becomes a terminal control node at the bottom", () => {
    const layout = placeTopology(
      topo([agent("a", "P1")], [band("P1"), band("P2")]),
      meta(["P1", "P2"]),
    );
    expect(layout.lanes[1].empty).toBe(false);
    expect(layout.nodes.some((n) => n.kind === "control" && n.label === "end" && n.phase === 1)).toBe(true);
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

describe("placeTopology — sub-shapes", () => {
  it("named fan-out → fork · row of N members · barrier · sink; every member connects onward", () => {
    const body = agent("draft:${p}", "P1", {
      multiplicity: { kind: "named", names: ["a", "b", "c"] },
      expandedLabels: ["draft:a", "draft:b", "draft:c"],
      model: "sonnet",
    });
    const layout = placeTopology(
      topo([fanout({ kind: "named", names: ["a", "b", "c"] }, [body], "P1")], [band("P1")]),
      meta(["P1"]),
    );
    expect(ofKind(layout, "hub")).toHaveLength(2); // source + sink
    expect(ofKind(layout, "barrier")).toHaveLength(1);
    const members = ofKind(layout, "agent");
    expect(members).toHaveLength(3);
    expect(members.map((m) => m.label)).toEqual(["draft:a", "draft:b", "draft:c"]);
    expect(members.every((m) => m.model === "sonnet")).toBe(true);

    // No dangling fan: every member drops onto the barrier.
    expect(allHaveOnward(layout, members.map((m) => m.id))).toBe(true);
    expect(edgesOfKind(layout, "fan")).toHaveLength(3); // source → each member
    expect(edgesOfKind(layout, "merge")).toHaveLength(3); // each member → barrier
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });

  it("unknown-width fan-out → a single ×N representative circle (no scaffolding)", () => {
    const body = agent("read:${m}", "P1", { multiplicity: { kind: "unknown", hint: "modules" } });
    const layout = placeTopology(
      topo([fanout({ kind: "unknown", hint: "modules" }, [body], "P1")], [band("P1")]),
      meta(["P1"]),
    );
    const agents = ofKind(layout, "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0].mult).toBe("×N");
    expect(ofKind(layout, "barrier")).toHaveLength(0);
  });

  it("a fan-out too wide for the row collapses to ×N and logs it", () => {
    const names = Array.from({ length: 24 }, (_, i) => `candidate-number-${i}`);
    const body = agent("gen:${n}", "P1", { multiplicity: { kind: "named", names } });
    const layout = placeTopology(
      topo([fanout({ kind: "named", names }, [body], "P1")], [band("P1")]),
      meta(["P1"]),
    );
    expect(ofKind(layout, "agent")).toHaveLength(1);
    expect(ofKind(layout, "agent")[0].mult).toBe("×24");
    expect(layout.notes.some((n) => n.includes("exceeds width"))).toBe(true);
  });

  it("parallel branches in distinct phases → collapse to one side-by-side row", () => {
    const layout = placeTopology(
      topo(
        [
          agent("scope", "Scope"),
          branches([[agent("review:claude", "Claude")], [agent("review:external", "External")]], "Scope"),
          agent("merge", "Merge"),
        ],
        [band("Scope"), band("Claude"), band("External"), band("Merge")],
      ),
      meta(["Scope", "Claude", "External", "Merge"]),
    );
    const claude = layout.nodes.find((n) => n.label === "review:claude");
    const external = layout.nodes.find((n) => n.label === "review:external");
    // The two single-agent arms (consecutive phases) collapse into ONE lane and
    // place side by side: same lane, same y, different x.
    expect(claude?.phase).toBe(external?.phase);
    expect(Math.abs((claude?.y ?? 0) - (external?.y ?? 1))).toBeLessThan(1);
    expect(claude?.x).not.toBe(external?.x);
    // Scope · {Claude‖External} · Merge → 3 lanes; the middle lane carries both
    // arms as side-by-side members keyed to their ORIGINAL chip numbers (2, 3).
    expect(layout.lanes).toHaveLength(3);
    const row = layout.lanes[claude?.phase ?? -1];
    expect(row.members?.map((m) => m.ordinal)).toEqual([2, 3]);
    expect(layout.lanes[2].ordinal).toBe(4); // Merge keeps its original ordinal
    expect(allHaveOnward(layout, [claude?.id ?? "", external?.id ?? ""])).toBe(true);
    expect(ofKind(layout, "barrier")).toHaveLength(1);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });

  it("parallel branches with a multi-step arm → stays stacked, no collapse", () => {
    const layout = placeTopology(
      topo(
        [branches([[agent("a1", "P1"), agent("a2", "P1")], [agent("b", "P2")]], "P1")],
        [band("P1"), band("P2")],
      ),
      meta(["P1", "P2"]),
    );
    // Not all arms are single agents → ineligible for collapse: lanes stay
    // distinct (no members) and the arms stack rather than sharing a row.
    expect(layout.lanes).toHaveLength(2);
    expect(layout.lanes.some((l) => l.members)).toBe(false);
    expect(ofKind(layout, "barrier")).toHaveLength(1);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });

  it("pipeline → item columns × stage rows; every last-stage cell rejoins the sink (no dangling fan)", () => {
    const review = agent("review:${dim}", "Review", {
      expandedLabels: ["review:correctness", "review:security", "review:performance"],
    });
    const verify = fanout({ kind: "unknown", hint: "findings" }, [agent("verify:${f}", "Verify")], "Verify");
    const layout = placeTopology(
      topo(
        [pipeline({ kind: "named", names: ["correctness", "security", "performance"] }, [[review], [verify]], "Review")],
        [band("Review"), band("Verify")],
      ),
      meta(["Review", "Verify"]),
    );
    // 3 columns × 2 rows = 6 cells, + source + sink hubs.
    expect(ofKind(layout, "hub")).toHaveLength(2);
    expect(ofKind(layout, "agent")).toHaveLength(6);
    expect(edgesOfKind(layout, "stage")).toHaveLength(3); // one stage hop per column
    expect(edgesOfKind(layout, "merge")).toHaveLength(3); // every column → sink

    // The dangling-fan bug fixed: each verify cell (row 2) has an onward edge.
    const verifyCells = layout.nodes.filter((n) => n.kind === "agent" && n.phase === 1);
    expect(verifyCells).toHaveLength(3);
    expect(allHaveOnward(layout, verifyCells.map((n) => n.id))).toBe(true);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });

  it("branch → a decision plus all arms; the empty arm is a labeled stub", () => {
    const layout = placeTopology(
      topo(
        [
          agent("classify", "Classify"),
          branch("confidence < 0.5", [], [agent("fix:${area}", "Fix")], "Route"),
        ],
        [band("Classify"), band("Route"), band("Fix")],
      ),
      meta(["Classify", "Route", "Fix"]),
    );
    expect(ofKind(layout, "decision")).toHaveLength(1);
    const decision = ofKind(layout, "decision")[0];
    expect(decision.label).toBe("confidence < 0.5");
    const outgoing = layout.edges.filter((e) => e.from === decision.id);
    expect(outgoing).toHaveLength(2); // both arms shown
    expect(outgoing.map((e) => e.label).sort()).toEqual(["no", "yes"]);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });

  it("loop → a repeat badge on the body, and NEVER a back-edge", () => {
    const layout = placeTopology(
      topo([loop("while", "bracket.length > 1", [agent("match", "Judge")], "Judge")], [band("Judge")]),
      meta(["Judge"]),
    );
    expect(layout.loops).toHaveLength(1);
    expect(layout.loops[0].label).toBe("repeat while bracket.length > 1");
    const match = layout.nodes.find((n) => n.label === "match");
    expect(layout.loops[0].onNode).toBe(match?.id);
    expect(everyEdgeFlowsDown(layout)).toBe(true); // no edge target above its source
  });

  it("nested same-phase loops → stacked badges on the same node", () => {
    const inner = loop("for", "i < bracket.length", [agent("match", "Judge")], "Judge");
    const outer = loop("while", "bracket.length > 1", [inner], "Judge");
    const layout = placeTopology(topo([outer], [band("Judge")]), meta(["Judge"]));
    expect(layout.loops).toHaveLength(2);
    const match = layout.nodes.find((n) => n.label === "match");
    expect(layout.loops.every((l) => l.onNode === match?.id)).toBe(true);
    expect(layout.loops.map((l) => l.label)).toEqual([
      "repeat for i < bracket.length",
      "repeat while bracket.length > 1",
    ]);
  });

  it("a loop whose body spans phases stays local (badge + note, no back-edge)", () => {
    const layout = placeTopology(
      topo(
        [loop("while", "dryRounds < 2", [agent("find", "Find"), agent("verify", "Verify")], "Find")],
        [band("Find"), band("Verify"), band("Stop")],
      ),
      meta(["Find", "Verify", "Stop"]),
    );
    expect(layout.loops).toHaveLength(1);
    expect(layout.notes.some((n) => n.includes("spans phases"))).toBe(true);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });
});

describe("reserveLaneHeights — swimlane-table co-registration", () => {
  // A 3-lane sequential graph: one agent per phase, joined by cross-phase
  // edges — exactly the shape the table co-registration has to slide down.
  const threeLane = () =>
    placeTopology(
      topo(
        [agent("a", "One"), agent("b", "Two"), agent("c", "Three")],
        [band("One"), band("Two"), band("Three")],
      ),
      meta(["One", "Two", "Three"]),
    );

  it("inflates a too-short lane and slides everything below down by the delta", () => {
    const layout = threeLane();
    const before = {
      lane0H: layout.lanes[0].yBot - layout.lanes[0].yTop,
      lane1Top: layout.lanes[1].yTop,
      lane2Top: layout.lanes[2].yTop,
      height: layout.height,
      nodeY: layout.nodes.map((n) => n.y),
    };
    const target = before.lane0H + 100;
    reserveLaneHeights(layout, [target, 0, 0]);

    // lane 0 grew to exactly the requested height (delta +100)...
    expect(layout.lanes[0].yBot - layout.lanes[0].yTop).toBe(target);
    // ...later lanes slid down rigidly by the same delta (height preserved)...
    expect(layout.lanes[1].yTop).toBe(before.lane1Top + 100);
    expect(layout.lanes[2].yTop).toBe(before.lane2Top + 100);
    // ...lane-0 node stayed put; later-lane nodes moved down by the delta...
    expect(layout.nodes[0].y).toBe(before.nodeY[0]);
    expect(layout.nodes[1].y).toBe(before.nodeY[1] + 100);
    expect(layout.nodes[2].y).toBe(before.nodeY[2] + 100);
    // ...the page grew by the delta and every edge still flows downward.
    expect(layout.height).toBe(before.height + 100);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });

  it("leaves lanes already taller than their min untouched", () => {
    const layout = threeLane();
    const snapshot = JSON.stringify(layout);
    reserveLaneHeights(layout, [0, 0, 0]); // every band already exceeds 0
    expect(JSON.stringify(layout)).toBe(snapshot);
  });

  it("accumulates deltas when several lanes inflate", () => {
    const layout = threeLane();
    const lane2TopBefore = layout.lanes[2].yTop;
    const h0 = layout.lanes[0].yBot - layout.lanes[0].yTop;
    const h1 = layout.lanes[1].yBot - layout.lanes[1].yTop;
    reserveLaneHeights(layout, [h0 + 30, h1 + 20, 0]);
    // lane 2 sits below both inflations → shifted by 30 + 20.
    expect(layout.lanes[2].yTop).toBe(lane2TopBefore + 50);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });
});

describe("closeLaneGaps — seamless swimlane table", () => {
  const threeLane = () =>
    placeTopology(
      topo(
        [agent("a", "One"), agent("b", "Two"), agent("c", "Three")],
        [band("One"), band("Two"), band("Three")],
      ),
      meta(["One", "Two", "Three"]),
    );

  it("snaps every interior boundary so rows touch (no gaps), midpointing the gap", () => {
    const layout = threeLane();
    const before = layout.lanes.map((l) => ({ yTop: l.yTop, yBot: l.yBot }));
    // The flow leaves a real gap between consecutive bands to begin with.
    expect(before[1].yTop).toBeGreaterThan(before[0].yBot);

    closeLaneGaps(layout);

    // Adjacent bands now share an edge — row i's bottom IS row i+1's top.
    for (let i = 0; i < layout.lanes.length - 1; i++) {
      expect(layout.lanes[i].yBot).toBe(layout.lanes[i + 1].yTop);
      // ...and that shared edge is the midpoint of the original gap.
      expect(layout.lanes[i].yBot).toBe((before[i].yBot + before[i + 1].yTop) / 2);
    }
  });

  it("leaves the table's outer top/bottom (and page height) untouched", () => {
    const layout = threeLane();
    const firstTop = layout.lanes[0].yTop;
    const lastBot = layout.lanes[layout.lanes.length - 1].yBot;
    const height = layout.height;
    closeLaneGaps(layout);
    expect(layout.lanes[0].yTop).toBe(firstTop);
    expect(layout.lanes[layout.lanes.length - 1].yBot).toBe(lastBot);
    expect(layout.height).toBe(height);
  });
});
