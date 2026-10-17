import { describe, expect, it } from "vitest";
import { statChips, summarizeTopology } from "../stats.js";
import type { Meta } from "../model.js";
import type { AgentStep, Multiplicity, Step, Topology } from "../topology.js";

const span = { start: 0, end: 0 };
const agent = (label: string): AgentStep => ({
  kind: "agent",
  label,
  labelExplicit: true,
  phase: null,
  multiplicity: { kind: "one" },
  span,
});
const topo = (steps: Step[]): Topology => ({
  steps,
  bands: [],
  notes: [],
  hasOrchestration: true,
  requiredLevel: 1,
  recognizerLevel: 1,
});
const meta = (n: number): Meta => ({
  name: "wf",
  description: "d",
  phases: Array.from({ length: n }, (_, i) => ({ title: `P${i}` })),
});

describe("summarizeTopology", () => {
  it("counts agent() call sites once each, wherever they sit", () => {
    const loop: Step = { kind: "loop", loopKind: "while", conditionLabel: "x", body: [agent("a")], phase: null, span };
    const fan: Step = {
      kind: "parallel",
      form: "fanout",
      multiplicity: { kind: "named", names: ["p", "q", "r"] },
      body: [agent("b")],
      phase: null,
      span,
    };
    const stats = summarizeTopology(topo([agent("first"), loop, fan]), meta(2));
    expect(stats).toMatchObject({ phases: 2, agentCalls: 3, loops: 1, fanout: "×3", decisions: 0 });
  });

  it("reports an unknown width as ×N even beside a literal one", () => {
    const fan = (m: Multiplicity): Step => ({
      kind: "parallel",
      form: "fanout",
      multiplicity: m,
      body: [agent("x")],
      phase: null,
      span,
    });
    expect(summarizeTopology(topo([fan({ kind: "exact", count: 4 }), fan({ kind: "unknown" })]), meta(1)).fanout).toBe("×N");
  });
});

describe("statChips", () => {
  it("pluralizes and leaves out zero counts", () => {
    expect(statChips({ phases: 1, agentCalls: 1, loops: 0, decisions: 2, subWorkflows: 0 })).toEqual([
      "1 phase",
      "1 agent() call",
      "2 decisions",
    ]);
  });
});
