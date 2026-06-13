import { describe, expect, it } from "vitest";
import { renderTopologySvg } from "../render-topology.js";
import { renderPhaseCard, renderSvg } from "../render-svg.js";
import { EMPTY_IR } from "../topology-ir.js";
import type {
  NodeKind,
  TopoEdge,
  TopoLoop,
  TopoNode,
  TopologyIR,
} from "../topology-ir.js";
import type { Meta } from "../model.js";
import { MARGIN, W } from "../svg-primitives.js";

const mkMeta = (...titles: string[]): Meta => ({
  name: "wf",
  description: "d",
  phases: titles.map((title) => ({ title })),
});

const node = (
  id: string,
  band: number,
  kind: NodeKind,
  label: string,
  over: Partial<TopoNode> = {},
): TopoNode => ({ id, band, kind, label, ...over });

const ir = (
  nodes: TopoNode[],
  edges: TopoEdge[] = [],
  loops: TopoLoop[] = [],
): TopologyIR => ({ nodes, edges, loops });

const count = (svg: string, needle: string): number =>
  svg.split(needle).length - 1;

// One IR exercising the full vocabulary: fan-out rows + barrier + decision +
// task with ×N + cross-band edges (one untaken) + a gutter loop.
const KITCHEN_META: Meta = {
  name: "kitchen sink",
  description: "exercises every glyph",
  phases: [
    { title: "Plan", detail: "the planning band", model: "haiku" },
    { title: "Fan out", detail: "the busy band", model: "sonnet" },
    { title: "Decide", model: "opus" },
  ],
};
const KITCHEN_TITLES = ["Plan", "Fan out", "Decide"];
const KITCHEN_IR: TopologyIR = ir(
  [
    node("n0", 0, "agent", "scout", { model: "opus" }),
    node("n1", 1, "agent", "work", { mult: { kind: "named", names: ["a", "b", "c"] } }),
    node("n2", 1, "barrier", ""),
    node("n3", 1, "decision", "happy?"),
    node("n4", 2, "agent", "ship it"),
    node("n5", 2, "task", "cleanup", { mult: { kind: "unknown" } }),
    // Stacked column mates for n1 — n7's label wraps to a 2-line right label.
    node("n6", 1, "agent", "probe"),
    node("n7", 1, "agent", "verify all the things"),
  ],
  [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4", label: "yes" },
    { from: "n3", to: "n5", label: "no", untaken: true },
    { from: "n0", to: "n1" },
    { from: "n4", to: "n5" },
    { from: "n6", to: "n2" },
    { from: "n7", to: "n2" },
  ],
  [{ from: "n3", to: "n0", label: "retry" }],
);
const kitchenSvg = (): string =>
  renderTopologySvg(KITCHEN_META, KITCHEN_IR, KITCHEN_TITLES);

describe("renderTopologySvg", () => {
  it("is a well-formed svg with balanced groups", () => {
    const svg = kitchenSvg();
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(count(svg, "<g")).toBe(count(svg, "</g>"));
  });

  it("emits the countable glyph classes the vocabulary promises", () => {
    const svg = kitchenSvg();
    expect(count(svg, 'class="agent-node"')).toBe(5);
    expect(count(svg, 'class="barrier"')).toBe(1);
    expect(count(svg, 'class="decision"')).toBe(1);
    expect(count(svg, 'class="task-node"')).toBe(1);
    expect(count(svg, 'class="loop-path"')).toBe(1);
    expect(count(svg, 'class="xband-edge"')).toBe(3);
    expect(count(svg, 'class="xn-badge"')).toBe(1);
    // 2 arrowed intra edges (n2→n3, n4→n5; fan-ins run flush) + 4 routes.
    expect(count(svg, 'class="arrowhead"')).toBe(6);
    expect(count(svg, 'class="graph-band"')).toBe(3);
    expect(count(svg, 'class="phase-card"')).toBe(0);
  });

  it("colors agent circles by their node model swatch", () => {
    const svg = kitchenSvg();
    // Anchored on the circle radius so a badge rect can't satisfy the check:
    // n0 is opus → violet circle; the others fall back to slate.
    expect(svg).toContain('r="11" fill="#ede9fe" stroke="#8b5cf6"');
    expect(svg).toContain('r="11" fill="#f1f5f9" stroke="#94a3b8"');
  });

  it("renders fan-out hubs as small edge-colored dots, source upstream of sink", () => {
    // An open-both-sides fan-out: source → gen ×3 → barrier → sink, one band.
    const svg = renderTopologySvg(
      mkMeta("Gen"),
      ir(
        [
          node("n0", 0, "agent", "gen", { mult: { kind: "named", names: ["a", "b", "c"] } }),
          node("n1", 0, "hub", ""),
          node("n2", 0, "barrier", ""),
          node("n3", 0, "hub", ""),
        ],
        [
          { from: "n1", to: "n0" },
          { from: "n0", to: "n2" },
          { from: "n2", to: "n3" },
        ],
      ),
      ["Gen"],
    );
    expect(count(svg, 'class="hub"')).toBe(2);
    expect(svg).toContain('class="hub" cx="'); // a real circle, not a stray class
    expect(count(svg, 'r="4.5" fill="#475569"')).toBe(2); // HUB_R + EDGE color
    const hubCxs = [...svg.matchAll(/class="hub" cx="([0-9.]+)"/g)].map((m) => Number(m[1]));
    expect(hubCxs).toHaveLength(2);
    // The source dot (lanes spread from it) sits left of the sink dot (join exit).
    expect(Math.min(...hubCxs)).toBeLessThan(Math.max(...hubCxs));
  });

  it("draws the loop in accent and the untaken edge dashed-muted", () => {
    const svg = kitchenSvg();
    expect(svg).toContain('stroke="#e8694a"'); // loop arc / barrier accent family
    // The dash rides the untaken stroke itself, not some other element.
    expect(svg).toContain('stroke="#cbd5e1" stroke-width="1.3" stroke-dasharray="4 3"');
    // Loop label is italic accent.
    expect(svg).toContain('fill="#e8694a" font-style="italic" text-anchor="middle">retry</text>');
    expect(svg).toContain(">yes</text>");
    expect(svg).toContain(">no</text>");
  });

  it("renders band chrome: numbered chips, titles, model badges, captions", () => {
    const svg = kitchenSvg();
    for (const t of ["Plan", "Fan out", "Decide"]) expect(svg).toContain(`>${t}</text>`);
    expect(svg).toContain(">the planning band</text>");
    expect(svg).toContain("#dbeafe"); // haiku badge
    expect(svg).toContain("#dcfce7"); // sonnet badge
    expect(svg).toContain("#ede9fe"); // opus badge
  });

  it("renders EMPTY_IR byte-identically to the v1 page", () => {
    const meta: Meta = {
      name: "Find flaky tests",
      description: "Detect and fix flaky tests across the suite.",
      whenToUse: "When CI is intermittently red",
      phases: [
        { title: "Scan", detail: "Grep CI logs for retry markers", model: "haiku" },
        { title: "Fix", detail: "Patch and verify", model: "opus" },
      ],
    };
    const titles = meta.phases.map((p) => p.title);
    expect(renderTopologySvg(meta, EMPTY_IR, titles)).toBe(renderSvg(meta));
  });

  it("renders EMPTY_IR byte-identically to v1 for a phase-less meta", () => {
    // metaSchema defaults `phases` to [] — the emptiest input the CLI's
    // fallback path can hand the topology renderer.
    const meta: Meta = { name: "Bare", description: "No phases at all.", phases: [] };
    expect(renderTopologySvg(meta, EMPTY_IR, [])).toBe(renderSvg(meta));
  });

  it("renders a node-less band as a byte-equal v1 phase card", () => {
    const meta: Meta = {
      name: "wf",
      description: "d",
      phases: [
        { title: "Busy" },
        { title: "Idle", detail: "nothing recovered", model: "sonnet" },
      ],
    };
    const svg = renderTopologySvg(
      meta,
      ir([node("n0", 0, "agent", "a")]),
      ["Busy", "Idle"],
    );
    // No gutter content → cards keep the v1 x/w, so the fallback body must be
    // the exact phase-card bytes.
    const card = renderPhaseCard(meta.phases[1], 2, MARGIN, W - 2 * MARGIN);
    expect(svg).toContain(card.body);
    expect(count(svg, 'class="phase-card"')).toBe(1);
    expect(count(svg, 'class="graph-band"')).toBe(1);
  });

  it("truncates the caption and carries the full detail in an escaped <title>", () => {
    const detail =
      'A very long band detail that overflows the caption line: <markup> & "quotes" ' +
      "x".repeat(120);
    const meta: Meta = {
      name: "wf",
      description: "d",
      phases: [{ title: "T", detail }],
    };
    const svg = renderTopologySvg(meta, ir([node("n0", 0, "agent", "a")]), ["T"]);
    expect(svg).toContain("…</text>"); // truncated caption
    expect(svg).not.toContain("<markup>");
    expect(svg).toContain("<title>A very long band detail");
    expect(svg).toContain("&lt;markup&gt; &amp; &quot;quotes&quot;");
  });

  it("escapes hostile node labels, row names, hints, and edge labels everywhere", () => {
    const meta = mkMeta("A", "B");
    const svg = renderTopologySvg(
      meta,
      ir(
        [
          node("n0", 0, "agent", 'lbl <i> & "q"', {
            mult: { kind: "named", names: ['<name>&"'] },
          }),
          node("n1", 0, "agent", "echo", {
            mult: { kind: "unknown", hint: '<hint> & "h"' },
          }),
          node("n2", 1, "task", '<task> & "t"'),
        ],
        [
          { from: "n0", to: "n2", label: '<yes> & "e"' },
          // Same-band, so the intra-edge label path escapes too.
          { from: "n0", to: "n1", label: "<intra>&" },
        ],
      ),
      ["A", "B"],
    );
    for (const raw of ["<i>", "<name>", "<hint>", "<task>", "<yes>", "<intra>"]) {
      expect(svg).not.toContain(raw);
    }
    expect(svg).toContain("&lt;name&gt;&amp;&quot;");
    expect(svg).toContain("&lt;hint&gt; &amp; &quot;h&quot;"); // node <title>
    expect(svg).toContain("&lt;task&gt;");
    expect(svg).toContain("&lt;yes&gt;");
    expect(svg).toContain("&lt;intra&gt;&amp;");
  });

  it("is deterministic", () => {
    expect(kitchenSvg()).toBe(kitchenSvg());
  });

  it("matches the kitchen-sink snapshot", () => {
    expect(kitchenSvg()).toMatchSnapshot();
  });
});
