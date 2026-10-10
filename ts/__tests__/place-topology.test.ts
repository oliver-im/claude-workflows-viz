import { describe, expect, it } from "vitest";
import { closeLaneGaps, placeTopology, reserveLaneHeights } from "../place-topology.js";
import type { Meta } from "../model.js";
import type {
  AgentStep,
  BandRef,
  BranchStep,
  ControlStep,
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

const control = (
  label: string,
  phase: string | null,
  flow: ControlStep["flow"],
): ControlStep => ({ kind: "control", label, flow, phase, span });

/** The downward invariant: no edge ever points up (loops are frames, not edges). */
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
/** Every edge is orthogonal: consecutive points share an x or a y. */
const everyEdgeIsOrthogonal = (layout: ReturnType<typeof placeTopology>): boolean =>
  layout.edges.every((e) =>
    e.points.every((p, i) => i === 0 || Math.abs(p.x - e.points[i - 1].x) < 0.01 || Math.abs(p.y - e.points[i - 1].y) < 0.01),
  );
/** Every node of `kind` is the source of at least one edge — no dangling. */
const allHaveOnward = (layout: ReturnType<typeof placeTopology>, ids: string[]) =>
  ids.every((id) => layout.edges.some((e) => e.from === id));

describe("placeTopology — skeleton", () => {
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
});

describe("placeTopology — sub-shapes", () => {
  it("named fan-out → fork · row of N member cards · join; every member drops onto the join", () => {
    const body = agent("draft:${p}", "P1", {
      multiplicity: { kind: "named", names: ["a", "b", "c"] },
      expandedLabels: ["draft:a", "draft:b", "draft:c"],
      labelExplicit: true,
      model: "sonnet",
    });
    const layout = placeTopology(
      topo([fanout({ kind: "named", names: ["a", "b", "c"] }, [body], "P1")], [band("P1")]),
      meta(["P1"]),
    );
    // The fork is a bare junction the rail leaves from; the join bar is the exit —
    // no sink dot under it.
    const hubs = ofKind(layout, "hub");
    expect(hubs).toHaveLength(1);
    expect(hubs[0].fork).toBe(true);
    expect(ofKind(layout, "barrier")).toHaveLength(1);
    const members = ofKind(layout, "agent");
    expect(members).toHaveLength(3);
    expect(members.map((m) => m.label)).toEqual(["draft:a", "draft:b", "draft:c"]);
    expect(members.every((m) => m.model === "sonnet")).toBe(true);
    // One row: the members share a top edge and a width.
    expect(new Set(members.map((m) => m.y - (m.h ?? 0) / 2)).size).toBe(1);
    expect(new Set(members.map((m) => m.w)).size).toBe(1);

    // No dangling fan: every member drops onto the join.
    expect(allHaveOnward(layout, members.map((m) => m.id))).toBe(true);
    expect(edgesOfKind(layout, "fan")).toHaveLength(3); // fork → each member
    expect(edgesOfKind(layout, "merge")).toHaveLength(3); // each member → join
    expect(everyEdgeFlowsDown(layout)).toBe(true);
    expect(everyEdgeIsOrthogonal(layout)).toBe(true);
  });

  it("unknown-width fan-out → one ×N stack, captioned with its source, that still waits at a join", () => {
    const body = agent("read:${m}", "P1", { multiplicity: { kind: "unknown", hint: "modules" }, labelExplicit: true });
    const layout = placeTopology(
      topo([fanout({ kind: "unknown", hint: "modules" }, [body], "P1")], [band("P1")]),
      meta(["P1"]),
    );
    const agents = ofKind(layout, "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0].mult).toBe("×N");
    // The label stays verbatim; the count's source rides as the caption.
    expect(agents[0].card?.lines).toEqual(["read:${m}"]);
    expect(agents[0].card?.caption).toBe("modules");
    // parallel() is a barrier even for one drawn stack: no fork, one join.
    expect(ofKind(layout, "hub")).toHaveLength(0);
    expect(ofKind(layout, "barrier")).toHaveLength(1);
    expect(allHaveOnward(layout, [agents[0].id])).toBe(true);
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

  it("pipeline → item columns × stage rows; every last-stage cell drops onto the join (no dangling fan)", () => {
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
    // 3 columns × 2 rows = 6 cells, a fork, and the join `await pipeline` waits at.
    expect(ofKind(layout, "hub")).toHaveLength(1);
    expect(ofKind(layout, "barrier")).toHaveLength(1);
    expect(ofKind(layout, "agent")).toHaveLength(6);
    expect(edgesOfKind(layout, "stage")).toHaveLength(3); // one stage hop per column
    expect(edgesOfKind(layout, "merge")).toHaveLength(3); // every column → join
    // No barrier BETWEEN stages: each stage hop is a straight drop in its column.
    expect(edgesOfKind(layout, "stage").every((e) => e.points.length === 2)).toBe(true);

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
    const targetFor = (outcome: string) =>
      layout.nodes.find((n) => n.id === outgoing.find((e) => e.label === outcome)?.to);
    // Low confidence takes the empty then-arm; only the no-arm reaches the fix.
    // Checking just the set of labels lets a yes/no swap reverse the meaning.
    expect(targetFor("yes")).toMatchObject({ kind: "hub", label: "" });
    expect(targetFor("no")).toMatchObject({ kind: "agent", label: "fix:${area}" });
    // The side arm leaves the diamond's right vertex, so the condition sits left.
    const yes = outgoing.find((e) => e.label === "yes");
    expect(yes?.points[0]).toEqual({ x: decision.x + 10, y: decision.y });
    expect(decision.labelSide).toBe("left");
    expect(everyEdgeFlowsDown(layout)).toBe(true);
    expect(everyEdgeIsOrthogonal(layout)).toBe(true);
  });

  it("nested same-phase loops → nested frames around the same node, each with its condition", () => {
    const inner = loop("for", "i < bracket.length", [agent("match", "Judge")], "Judge");
    const outer = loop("while", "bracket.length > 1", [inner], "Judge");
    const layout = placeTopology(topo([outer], [band("Judge")]), meta(["Judge"]));
    expect(layout.frames).toHaveLength(2);
    const [innerFrame, outerFrame] = layout.frames; // a nested loop's frame comes first
    expect(innerFrame.keyword).toBe("for");
    expect(innerFrame.condition).toBe("i < bracket.length");
    expect(outerFrame.keyword).toBe("while");
    expect(outerFrame.condition).toBe("bracket.length > 1");
    expect(innerFrame.outer).toBe(outerFrame.id);
    // Strict nesting, and both frames enclose the one work node.
    expect(innerFrame.x0).toBeGreaterThan(outerFrame.x0);
    expect(innerFrame.x1).toBeLessThan(outerFrame.x1);
    expect(innerFrame.y0).toBeGreaterThan(outerFrame.y0);
    expect(innerFrame.y1).toBeLessThan(outerFrame.y1);
    const match = layout.nodes.find((n) => n.label === "match");
    for (const f of layout.frames) {
      expect(match!.x).toBeGreaterThan(f.x0);
      expect(match!.x).toBeLessThan(f.x1);
      expect(match!.y).toBeGreaterThan(f.y0);
      expect(match!.y).toBeLessThan(f.y1);
    }
  });

  it("nested guard-headed loops: the innermost loop owns the guard's continue, a self-loop", () => {
    // while > for sharing one `if (!opponent) continue;` guard — the guard heads
    // the inner body, so its continue loops straight back to itself, and the arc
    // belongs to the inner frame.
    const guard = branch("!opponent", [control("continue loop", "Judge", "continue")], [], "Judge");
    const inner = loop("for", "i < bracket.length", [guard, agent("match", "Judge")], "Judge");
    const layout = placeTopology(
      topo([loop("while", "bracket.length > 1", [inner], "Judge")], [band("Judge")]),
      meta(["Judge"]),
    );
    const gate = layout.nodes.find((n) => n.kind === "decision");
    expect(layout.frames).toHaveLength(2);
    expect(layout.controlArcs).toHaveLength(1);
    const [arc] = layout.controlArcs;
    expect(arc).toMatchObject({ flow: "continue", fromId: gate?.id, toId: gate?.id });
    expect(arc.frame).toBe(layout.frames[0].id);
    expect(everyEdgeFlowsDown(layout)).toBe(true);
  });

  it("a break guard wires a forward exit arc to the loop's successor, not a box", () => {
    // while (…) { critic(); if (done) break; fill() }  then  assemble() — break
    // exits the loop FORWARD to its successor (the assemble agent placed after the
    // loop), drawn as a coral arc, never a "break loop" box. Its target is resolved
    // by the enclosing chain, not placeLoop, since it doesn't exist yet at loop time.
    const guard = branch("done", [control("break loop", "Critique", "break")], [], "Critique");
    const layout = placeTopology(
      topo(
        [
          loop("while", "rounds < 3", [agent("critic", "Critique"), guard, agent("fill", "Critique")], "Critique"),
          agent("assemble", "Assemble"),
        ],
        [band("Critique"), band("Assemble")],
      ),
      meta(["Critique", "Assemble"]),
    );
    const gate = layout.nodes.find((n) => n.kind === "decision");
    const assemble = layout.nodes.find((n) => n.label === "assemble");
    const brk = layout.controlArcs.find((a) => a.flow === "break");
    expect(brk).toBeDefined();
    expect(brk?.fromId).toBe(gate?.id);
    expect(brk?.toId).toBe(assemble?.id); // forward to the successor, skipping the rest
    expect(assemble!.y).toBeGreaterThan(gate!.y); // and it points DOWN, out of the loop
    expect(brk?.frame).toBe(layout.frames[0].id); // it leaves its own loop's frame
    expect(assemble!.y).toBeGreaterThan(layout.frames[0].y1); // to a node below it
    expect(layout.nodes.some((n) => n.kind === "control" && n.label === "break loop")).toBe(false);
    expect(everyEdgeFlowsDown(layout)).toBe(true); // the arc is a decoration, not an edge
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

describe("placeTopology — review regressions", () => {
  const lanesDisjoint = (layout: ReturnType<typeof placeTopology>): boolean =>
    layout.lanes.every((l, i) => i === 0 || l.yTop >= layout.lanes[i - 1].yBot - 0.5);
  const breakGuards = (layout: ReturnType<typeof placeTopology>) =>
    layout.nodes.filter((n) => n.kind === "decision" && n.guardFlow === "break");
  const everyBreakDrawn = (layout: ReturnType<typeof placeTopology>): boolean =>
    breakGuards(layout).every((g) => layout.controlArcs.some((a) => a.flow === "break" && a.fromId === g.id));
  const guard = (cond: string, flow: "break" | "continue", phase: string) =>
    branch(cond, [control(`${flow} loop`, phase, flow)], [], phase);

  it("a break in a loop that ends the workflow still exits to a final node", () => {
    const layout = placeTopology(
      topo(
        [loop("while", "round < 3", [agent("review", "Refine"), guard("r.ok", "break", "Refine"), agent("revise", "Refine")], "Refine")],
        [band("Refine")],
      ),
      meta(["Refine"]),
    );
    expect(everyBreakDrawn(layout)).toBe(true);
    const arc = layout.controlArcs.find((a) => a.flow === "break");
    expect(layout.nodes.find((n) => n.id === arc?.toId)?.flow).toBe("terminal");
  });

  it("a break in a loop inside an if-arm exits to the step after the branch", () => {
    const inner = loop("while", "c", [agent("x", "P"), guard("done", "break", "P")], "P");
    const layout = placeTopology(
      topo([branch("deep", [inner], [], "P"), agent("final", "P")], [band("P")]),
      meta(["P"]),
    );
    const arc = layout.controlArcs.find((a) => a.flow === "break");
    expect(layout.nodes.find((n) => n.id === arc?.toId)?.label).toBe("final");
  });

  it("a break from an inner loop that ends the outer body returns to the outer body's top, not past both loops", () => {
    const inner = loop("for", "const f of items", [agent("check", "P"), guard("fatal", "break", "P")], "P");
    const outer = loop("while", "round < 5", [agent("find", "P"), inner], "P");
    const layout = placeTopology(topo([outer, agent("digest", "P")], [band("P")]), meta(["P"]));
    const arc = layout.controlArcs.find((a) => a.flow === "break");
    expect(layout.nodes.find((n) => n.id === arc?.toId)?.label).toBe("find");
  });

  it("an empty arm placed below its sibling doesn't drag its lane over the sibling's row", () => {
    // triage-issue with the arms swapped: the work is the then-arm, the stub the else.
    const layout = placeTopology(
      topo(
        [agent("classify", "Classify"), branch("ok", [agent("fix", "Fix")], [], "Route"), agent("reply", "Reply")],
        [band("Classify"), band("Route"), band("Fix"), band("Reply")],
      ),
      meta(["Classify", "Route", "Fix", "Reply"]),
    );
    expect(lanesDisjoint(layout)).toBe(true);
    const fix = layout.nodes.find((n) => n.label === "fix")!;
    const fixLane = layout.lanes[fix.phase];
    expect(fix.y).toBeGreaterThan(fixLane.yTop);
    expect(fix.y).toBeLessThan(fixLane.yBot);
  });

  it("an empty pipeline stage doesn't pull a lane back to the first row", () => {
    const p = pipeline({ kind: "named", names: ["a", "b"] }, [[agent("review:${x}", "Review")], []], "Review");
    const layout = placeTopology(topo([agent("first", "Intro"), p], [band("Intro"), band("Review")]), meta(["Intro", "Review"]));
    expect(lanesDisjoint(layout)).toBe(true);
  });

  it("stacked parallel arms that end in a later phase put their join in that phase", () => {
    const layout = placeTopology(
      topo(
        [branches([[agent("l1", "One"), agent("l2", "Two")], [agent("r1", "One"), agent("r2", "Two")]], "One")],
        [band("One"), band("Two")],
      ),
      meta(["One", "Two"]),
    );
    const join = layout.nodes.find((n) => n.kind === "barrier");
    expect(join?.phase).toBe(1);
  });

  it("an edge rerouted above a loop frame stays orthogonal when it enters a fork", () => {
    const fan = fanout({ kind: "named", names: ["a", "b"] }, [agent("t:${i}", "P", { labelExplicit: true })], "P");
    const layout = placeTopology(
      topo([branch("flag", [agent("a", "P")], [], "P"), loop("while", "more", [fan], "P")], [band("P")]),
      meta(["P"]),
    );
    const orthogonal = layout.edges.every((e) =>
      e.points.every((p, i) => i === 0 || Math.abs(p.x - e.points[i - 1].x) < 0.01 || Math.abs(p.y - e.points[i - 1].y) < 0.01),
    );
    expect(orthogonal).toBe(true);
  });

  it("side-by-side arms are sized by what they actually contain, so a branch arm never overlaps its neighbour", () => {
    const layout = placeTopology(
      topo([branches([[branch("flag", [agent("A", "P")], [], "P")], [agent("B", "P")]], "P")], [band("P")]),
      meta(["P"]),
    );
    const b = layout.nodes.find((n) => n.label === "B")!;
    const stubs = layout.nodes.filter((n) => n.kind === "hub" && n.fork !== true);
    for (const s of stubs) expect(Math.abs(s.x - b.x)).toBeGreaterThan((b.w ?? 0) / 2);
    // Every arm exit drops onto the join, inside its span.
    const join = layout.nodes.find((n) => n.kind === "barrier")!;
    for (const e of layout.edges.filter((x) => x.to === join.id)) {
      expect(e.points[0].x).toBeGreaterThanOrEqual(join.x - (join.w ?? 0) / 2);
      expect(e.points[0].x).toBeLessThanOrEqual(join.x + (join.w ?? 0) / 2);
    }
  });

  it("a fan-out whose body has several steps draws the body once, each card a stack — never a fake 'task' agent", () => {
    const m: Multiplicity = { kind: "unknown", hint: "files" };
    const body = [
      agent("read:${f}", "P", { multiplicity: m, labelExplicit: true }),
      agent("fix:${f}", "P", { multiplicity: m, labelExplicit: true }),
    ];
    const layout = placeTopology(topo([fanout(m, body, "P")], [band("P")]), meta(["P"]));
    const agents = ofKind(layout, "agent");
    expect(agents.map((a) => a.label)).toEqual(["read:${f}", "fix:${f}"]);
    expect(agents.every((a) => a.mult === "×N")).toBe(true);
    expect(layout.nodes.some((n) => n.label === "task")).toBe(false);
    expect(ofKind(layout, "barrier")).toHaveLength(1);
  });

  it("degenerate shapes never throw or emit NaN: a stage-less pipeline, an empty parallel", () => {
    const empty: ParallelStep = { kind: "parallel", form: "branches", branches: [], phase: "P", span };
    for (const step of [pipeline({ kind: "named", names: ["a"] }, [], "P"), empty]) {
      const layout = placeTopology(topo([step], [band("P")]), meta(["P"]));
      expect(layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    }
  });
});
