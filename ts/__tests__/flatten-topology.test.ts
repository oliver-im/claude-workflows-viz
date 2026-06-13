import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeBody } from "../analyze-body.js";
import { extractMetaFromProgram, parseWorkflowSource } from "../extract-meta.js";
import { flattenTopology } from "../flatten-topology.js";
import type { Meta } from "../model.js";
import type {
  AgentStep,
  BranchStep,
  LoopStep,
  Multiplicity,
  OpaqueStep,
  ParallelStep,
  PipelineStep,
  Step,
  Topology,
  WorkflowStep,
} from "../topology.js";

/**
 * The flattener IS the graph-shape policy — these tests pin each policy
 * bullet with tree literals, then pin the exact graphs of all 8 example
 * workflows end-to-end (analyzer → flattener).
 */

// ---------------------------------------------------------------------------
// Tree-literal builders (spans are irrelevant to the flattener)
// ---------------------------------------------------------------------------

const SPAN = { start: 0, end: 0 };

const agent = (phase: string | null, label: string, extra?: Partial<AgentStep>): AgentStep => ({
  kind: "agent",
  phase,
  span: SPAN,
  label,
  multiplicity: { kind: "one" },
  ...extra,
});

const opaque = (phase: string | null, label: string): OpaqueStep => ({
  kind: "opaque",
  phase,
  span: SPAN,
  label,
});

const wf = (
  phase: string | null,
  label: string,
  multiplicity: Multiplicity = { kind: "one" },
): WorkflowStep => ({ kind: "workflow", phase, span: SPAN, label, multiplicity });

const fanout = (
  phase: string | null,
  multiplicity: Multiplicity,
  body: Step[],
): ParallelStep => ({ kind: "parallel", phase, span: SPAN, form: "fanout", multiplicity, body });

const branchesPar = (phase: string | null, branches: Step[][]): ParallelStep => ({
  kind: "parallel",
  phase,
  span: SPAN,
  form: "branches",
  branches,
});

const pipe = (phase: string | null, items: Multiplicity, stages: Step[][]): PipelineStep => ({
  kind: "pipeline",
  phase,
  span: SPAN,
  items,
  stages,
});

const loop = (phase: string | null, conditionLabel: string, body: Step[]): LoopStep => ({
  kind: "loop",
  phase,
  span: SPAN,
  loopKind: "while",
  conditionLabel,
  body,
});

const branch = (
  phase: string | null,
  conditionLabel: string,
  thenSteps: Step[],
  elseSteps: Step[],
): BranchStep => ({ kind: "branch", phase, span: SPAN, conditionLabel, thenSteps, elseSteps });

const mkMeta = (...titles: string[]): Meta => ({
  name: "t",
  description: "t",
  phases: titles.map((title) => ({ title })),
});

const mkTopo = (steps: Step[], bodyBands: string[] = []): Topology => ({
  steps,
  bands: bodyBands.map((title) => ({ title, inMeta: false })),
  notes: [],
  hasOrchestration: true,
});

const flatten = (meta: Meta, steps: Step[], bodyBands: string[] = []) =>
  flattenTopology(mkTopo(steps, bodyBands), meta);

/** "n0->n1" / "n0->n1:yes" — compact, exact, order-sensitive. */
const fmt = (links: readonly { from: string; to: string; label?: string }[]): string[] =>
  links.map((l) => `${l.from}->${l.to}${l.label !== undefined ? `:${l.label}` : ""}`);

// ---------------------------------------------------------------------------
// Bands & sequencing
// ---------------------------------------------------------------------------

describe("flattenTopology — bands & sequencing", () => {
  it("connects consecutive same-band steps with a sequence edge", () => {
    const { ir } = flatten(mkMeta("P"), [agent("P", "a"), agent("P", "b")]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 0]);
    expect(fmt(ir.edges)).toEqual(["n0->n1"]);
    expect(ir.loops).toEqual([]);
  });

  it("draws NOTHING for implicit cross-band succession", () => {
    const { ir } = flatten(mkMeta("P", "Q"), [agent("P", "a"), agent("Q", "b")]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1]);
    expect(ir.edges).toEqual([]);
    expect(ir.loops).toEqual([]);
  });

  it("orders bandTitles meta-first, body-only bands appended", () => {
    const { ir, bandTitles } = flatten(
      mkMeta("M"),
      [agent("M", "a"), agent("B", "b")],
      ["B"],
    );
    expect(bandTitles).toEqual(["M", "B"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1]);
  });

  it("appends a band the analyzer never registered (defensive)", () => {
    const { ir, bandTitles } = flatten(mkMeta("M"), [agent("X", "a")]);
    expect(bandTitles).toEqual(["M", "X"]);
    expect(ir.nodes[0].band).toBe(1);
  });

  it("resolves phase:null to the nearest following step's band, else band 0", () => {
    const next = flatten(mkMeta("P", "Q"), [agent(null, "a"), agent("Q", "b")]);
    expect(next.ir.nodes.map((n) => n.band)).toEqual([1, 1]);
    expect(fmt(next.ir.edges)).toEqual(["n0->n1"]);

    const tail = flatten(mkMeta("P", "Q"), [agent("Q", "a"), agent(null, "b")]);
    expect(tail.ir.nodes.map((n) => n.band)).toEqual([1, 0]);
    expect(tail.ir.edges).toEqual([]); // implicit succession never inverts the edge invariant
  });

  it("resolves phase:null inside a structure to the structure's band", () => {
    const { ir } = flatten(mkMeta("P", "Q"), [
      branch("Q", "c", [agent(null, "t")], [agent(null, "e")]),
    ]);
    expect(ir.nodes.map((n) => n.band)).toEqual([1, 1, 1]);
  });

  it("seeds one untitled band when a phase-less workflow still has steps (defensive)", () => {
    const { ir, bandTitles } = flatten(mkMeta(), [agent(null, "a"), agent(null, "b")]);
    expect(bandTitles).toEqual([""]); // node.band always indexes into bandTitles
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 0]);
    expect(fmt(ir.edges)).toEqual(["n0->n1"]);
  });
});

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

describe("flattenTopology — parallel fan-out", () => {
  it("emits body + barrier with the join edge; predecessor enters at the body head", () => {
    const named: Multiplicity = { kind: "named", names: ["x", "y"] };
    const { ir } = flatten(mkMeta("P"), [
      agent("P", "before"),
      fanout("P", named, [agent("P", "lane", { multiplicity: named })]),
    ]);
    // The predecessor contracts the source hub away (before → lane directly);
    // the open right end keeps its sink hub for visual closure.
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "barrier", "hub"]);
    expect(ir.nodes[1].mult).toEqual({ kind: "named", names: ["x", "y"] });
    expect(ir.nodes[2].label).toBe("");
    // join + barrier→sink (inside the structure), then the same-band entry edge
    expect(fmt(ir.edges)).toEqual(["n1->n2", "n2->n3", "n0->n1"]);
  });

  it("substitutes expandedLabels as the named multiplicity's names", () => {
    const named: Multiplicity = { kind: "named", names: ["x", "y"] };
    const { ir } = flatten(mkMeta("P"), [
      fanout("P", named, [
        agent("P", "r:${l}", { multiplicity: named, expandedLabels: ["r:x", "r:y"] }),
      ]),
    ]);
    expect(ir.nodes[0].mult).toEqual({ kind: "named", names: ["r:x", "r:y"] });
  });

  it("draws an unreadable fan-out as a placeholder 'agents' node, bracketed by hubs", () => {
    const { ir } = flatten(mkMeta("P"), [
      fanout("P", { kind: "unknown", hint: "xs" }, []),
    ]);
    // Open on both sides (no predecessor, no successor) → both hubs survive
    // around the placeholder + barrier.
    expect(ir.nodes).toStrictEqual([
      { id: "n0", band: 0, kind: "agent", label: "agents", mult: { kind: "unknown", hint: "xs" } },
      { id: "n1", band: 0, kind: "hub", label: "" },
      { id: "n2", band: 0, kind: "barrier", label: "" },
      { id: "n3", band: 0, kind: "hub", label: "" },
    ]);
    expect(fmt(ir.edges)).toEqual(["n1->n0", "n0->n2", "n2->n3"]);
  });

  it("places the barrier in the band of the last contributing node; lane-internal succession keeps the same-band rule", () => {
    const { ir } = flatten(mkMeta("P", "Q"), [
      fanout("P", { kind: "unknown" }, [agent("P", "a"), agent("Q", "b")]),
    ]);
    // a, b, source-hub(@a), barrier(@b), sink-hub(@b)
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "hub", "barrier", "hub"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1, 0, 1, 1]); // barrier follows the lane terminal
    // source→a; a→b crosses bands implicitly (no edge); b→barrier→sink
    expect(fmt(ir.edges)).toEqual(["n2->n0", "n1->n3", "n3->n4"]);
  });
});

// ---------------------------------------------------------------------------
// Fan-out hub contraction (the source/sink junctions + their splice pass)
// ---------------------------------------------------------------------------

describe("flattenTopology — fan-out hub contraction", () => {
  const named: Multiplicity = { kind: "named", names: ["x", "y"] };

  it("splices BOTH hubs out when same-band neighbors anchor each side", () => {
    const { ir } = flatten(mkMeta("P"), [
      agent("P", "before"),
      fanout("P", named, [agent("P", "lane", { multiplicity: named })]),
      agent("P", "after"),
    ]);
    // Predecessor + successor both connect → neither hub earns its keep; the
    // splice rewires straight through (before → lane … barrier → after).
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "barrier", "agent"]);
    expect(fmt(ir.edges)).toEqual(["n1->n2", "n0->n1", "n2->n3"]);
    expect(ir.loops).toEqual([]);
  });

  it("keeps both hubs when the fan-out is open on both sides", () => {
    const { ir } = flatten(mkMeta("P"), [
      fanout("P", named, [agent("P", "lane", { multiplicity: named })]),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "hub", "barrier", "hub"]);
    expect(fmt(ir.edges)).toEqual(["n1->n0", "n0->n2", "n2->n3"]); // source→lane→barrier→sink
  });

  it("never contracts a hub a loop arc lands on (the source IS the restart point)", () => {
    const { ir } = flatten(mkMeta("P"), [
      agent("P", "before"),
      loop("P", "again?", [fanout("P", named, [agent("P", "lane", { multiplicity: named })])]),
    ]);
    // The loop's back arc targets the fan-out's source hub, so even with a real
    // predecessor (before) and would-splice in/out edges, the source survives —
    // pinned by the arc as the fan's restart. The sink still contracts (into
    // the same-band decision).
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "hub", "barrier", "decision"]);
    expect(fmt(ir.edges)).toEqual(["n2->n1", "n1->n3", "n0->n2", "n3->n4"]);
    expect(fmt(ir.loops)).toEqual(["n4->n2:yes"]);
  });
});

// ---------------------------------------------------------------------------
// Branches (thunk-array parallel)
// ---------------------------------------------------------------------------

describe("flattenTopology — parallel branches", () => {
  it("fans every chain terminal into one shared barrier, crossing bands explicitly", () => {
    const { ir } = flatten(mkMeta("P", "Q"), [
      agent("P", "before"),
      branchesPar("P", [[agent("P", "lane1")], [agent("Q", "lane2")]]),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "agent", "barrier"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 0, 1, 1]); // barrier with the last contributor
    // chain fan-ins (lane1's crosses bands), then the same-band entry edge to lane1 only
    expect(fmt(ir.edges)).toEqual(["n1->n3", "n2->n3", "n0->n1"]);
  });

  it("stands the barrier alone when no chain emits (defensive)", () => {
    const { ir } = flatten(mkMeta("P"), [agent("P", "a"), branchesPar("P", [[], []])]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "barrier"]);
    expect(fmt(ir.edges)).toEqual(["n0->n1"]); // the barrier is the parallel's entry surface
  });
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe("flattenTopology — pipeline", () => {
  it("applies the items multiplicity to every stage's mult-one agents and chains stages without barriers", () => {
    const items: Multiplicity = { kind: "named", names: ["a", "b", "c"] };
    const { ir } = flatten(mkMeta("P"), [
      pipe("P", items, [[agent("P", "s1")], [agent("P", "s2")]]),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent"]); // NO barrier
    expect(ir.nodes[0].mult).toEqual({ kind: "named", names: ["a", "b", "c"] });
    expect(ir.nodes[1].mult).toEqual({ kind: "named", names: ["a", "b", "c"] });
    expect(fmt(ir.edges)).toEqual(["n0->n1"]);
  });

  it("uses a stage agent's expandedLabels as the applied multiplicity's names", () => {
    const items: Multiplicity = { kind: "named", names: ["a", "b"] };
    const { ir } = flatten(mkMeta("P"), [
      pipe("P", items, [[agent("P", "s:${d}", { expandedLabels: ["s:a", "s:b"] })]]),
    ]);
    expect(ir.nodes[0].mult).toEqual({ kind: "named", names: ["s:a", "s:b"] });
  });

  it("never clobbers a multiplicity an inner structure already threaded", () => {
    const items: Multiplicity = { kind: "exact", count: 3 };
    const inner: Multiplicity = { kind: "unknown", hint: "z" };
    const { ir } = flatten(mkMeta("P"), [
      pipe("P", items, [[fanout("P", inner, [agent("P", "v", { multiplicity: inner })])]]),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "hub", "barrier", "hub"]);
    expect(ir.nodes[0].mult).toEqual({ kind: "unknown", hint: "z" }); // per-lane truth kept
  });

  it("chains stages across bands (explicit edge)", () => {
    const { ir } = flatten(mkMeta("P", "Q"), [
      pipe("P", { kind: "exact", count: 2 }, [[agent("P", "s1")], [agent("Q", "s2")]]),
    ]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1]);
    expect(fmt(ir.edges)).toEqual(["n0->n1"]);
  });

  it("lets a stage ending in a branch merge into the next stage, bypass labeled", () => {
    const items: Multiplicity = { kind: "exact", count: 2 };
    const { ir } = flatten(mkMeta("P"), [
      pipe("P", items, [[branch("P", "c", [agent("P", "t")], [])], [agent("P", "s2")]]),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["decision", "agent", "agent"]);
    expect(fmt(ir.edges)).toEqual(["n0->n1:yes", "n1->n2", "n0->n2:no"]);
  });
});

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

describe("flattenTopology — branch", () => {
  it("labels arm heads yes/no and merges both arm terminals into the successor", () => {
    const { ir } = flatten(mkMeta("P"), [
      branch("P", "c", [agent("P", "t")], [agent("P", "e")]),
      agent("P", "next"),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["decision", "agent", "agent", "agent"]);
    expect(ir.nodes[0].label).toBe("c");
    expect(fmt(ir.edges)).toEqual(["n0->n1:yes", "n0->n2:no", "n1->n3", "n2->n3"]);
  });

  it("bypasses an empty arm straight to the successor, keeping the arm's label", () => {
    const { ir } = flatten(mkMeta("P"), [
      branch("P", "c", [], [agent("P", "e")]),
      agent("P", "next"),
    ]);
    expect(fmt(ir.edges)).toEqual(["n0->n1:no", "n1->n2", "n0->n2:yes"]);
  });

  it("lets arms simply terminate when the branch ends its sequence", () => {
    const { ir } = flatten(mkMeta("P"), [branch("P", "c", [], [agent("P", "e")])]);
    expect(fmt(ir.edges)).toEqual(["n0->n1:no"]); // no bypass, no merge
  });

  it("routes an arm edge that points back up the page into loops (invariant guard)", () => {
    const { ir } = flatten(mkMeta("P", "Q"), [branch("Q", "c", [agent("P", "early")], [])]);
    expect(ir.nodes.map((n) => n.band)).toEqual([1, 0]);
    expect(ir.edges).toEqual([]);
    expect(fmt(ir.loops)).toEqual(["n0->n1:yes"]); // band(from)=1 ≥ band(to)=0 holds
  });
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

describe("flattenTopology — loop", () => {
  it("synthesizes a decision after the body, loops back 'yes', exits 'no'", () => {
    const { ir } = flatten(mkMeta("P"), [
      loop("P", "more?", [agent("P", "work")]),
      agent("P", "after"),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "decision", "agent"]);
    expect(ir.nodes[1].label).toBe("more?");
    expect(fmt(ir.edges)).toEqual(["n0->n1", "n1->n2:no"]);
    expect(fmt(ir.loops)).toEqual(["n1->n0:yes"]);
  });

  it("draws no exit edge when the loop ends the sequence", () => {
    const { ir } = flatten(mkMeta("P"), [loop("P", "more?", [agent("P", "work")])]);
    expect(fmt(ir.edges)).toEqual(["n0->n1"]);
    expect(fmt(ir.loops)).toEqual(["n1->n0:yes"]);
  });

  it("bands the decision with the last body node, spanning bands like hunt-bugs", () => {
    const { ir } = flatten(mkMeta("P", "Q"), [
      loop("P", "again?", [
        agent("P", "find"),
        fanout("Q", { kind: "unknown", hint: "fresh" }, [
          agent("Q", "verify", { multiplicity: { kind: "unknown", hint: "fresh" } }),
        ]),
      ]),
    ]);
    // find, verify, source-hub, barrier, decision — the join's sink hub
    // contracts into the same-band decision; the open left keeps its source.
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "hub", "barrier", "decision"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1, 1, 1, 1]);
    // source→verify; verify→barrier→decision; find→fan stays implicit cross-band
    expect(fmt(ir.edges)).toEqual(["n2->n1", "n1->n3", "n3->n4"]);
    expect(fmt(ir.loops)).toEqual(["n4->n0:yes"]); // back arc crosses bands 1 → 0
  });

  it("chains a nested inner loop's 'no' exit into the outer decision", () => {
    const { ir } = flatten(mkMeta("P"), [
      loop("P", "outer?", [loop("P", "inner?", [agent("P", "work")])]),
      agent("P", "after"),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "decision", "decision", "agent"]);
    expect(fmt(ir.edges)).toEqual(["n0->n1", "n1->n2:no", "n2->n3:no"]);
    expect(fmt(ir.loops)).toEqual(["n1->n0:yes", "n2->n0:yes"]); // both repeat from the first body node
  });

  it("merges a body-final branch into the decision, bypass labeled (if-false re-tests)", () => {
    const { ir } = flatten(mkMeta("P"), [
      loop("P", "again?", [branch("P", "x", [agent("P", "t")], [])]),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["decision", "agent", "decision"]);
    expect(fmt(ir.edges)).toEqual(["n0->n1:yes", "n1->n2", "n0->n2:no"]);
    expect(fmt(ir.loops)).toEqual(["n2->n0:yes"]);
  });

  it("keeps a decision (entry = exit surface) for an empty body (defensive)", () => {
    const { ir } = flatten(mkMeta("P"), [
      agent("P", "before"),
      loop("P", "spin?", []),
      agent("P", "after"),
    ]);
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "decision", "agent"]);
    expect(fmt(ir.edges)).toEqual(["n0->n1", "n1->n2:no"]);
    expect(ir.loops).toEqual([]); // nothing to loop back to
  });

  it("routes a back arc that points down the page into edges (invariant guard)", () => {
    const { ir } = flatten(mkMeta("P", "Q"), [
      loop("P", "again?", [agent("Q", "late"), agent("P", "early")]),
    ]);
    expect(ir.nodes.map((n) => n.band)).toEqual([1, 0, 0]); // decision banded with the last body node
    expect(fmt(ir.edges)).toEqual(["n1->n2", "n2->n0:yes"]); // the "repeat" arc points downward → edge
    expect(ir.loops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Node & multiplicity mapping
// ---------------------------------------------------------------------------

describe("flattenTopology — node & multiplicity mapping", () => {
  it("maps every step kind and multiplicity exactly (no stray keys)", () => {
    const { ir } = flatten(mkMeta("P"), [
      agent("P", "a", { agentType: "codex", promptPreview: "never carried" }),
      agent("P", "b", { multiplicity: { kind: "exact", count: 3 }, model: "sonnet" }),
      agent("P", "c", {
        multiplicity: { kind: "named", names: ["x", "y"] },
        expandedLabels: ["c:x", "c:y"],
      }),
      agent("P", "d", { multiplicity: { kind: "unknown" } }),
      wf("P", "w", { kind: "exact", count: 2 }),
      opaque("P", "const x = mystery()"),
    ]);
    expect(ir.nodes).toStrictEqual([
      { id: "n0", band: 0, kind: "agent", label: "a" },
      { id: "n1", band: 0, kind: "agent", label: "b", model: "sonnet", mult: { kind: "exact", n: 3 } },
      { id: "n2", band: 0, kind: "agent", label: "c", mult: { kind: "named", names: ["c:x", "c:y"] } },
      { id: "n3", band: 0, kind: "agent", label: "d", mult: { kind: "unknown" } },
      { id: "n4", band: 0, kind: "task", label: "w", mult: { kind: "exact", n: 2 } },
      { id: "n5", band: 0, kind: "task", label: "const x = mystery()" },
    ]);
    expect(fmt(ir.edges)).toEqual(["n0->n1", "n1->n2", "n2->n3", "n3->n4", "n4->n5"]);
  });

  it("is deterministic across runs", () => {
    const steps = [
      agent("P", "a"),
      fanout("P", { kind: "named", names: ["x", "y"] }, [
        agent("P", "f", { multiplicity: { kind: "named", names: ["x", "y"] } }),
      ]),
      loop("Q", "more?", [branch("Q", "c", [agent("Q", "t")], [])]),
      agent("Q", "z"),
    ];
    const one = flatten(mkMeta("P", "Q"), steps);
    const two = flatten(mkMeta("P", "Q"), steps);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });
});

// ---------------------------------------------------------------------------
// Integration: the 8 example workflows, analyzer → flattener
// ---------------------------------------------------------------------------

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");

const flattenExample = (name: string) => {
  const src = readFileSync(join(examplesDir, name), "utf8");
  const program = parseWorkflowSource(src);
  const meta = extractMetaFromProgram(program);
  const topology = analyzeBody(
    program,
    src,
    meta.phases.map((p) => p.title),
  );
  return { meta, ...flattenTopology(topology, meta) };
};

describe("flattener corpus invariants", () => {
  const files = readdirSync(examplesDir).filter((f) => f.endsWith(".js"));

  it("covers all 8 example workflows", () => {
    expect(files).toHaveLength(8);
  });

  it("every example: ids in emission order, bands in range, band titles = meta phases, edge/loop invariants, untaken never set, deterministic", () => {
    for (const f of files) {
      const { meta, ir, bandTitles } = flattenExample(f);
      expect(bandTitles, f).toEqual(meta.phases.map((p) => p.title));
      ir.nodes.forEach((n, i) => expect(n.id, f).toBe(`n${i}`));
      const band = new Map(ir.nodes.map((n) => [n.id, n.band]));
      for (const n of ir.nodes) {
        expect(n.band, f).toBeGreaterThanOrEqual(0);
        expect(n.band, f).toBeLessThan(bandTitles.length);
        expect(n.untaken, f).toBeUndefined();
      }
      for (const e of ir.edges) {
        expect(band.get(e.from)! <= band.get(e.to)!, `${f}: edge ${e.from}->${e.to}`).toBe(true);
        expect(e.untaken, f).toBeUndefined();
      }
      for (const l of ir.loops) {
        expect(band.get(l.from)! >= band.get(l.to)!, `${f}: loop ${l.from}->${l.to}`).toBe(true);
      }
      const again = flattenExample(f);
      expect(JSON.stringify({ ir: again.ir, bandTitles: again.bandTitles }), f).toBe(
        JSON.stringify({ ir, bandTitles }),
      );
    }
  });
});

describe("per-example graphs", () => {
  it("review-pr: slices → review ×3(expanded) ⇒ verify ×?(findings) ⇒ barrier; only the stage chain crosses bands", () => {
    const { ir } = flattenExample("review-pr.js");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "agent", "barrier", "hub", "agent"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1, 2, 2, 2, 3]);
    expect(ir.nodes[1].label).toBe("review:${dim}");
    expect(ir.nodes[1].mult).toEqual({
      kind: "named",
      names: ["review:correctness", "review:security", "review:performance"],
    });
    expect(ir.nodes[2].label).toBe("verify:${f.title}");
    expect(ir.nodes[2].mult).toEqual({ kind: "unknown", hint: "review.findings" });
    // the verify fan-out join + sink (its source hub contracts into the
    // pipeline chain), then the explicit stage chain crossing bands 1 → 2
    expect(fmt(ir.edges)).toEqual(["n2->n3", "n3->n4", "n1->n2"]);
    expect(ir.loops).toEqual([]);
  });

  it("triage-issue: classify, then a decision whose only drawn path is the cross-band 'no' arm", () => {
    const { ir, bandTitles } = flattenExample("triage-issue.js");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "decision", "agent"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1, 2]);
    expect(ir.nodes[1].label).toBe("confidence < 0.5");
    expect(ir.nodes[2].label).toBe("fix:${area}");
    expect(fmt(ir.edges)).toEqual(["n1->n2:no"]); // branch ends the workflow: no bypass, no merge
    expect(ir.loops).toEqual([]);
    // "Reply or escalate" stays a (step-less) band
    expect(bandTitles[3]).toBe("Reply or escalate");
    expect(ir.nodes.some((n) => n.band === 3)).toBe(false);
  });

  it("summarize-codebase: list, fan out ×?(modules), join — and nothing else (cross-band hops stay implicit)", () => {
    const { ir } = flattenExample("summarize-codebase.js");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "hub", "barrier", "hub", "agent"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1, 1, 1, 1, 2]);
    expect(ir.nodes[1].label).toBe("read:${m}");
    expect(ir.nodes[1].mult).toEqual({ kind: "unknown", hint: "modules.modules" });
    // the fan-out's own edges only (both hubs open): source→read, read→barrier, barrier→sink
    expect(fmt(ir.edges)).toEqual(["n2->n1", "n1->n3", "n3->n4"]);
    expect(ir.loops).toEqual([]);
  });

  it("verify-fix: reproduce, patch, refute panel expanded refute:* into the barrier", () => {
    const { ir } = flattenExample("verify-fix.js");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "agent", "hub", "barrier", "hub"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1, 2, 2, 2, 2]);
    expect(ir.nodes[2].mult).toEqual({
      kind: "named",
      names: ["refute:correctness", "refute:security", "refute:regressions"],
    });
    expect(fmt(ir.edges)).toEqual(["n3->n2", "n2->n4", "n4->n5"]); // source→refute, refute→barrier, barrier→sink
    expect(ir.loops).toEqual([]);
  });

  it("name-the-feature: gen fan-out expanded gen:* joins; filter and shortlist stack bandwise", () => {
    const { ir } = flattenExample("name-the-feature.js");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "hub", "barrier", "hub", "agent", "agent"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 0, 0, 0, 1, 2]);
    expect(ir.nodes[0].mult).toEqual({
      kind: "named",
      names: ["gen:literal", "gen:playful", "gen:metaphorical"],
    });
    expect(fmt(ir.edges)).toEqual(["n1->n0", "n0->n2", "n2->n3"]); // source→gen, gen→barrier, barrier→sink
    expect(ir.loops).toEqual([]);
  });

  it("choose-approach: draft ×4, nested while>for tournament (two decisions, two back arcs), write-up on the 'no' exit", () => {
    const { ir } = flattenExample("choose-approach.js");
    expect(ir.nodes.map((n) => n.kind)).toEqual([
      "agent",
      "hub",
      "barrier",
      "hub",
      "agent",
      "decision",
      "decision",
      "agent",
    ]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 0, 0, 0, 1, 1, 1, 3]);
    expect(ir.nodes[0].mult).toEqual({
      kind: "named",
      names: ["draft:simplest", "draft:most scalable", "draft:least risky", "draft:fastest to ship"],
    });
    expect(ir.nodes[4].label).toBe("match:${i / 2}");
    expect(ir.nodes[5].label).toBe("i < bracket.length");
    expect(ir.nodes[6].label).toBe("bracket.length > 1");
    // draft fan (source→draft→barrier→sink) in band 0; match→inner decision;
    // each decision exits "no" to the next, both loop back to match
    expect(fmt(ir.edges)).toEqual(["n1->n0", "n0->n2", "n2->n3", "n4->n5", "n5->n6:no", "n6->n7:no"]);
    expect(fmt(ir.loops)).toEqual(["n5->n4:yes", "n6->n4:yes"]);
  });

  it("hunt-bugs: find → verify fan-out → join → decision, looping back across bands; no exit (the loop ends the workflow)", () => {
    const { ir } = flattenExample("hunt-bugs.js");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "hub", "barrier", "decision"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1, 1, 1, 1]);
    expect(ir.nodes[1].mult).toEqual({ kind: "unknown", hint: "fresh" });
    expect(ir.nodes[4].label.startsWith("dryRounds < 2 &&")).toBe(true);
    expect(ir.nodes[4].label.endsWith("…")).toBe(true); // verbatim, COND_MAX-truncated
    // source→verify, verify→barrier, barrier→decision (the sink hub contracted in)
    expect(fmt(ir.edges)).toEqual(["n2->n1", "n1->n3", "n3->n4"]);
    expect(fmt(ir.loops)).toEqual(["n4->n0:yes"]); // the back arc spans bands 1 → 0
  });

  it("dual-lineage-review: two lanes in their own bands fan into one barrier (claude's fan-in crosses bands)", () => {
    const { ir } = flattenExample("dual-lineage-review.js");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["agent", "agent", "agent", "barrier", "agent"]);
    expect(ir.nodes.map((n) => n.band)).toEqual([0, 1, 2, 2, 3]);
    expect(ir.nodes[1].label).toBe("review:claude");
    expect(ir.nodes[2].label).toBe("review:external");
    expect(fmt(ir.edges)).toEqual(["n1->n3", "n2->n3"]);
    expect(ir.loops).toEqual([]);
  });
});
