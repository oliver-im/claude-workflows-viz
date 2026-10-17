import { describe, expect, it } from "vitest";
import { placeTopology } from "../place-topology.js";
import { renderTopology, renderTopologyGraph } from "../render-topology.js";
import { summarizeTopology } from "../stats.js";
import { DARK, LIGHT } from "../theme.js";
import type { Meta } from "../model.js";
import type {
  AgentStep,
  BandRef,
  BranchStep,
  ControlStep,
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
  labelExplicit: true, // default: an authored label (pass { labelExplicit: false } for derived)
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
const control = (
  label: string,
  phase: string | null,
  flow: ControlStep["flow"],
): ControlStep => ({
  kind: "control",
  label,
  flow,
  phase,
  span,
});
const branch = (
  conditionLabel: string,
  thenSteps: Step[],
  elseSteps: Step[],
  phase: string | null,
): BranchStep => ({ kind: "branch", conditionLabel, thenSteps, elseSteps, phase, span });
const band = (title: string): BandRef => ({ title, inMeta: true });
const topo = (steps: Step[], bands: BandRef[]): Topology => ({
  steps,
  bands,
  notes: [],
  hasOrchestration: true,
  requiredLevel: 1,
  recognizerLevel: 1,
});
const meta = (phases: Meta["phases"]): Meta => ({ name: "wf", description: "d", phases });

const render = (t: Topology, m: Meta) => renderTopology(placeTopology(t, m), m);
const renderGraph = (t: Topology, m: Meta) => renderTopologyGraph(placeTopology(t, m, { derivedLabels: true }));

// A tournament-shaped page: named fan-out → a same-lane loop → an empty
// control strip → a final agent. Exercises rows, member cards, the join, the
// loop frame, the empty strip, model colors, and cross-phase connectors.
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
        // Unauthored finisher (label sliced from the prompt) — its text is dropped.
        agent("Document the winner", "Write up", { model: "haiku", labelExplicit: false }),
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
  it("draws label cells, rows, agent cards, a join bar, and a loop frame with its condition", () => {
    const svg = tournament();
    expect(svg).toContain('class="lane-label"');
    expect(svg).toContain('class="swimlane"');
    expect(svg).toContain('class="agent-node"');
    expect(svg).toContain('class="barrier"');
    expect(svg).toContain('class="loop-frame"');
    expect(svg).toContain(">while<");
    expect(svg).toContain(">bracket.length &gt; 1<"); // verbatim, escaped at render
    // The loop glyph is a drawn path, never a font-dependent ↻ character.
    expect(svg).not.toContain("↻");
    // The card-as-container engine is gone: none of its classes survive.
    expect(svg).not.toContain("xband");
    expect(svg).not.toContain("gutter");
    expect(svg).not.toContain("graph-band");
    // The in-graph chrome (per-stripe chip/title/badge) is gone — the labels
    // live in the left cells now, and the graph is translated into its column.
    expect(svg).not.toContain("lane-chrome");
    expect(svg).toMatch(/<g class="topology" transform="translate\(\d/);
  });

  it("renders a control-only phase as a slim strip, not a numbered card", () => {
    const svg = tournament();
    expect(svg).toContain('class="swimlane-empty"');
    expect(svg).toContain("control only");
  });

  it("wraps the phases in one rounded white card with hairline separators", () => {
    const svg = tournament();
    expect(svg).toContain('class="header-card"');
    // Two white rounded cards now: the header above and the table below it.
    const cards = svg.match(/rx="12"[^>]*fill="#ffffff"[^>]*stroke="#e2e8f0"/g) ?? [];
    expect(cards.length).toBeGreaterThanOrEqual(2);
    // Phases are divided by hairlines, not tinted rows.
    expect(svg).toMatch(/<line [^>]*stroke="#e2e8f0"/);
    // The model swatches still appear — on the badges and agent circles.
    expect(svg).toContain("#dcfce7"); // sonnet swatch (badge / node)
    expect(svg).toContain("#ede9fe"); // opus swatch
    expect(svg).toContain("#dbeafe"); // haiku swatch
  });

  it("names a jump no arc can carry in a pill, and gives the loop frame a tooltip", () => {
    const svg = render(
      topo([loop("again", [agent("find", "Find"), control("continue loop", "Find", "continue")], "Find")], [
        band("Find"),
      ]),
      meta([{ title: "Find", model: "sonnet" }]),
    );
    expect(svg).toContain('class="control-node"');
    expect(svg).toContain(">continue<"); // the JS keyword, verbatim
    expect(svg).toContain("<title>while again</title>");
  });

  it("frames a guard-headed loop around the guard and the work node; continue loops back to the gate", () => {
    // `for (…) { if (!opponent) continue; match(…) }` — the body head is a
    // control guard, so its continue returns to the guard itself: a self-loop arc
    // on the gate, inside the frame that encloses both the gate and the work.
    const t = topo(
      [
        loop(
          "bracket.length > 1",
          [branch("!opponent", [control("continue loop", "Judge", "continue")], [], "Judge"), agent("match", "Judge")],
          "Judge",
        ),
      ],
      [band("Judge")],
    );
    const m = meta([{ title: "Judge" }]);
    const layout = placeTopology(t, m);
    const decision = layout.nodes.find((n) => n.kind === "decision");
    const match = layout.nodes.find((n) => n.label === "match");
    const [frame] = layout.frames;
    for (const n of [decision!, match!]) {
      expect(n.y).toBeGreaterThan(frame.y0);
      expect(n.y).toBeLessThan(frame.y1);
    }
    expect(layout.controlArcs[0]).toMatchObject({ flow: "continue", fromId: decision?.id, toId: decision?.id });
    const svg = renderTopology(layout, m);
    // The continue is a loop-back arc on the gate — not a "continue loop" box.
    expect(svg).toContain('class="control-arc"');
    expect(svg).not.toContain('class="control-node"');
  });

  it("sets a decision-headed loop's header above the diamond, clear of its yes/no arms", () => {
    // `while (…) { if (cond) A else B }` — a real two-armed branch is the whole
    // body; the frame's header band sits above the diamond, and both arms inside.
    const t = topo(
      [loop("n > 0", [branch("cond", [agent("A", "Judge")], [agent("B", "Judge")], "Judge")], "Judge")],
      [band("Judge")],
    );
    const m = meta([{ title: "Judge" }]);
    const layout = placeTopology(t, m);
    const decision = layout.nodes.find((n) => n.kind === "decision");
    expect(decision).toBeDefined();
    const [frame] = layout.frames;
    expect(frame.entry).toBe(decision?.id);
    expect(frame.y0 + 19).toBeLessThan(decision!.y - 10); // header baseline above the diamond
    for (const label of ["A", "B"]) {
      const arm = layout.nodes.find((n) => n.label === label);
      expect(arm!.y).toBeLessThan(frame.y1);
      expect(arm!.x).toBeLessThan(frame.x1);
    }
    const svg = renderTopology(layout, m);
    expect(svg).toContain('class="loop-frame"');
  });

  it("drops a derived node label but keeps authored ones (phase row names the node)", () => {
    const svg = tournament();
    // Authored labels survive: the fan-out members and the loop's match node.
    expect(svg).toContain("draft:a");
    expect(svg).toContain(">match<");
    // The unauthored finisher (labelExplicit:false) renders as a bare node.
    expect(svg).not.toContain("Document the winner");
  });

  it("shows derived node labels in the graph-only topology view", () => {
    const svg = renderGraph(
      topo([agent("Document the winner", "Write up", { model: "haiku", labelExplicit: false })], [
        band("Write up"),
      ]),
      meta([{ title: "Write up", model: "haiku" }]),
    );
    expect(svg).toContain('class="topology"');
    expect(svg).not.toContain('class="lane-label"');
    expect(svg).not.toContain('class="header-card"');
    expect(svg).toContain("Document the winner");
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

  it("never trims the phase explanation: hard-wraps a long token, no ellipsis, full detail in a <title>", () => {
    const longToken = "a".repeat(120); // unbreakable, far wider than the column
    const detail = `prefix ${longToken} suffix`;
    const svg = render(topo([agent("go", "Solo")], [band("Solo")]), meta([{ title: "Solo", detail }]));
    // The only source of "…" is truncation — so its absence proves nothing was clipped.
    expect(svg).not.toContain("…");
    // The token hard-wrapped across ≥2 full detail lines instead of one truncated line.
    expect((svg.match(/>a{40,}</g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Safety net: the full, untruncated explanation rides along as the cell's <title>.
    expect(svg).toContain(`<title>${detail}</title>`);
  });
});

describe("renderTopology — the redesign's guarantees", () => {
  const twoPhase = (over: Partial<AgentStep> = {}) =>
    topo([agent("review:x", "Review", over)], [band("Review")]);
  const declared = meta([{ title: "Review", model: "sonnet" }]);

  it("marks a phase model that no agent() call sets as declared only", () => {
    expect(render(twoPhase(), declared)).toContain("· declared only");
    // An agent that sets the declared model (by family) backs the declaration.
    expect(render(twoPhase({ model: "claude-sonnet-5" }), declared)).not.toContain("declared only");
    // A custom agentType may pin its own model, so it isn't accused.
    expect(render(twoPhase({ agentType: "codex" }), declared)).not.toContain("declared only");
  });

  it("puts the model on the card: the family name, a custom agent type, or the inherited session model", () => {
    expect(render(twoPhase({ model: "claude-opus-5", effort: "high" }), declared)).toContain(">opus · high<");
    expect(render(twoPhase({ agentType: "codex" }), declared)).toContain(">codex agent<");
    expect(render(topo([agent("x", "Review", { labelExplicit: false })], [band("Review")]), declared)).toContain(
      ">session model<",
    );
  });

  it("claims no model it couldn't read: 'model unread' on the card, and no 'declared only' accusation", () => {
    const svg = render(twoPhase({ unread: ["model"] }), declared);
    expect(svg).toContain(">model unread<");
    expect(svg).not.toContain(">session model<");
    expect(svg).not.toContain("declared only");
    // An unread effort says so too, beside a model that was read.
    expect(render(twoPhase({ model: "sonnet", unread: ["effort"] }), declared)).toContain(">sonnet · effort unread<");
  });

  it("legend lists exactly the glyphs the diagram uses", () => {
    const plain = render(twoPhase({ model: "sonnet" }), declared);
    expect(plain).toContain('class="legend"');
    expect(plain).toContain(">sonnet<");
    expect(plain).not.toContain(">join<");
    expect(plain).not.toContain(">loop<");
    const svg = tournament();
    expect(svg).toContain(">join<");
    expect(svg).toContain(">loop<");
    expect(svg).toContain(">workflow starts<"); // the tournament opens with a fan-out
  });

  it("starts a workflow that opens with a fan-out at a visible start node", () => {
    expect(tournament()).toContain('class="start"');
    expect(render(twoPhase(), declared)).not.toContain('class="start"');
  });

  it("header carries the counts strip read off the body, call sites not spawned agents", () => {
    const t = topo(
      [
        fanout({ kind: "unknown", hint: "items" }, [agent("x:${i}", "Review")], "Review"),
        agent("sum", "Review"),
      ],
      [band("Review")],
    );
    const m = meta([{ title: "Review" }]);
    const svg = renderTopology(placeTopology(t, m), m, { stats: summarizeTopology(t, m) });
    expect(svg).toContain(">1 phase<");
    expect(svg).toContain(">2 agent() calls<");
    expect(svg).toContain(">fan-out ×N<");
  });

  it("is accessible: role=img with the workflow's name and description", () => {
    const svg = tournament();
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title>wf</title>");
    expect(svg).toContain("<desc>d</desc>");
  });

  it("themes every surface: the dark palette replaces the light one", () => {
    const t = twoPhase({ model: "sonnet" });
    const light = renderTopology(placeTopology(t, declared), declared, { theme: LIGHT });
    const dark = renderTopology(placeTopology(t, declared), declared, { theme: DARK });
    expect(light).toContain(`fill="${LIGHT.page}"`);
    expect(dark).toContain(`fill="${DARK.page}"`);
    expect(dark).not.toContain(`fill="${LIGHT.page}"`);
    expect(dark).not.toContain(`fill="${LIGHT.card}"`);
  });

  it("sets verbatim source in mono and prose in sans", () => {
    const svg = render(twoPhase({ model: "sonnet" }), declared);
    expect(svg).toMatch(/<text [^>]*font-family="Menlo[^"]*"[^>]*>review:x</);
    expect(svg).toMatch(/<svg [^>]*font-family="Helvetica, Arial/);
  });
});
