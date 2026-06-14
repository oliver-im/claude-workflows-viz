import { describe, expect, it } from "vitest";
import { placeTopology } from "../place-topology.js";
import { renderTopology } from "../render-topology.js";
import type { Meta } from "../model.js";
import type {
  AgentStep,
  BandRef,
  LoopStep,
  Multiplicity,
  ParallelStep,
  Step,
  Topology,
} from "../topology.js";

// ---------------------------------------------------------------------------
// Builders — hand IR → placeTopology → renderTopology (place + render path).
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
const fanout = (m: Multiplicity, body: Step[], phase: string | null): ParallelStep => ({
  kind: "parallel",
  form: "fanout",
  multiplicity: m,
  body,
  phase,
  span,
});
const loop = (conditionLabel: string, body: Step[], phase: string | null): LoopStep => ({
  kind: "loop",
  loopKind: "while",
  conditionLabel,
  body,
  phase,
  span,
});
const band = (title: string): BandRef => ({ title, inMeta: true });
const topo = (steps: Step[], bands: BandRef[]): Topology => ({
  steps,
  bands,
  notes: [],
  hasOrchestration: true,
});
const meta = (phases: Meta["phases"]): Meta => ({ name: "wf", description: "d", phases });

const render = (t: Topology, m: Meta) => renderTopology(placeTopology(t, m), m);

// A tournament-shaped page: named fan-out → a same-lane loop → an empty
// control strip → a final agent. Exercises stripes, members, barrier, the loop
// badge, the empty strip, model tints, and cross-phase connectors.
const tournament = () => {
  const draftBody = agent("draft:${p}", "Draft", {
    multiplicity: { kind: "named", names: ["a", "b", "c"] },
    expandedLabels: ["draft:a", "draft:b", "draft:c"],
    model: "sonnet",
  });
  return render(
    topo(
      [
        fanout({ kind: "named", names: ["a", "b", "c"] }, [draftBody], "Draft"),
        loop("bracket.length > 1", [agent("match", "Judge", { model: "opus" })], "Judge"),
        agent("Document the winner", "Write up", { model: "haiku" }),
      ],
      [band("Draft"), band("Judge"), band("Advance"), band("Write up")],
    ),
    meta([
      { title: "Draft", model: "sonnet" },
      { title: "Judge", model: "opus" },
      { title: "Advance" },
      { title: "Write up", model: "haiku" },
    ]),
  );
};

describe("renderTopology", () => {
  it("produces a well-formed svg with balanced groups and integer dimensions", () => {
    const svg = tournament();
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toMatch(/width="\d+" height="\d+"/);
    const opens = svg.match(/<g\b/g)?.length ?? 0;
    const closes = svg.match(/<\/g>/g)?.length ?? 0;
    expect(opens).toBe(closes);
  });

  it("draws swimlane stripes, agent circles, a coral barrier, and a loop badge — no banded-engine classes", () => {
    const svg = tournament();
    expect(svg).toContain('class="swimlane"');
    expect(svg).toContain('class="agent-node"');
    expect(svg).toContain('class="barrier"');
    expect(svg).toContain('class="loop-badge"');
    expect(svg).toContain("↻ repeat while bracket.length &gt; 1"); // escaped at render
    // The card-as-container engine is gone: none of its classes survive.
    expect(svg).not.toContain("xband");
    expect(svg).not.toContain("gutter");
    expect(svg).not.toContain("graph-band");
    expect(svg).not.toContain("phase-card");
  });

  it("renders a control-only phase as a slim strip, not a numbered card", () => {
    const svg = tournament();
    expect(svg).toContain('class="swimlane-empty"');
    expect(svg).toContain("control only");
  });

  it("tints lanes by model and keeps the header card", () => {
    const svg = tournament();
    expect(svg).toContain('class="header-card"');
    expect(svg).toContain("#dcfce7"); // sonnet stripe
    expect(svg).toContain("#ede9fe"); // opus stripe
    expect(svg).toContain("#dbeafe"); // haiku stripe
  });

  it("shows every fan member (named expansion), each drawn as an agent circle", () => {
    const svg = tournament();
    for (const label of ["draft:a", "draft:b", "draft:c"]) {
      expect(svg).toContain(label);
    }
  });

  it("escapes <, >, &, and \" in every label, leaking no raw payload", () => {
    const title = 'P <b> & "c"';
    const svg = render(topo([agent('do <x> & "y"', title)], [band(title)]), meta([{ title }]));
    expect(svg).toContain("do &lt;x&gt; &amp; &quot;y&quot;");
    expect(svg).toContain("P &lt;b&gt; &amp; &quot;c&quot;");
    expect(svg).not.toContain("<x>");
    expect(svg).not.toContain("<b>");
  });

  it("emits no <marker> (arrowheads are explicit polygons for resvg)", () => {
    const svg = tournament();
    expect(svg).not.toContain("<marker");
    expect(svg).toContain("<polygon"); // arrowheads / diamonds
  });

  it("is deterministic for the same input", () => {
    expect(tournament()).toBe(tournament());
  });

  it("matches the tournament snapshot", () => {
    expect(tournament()).toMatchSnapshot();
  });
});
