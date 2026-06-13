import { describe, expect, it } from "vitest";
import {
  BARRIER_OVERHANG,
  CARD_MIN_W,
  COL_GAP,
  EXACT_DRAW_MAX,
  GRAPH_PAD_TOP,
  GUTTER_W_BASE,
  GUTTER_LANE_STEP,
  LANE_H,
  LANE_PAD,
  NODE_R,
  ROW_H,
  estTextW,
  layoutTopology,
  type GraphBand,
  type SceneLabel,
  type SceneNode,
  type TopoScene,
} from "../layout-topology.js";
import { GAP, MARGIN, W } from "../svg-primitives.js";
import { renderPhaseCard } from "../render-svg.js";
import type { Meta } from "../model.js";
import type {
  FlatMultiplicity,
  NodeKind,
  TopoEdge,
  TopoLoop,
  TopoNode,
  TopologyIR,
} from "../topology-ir.js";

// ---------------------------------------------------------------------------
// Builders — hand-built IR literals only (the flattener is upstream).
// ---------------------------------------------------------------------------

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

const edge = (from: string, to: string, over: Partial<TopoEdge> = {}): TopoEdge => ({
  from,
  to,
  ...over,
});

const loop = (from: string, to: string, label?: string): TopoLoop => ({
  from,
  to,
  ...(label !== undefined ? { label } : {}),
});

const ir = (
  nodes: TopoNode[],
  edges: TopoEdge[] = [],
  loops: TopoLoop[] = [],
): TopologyIR => ({ nodes, edges, loops });

const graphBand = (scene: TopoScene, i: number): GraphBand => {
  const band = scene.bands[i];
  if (band.kind !== "graph") throw new Error(`band ${i} is ${band.kind}`);
  return band;
};

const nodeIn = (band: GraphBand, id: string): SceneNode => {
  const n = band.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

// ---------------------------------------------------------------------------
// Columns, midline, chains
// ---------------------------------------------------------------------------

describe("columns & midline", () => {
  it("lays a 3-chain into ascending columns on a shared midline", () => {
    const scene = layoutTopology(
      mkMeta("A"),
      ir(
        [node("n0", 0, "agent", "one"), node("n1", 0, "agent", "two"), node("n2", 0, "agent", "three")],
        [edge("n0", "n1"), edge("n1", "n2")],
      ),
      ["A"],
    );
    const band = graphBand(scene, 0);
    const [a, b, c] = ["n0", "n1", "n2"].map((id) => nodeIn(band, id));
    expect(a.cx).toBeLessThan(b.cx);
    expect(b.cx).toBeLessThan(c.cx);
    expect(b.cx - a.cx).toBeGreaterThanOrEqual(COL_GAP);
    for (const n of [a, b, c]) expect(n.cy).toBe(band.midline);
    expect(band.midline).toBe(band.graphTop + GRAPH_PAD_TOP + ROW_H / 2);
    // Two plain segments, both arrowed.
    expect(band.edges).toHaveLength(2);
    expect(band.edges.every((e) => e.arrow)).toBe(true);
  });

  it("stacks two parallel chain heads in one column, straddling the midline", () => {
    const scene = layoutTopology(
      mkMeta("A"),
      ir(
        [node("n0", 0, "agent", "x"), node("n1", 0, "agent", "y"), node("n2", 0, "barrier", "")],
        [edge("n0", "n2"), edge("n1", "n2")],
      ),
      ["A"],
    );
    const band = graphBand(scene, 0);
    const [x, y] = [nodeIn(band, "n0"), nodeIn(band, "n1")];
    expect(x.cx).toBe(y.cx); // same column...
    expect((x.cy + y.cy) / 2).toBeCloseTo(band.midline); // ...centered on the midline
    expect(nodeIn(band, "n2").cy).toBeCloseTo(band.midline);
  });
});

// ---------------------------------------------------------------------------
// Multiplicity rows & barriers
// ---------------------------------------------------------------------------

describe("multiplicity rows & barriers", () => {
  const fanIR = ir(
    [
      node("src", 0, "agent", "kick"),
      node("fan", 0, "agent", "work", { mult: { kind: "named", names: ["a", "b", "c"] } }),
      node("bar", 0, "barrier", ""),
    ],
    [edge("src", "fan"), edge("fan", "bar")],
  );

  it("draws a named-3 fan-out as rows, per-row diagonals in, horizontals into a spanning barrier", () => {
    const band = graphBand(layoutTopology(mkMeta("A"), fanIR, ["A"]), 0);
    const fan = nodeIn(band, "fan");
    expect(fan.rows).toHaveLength(3);
    expect(fan.rows[1].cy - fan.rows[0].cy).toBe(ROW_H);
    expect(fan.rows.map((r) => r.label?.lines[0])).toStrictEqual(["a", "b", "c"]);
    // Row labels float above the row line.
    expect(fan.rows[0].label!.y).toBeLessThan(fan.rows[0].cy);
    const bar = nodeIn(band, "bar");
    const expectedH =
      fan.rows[2].cy - fan.rows[0].cy + 2 * NODE_R + 2 * BARRIER_OVERHANG;
    expect(bar.h).toBe(expectedH);
    expect(bar.cy).toBeCloseTo((fan.rows[0].cy + fan.rows[2].cy) / 2);
    // 3 fan-out diagonals (arrowed) + 3 fan-in horizontals (flush, no arrow).
    const inEdges = band.edges.filter((e) => e.to === "fan");
    const outEdges = band.edges.filter((e) => e.to === "bar");
    expect(inEdges).toHaveLength(3);
    expect(inEdges.every((e) => e.arrow)).toBe(true);
    expect(outEdges).toHaveLength(3);
    expect(outEdges.every((e) => !e.arrow)).toBe(true);
    expect(new Set(outEdges.map((e) => e.pts[0][1])).size).toBe(3); // one per row
  });

  it("shows named-5 as 3 named rows plus a dashed '+2 more' row", () => {
    const band = graphBand(
      layoutTopology(
        mkMeta("A"),
        ir([
          node("n0", 0, "agent", "gen", {
            mult: { kind: "named", names: ["a", "b", "c", "d", "e"] },
          }),
        ]),
        ["A"],
      ),
      0,
    );
    const n = nodeIn(band, "n0");
    expect(n.rows).toHaveLength(4);
    expect(n.rows[3].dashed).toBe(true);
    expect(n.rows.map((r) => r.label?.lines[0])).toStrictEqual(["a", "b", "c", "+2 more"]);
    expect(n.rows[3].label?.italic).toBe(true);
    expect(n.tooltip).toBe("gen");
  });

  it("draws exact ≤ EXACT_DRAW_MAX as that many circles and exact above it as one ×n echo", () => {
    const band = graphBand(
      layoutTopology(
        mkMeta("A"),
        ir([
          node("n0", 0, "agent", "few", { mult: { kind: "exact", n: EXACT_DRAW_MAX } }),
          node("n1", 0, "agent", "many", { mult: { kind: "exact", n: 9 } }),
          node("n2", 0, "agent", "unknown", {
            mult: { kind: "unknown", hint: "items" } satisfies FlatMultiplicity,
          }),
        ]),
        ["A"],
      ),
      0,
    );
    expect(nodeIn(band, "n0").rows).toHaveLength(EXACT_DRAW_MAX);
    expect(nodeIn(band, "n0").echo).toBeUndefined();
    const many = nodeIn(band, "n1");
    expect(many.rows).toHaveLength(1);
    expect(many.echo).toBe(true);
    expect(many.badge?.text).toBe("×9");
    const unk = nodeIn(band, "n2");
    expect(unk.badge?.text).toBe("×N");
    expect(unk.tooltip).toContain("items"); // the hint survives via tooltip
  });
});

// ---------------------------------------------------------------------------
// Scale-to-fit
// ---------------------------------------------------------------------------

describe("scale-to-fit", () => {
  it("keeps 6 wide task columns inside the card, glyphs non-overlapping", () => {
    const nodes = Array.from({ length: 6 }, (_, i) =>
      node(`n${i}`, 0, "task" as const, `a very long workflow task label ${i}`),
    );
    const edges = Array.from({ length: 5 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
    const scene = layoutTopology(mkMeta("A"), ir(nodes, edges), ["A"]);
    const band = graphBand(scene, 0);
    const placed = band.nodes.map((n) => ({ left: n.cx - n.w / 2, right: n.cx + n.w / 2 }));
    for (const p of placed) {
      expect(p.left).toBeGreaterThanOrEqual(scene.cardX);
      expect(p.right).toBeLessThanOrEqual(scene.cardX + scene.cardW);
    }
    const sorted = [...placed].sort((a, b) => a.left - b.left);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].left).toBeGreaterThanOrEqual(sorted[i - 1].right);
    }
  });
});

// ---------------------------------------------------------------------------
// Gutter & gaps
// ---------------------------------------------------------------------------

describe("gutter & gaps", () => {
  const twoBands = (edges: TopoEdge[], loops: TopoLoop[] = []) =>
    layoutTopology(
      mkMeta("A", "B"),
      ir([node("n0", 0, "agent", "a"), node("n1", 1, "agent", "b")], edges, loops),
      ["A", "B"],
    );

  it("keeps cardX at the v1 margin when nothing routes through a gutter", () => {
    const scene = twoBands([edge("n0", "n1")]);
    expect(scene.gutterLanes).toBe(0);
    expect(scene.cardX).toBe(MARGIN);
    expect(scene.cardW).toBe(W - 2 * MARGIN);
  });

  it("reserves the gutter for a loop and widens it per extra lane", () => {
    const one = twoBands([], [loop("n1", "n0", "again")]);
    expect(one.gutterLanes).toBe(1);
    expect(one.cardX).toBe(MARGIN + GUTTER_W_BASE);
    const two = twoBands([], [loop("n1", "n0"), loop("n1", "n0")]);
    expect(two.cardX).toBe(MARGIN + GUTTER_W_BASE + GUTTER_LANE_STEP);
  });

  it("routes a same-band loop through a local in-card channel, not the gutter", () => {
    const scene = layoutTopology(
      mkMeta("A"),
      ir(
        [node("n0", 0, "agent", "head"), node("n1", 0, "decision", "again?")],
        [edge("n0", "n1")],
        [loop("n1", "n0", "yes")],
      ),
      ["A"],
    );
    // A same-band loop earns NO global gutter — the cards keep the v1 margin.
    expect(scene.gutterLanes).toBe(0);
    expect(scene.cardX).toBe(MARGIN);
    const r = scene.routes.find((rt) => rt.kind === "loop")!;
    expect(r.pts).toHaveLength(6); // drop → local channel → climb → top-approach → target top
    const gx = r.pts[2][0];
    expect(gx).toBeGreaterThan(scene.cardX); // INSIDE the card, not left of it
    expect(gx).toBeLessThan(graphBand(scene, 0).nodes[0].cx); // but left of the leftmost glyph
    // Arrives at the target's TOP (clear of its below-label), arrowhead down.
    // (node.cx is page-coord; node.cy is band-local, so add the band's y.)
    const band0 = graphBand(scene, 0);
    const [tx, ty] = r.pts[5];
    const target = band0.nodes.find((n) => n.id === "n0")!;
    expect(tx).toBeCloseTo(target.cx, 0);
    expect(ty).toBeLessThan(band0.y + target.cy);
  });

  it("counts a band-skipping forward as a gutter route", () => {
    const scene = layoutTopology(
      mkMeta("A", "B", "C"),
      ir([node("n0", 0, "agent", "a"), node("n1", 2, "agent", "b")], [edge("n0", "n1")]),
      ["A", "B", "C"],
    );
    expect(scene.gutterLanes).toBe(1);
    expect(scene.routes[0].pts).toHaveLength(6); // detours via the gutter
    expect(scene.routes[0].pts[2][0]).toBeLessThan(scene.cardX); // gutter x is left of the cards
  });

  it("gives two forwards through one gap distinct lanes and widens the gap", () => {
    const scene = layoutTopology(
      mkMeta("A", "B"),
      ir(
        [
          node("a0", 0, "agent", "p"),
          node("a1", 0, "agent", "q"),
          node("b0", 1, "agent", "r"),
          node("b1", 1, "agent", "s"),
        ],
        [edge("a0", "b0"), edge("a1", "b1")],
      ),
      ["A", "B"],
    );
    const [r0, r1] = scene.routes;
    const laneY0 = r0.pts[1][1];
    const laneY1 = r1.pts[1][1];
    expect(Math.abs(laneY1 - laneY0)).toBe(LANE_H);
    const [b0, b1] = scene.bands;
    expect(b1.y - (b0.y + b0.height)).toBe(2 * LANE_PAD + 2 * LANE_H);
  });

  it("keeps the plain band gap at GAP when nothing crosses it", () => {
    const scene = layoutTopology(
      mkMeta("A", "B"),
      ir([node("n0", 0, "agent", "a"), node("n1", 1, "agent", "b")]),
      ["A", "B"],
    );
    const [b0, b1] = scene.bands;
    expect(b1.y - (b0.y + b0.height)).toBe(GAP);
  });

  it("grows a band's headroom so 3+ top-approaches stay below the chrome", () => {
    const scene = layoutTopology(
      mkMeta("A", "B"),
      ir(
        [
          node("t0", 0, "agent", "a"),
          node("t1", 0, "agent", "b"),
          node("t2", 0, "agent", "c"),
          node("s", 1, "agent", "src"),
        ],
        [],
        [loop("s", "t0"), loop("s", "t1"), loop("s", "t2")],
      ),
      ["A", "B"],
    );
    const band0 = graphBand(scene, 0);
    expect(band0.headroom).toBeGreaterThan(GRAPH_PAD_TOP);
    for (const r of scene.routes) {
      const apprY = r.pts[3][1]; // the gutter → top-approach corner
      expect(apprY).toBeGreaterThanOrEqual(band0.y + band0.graphTop + 2);
    }
  });

  it("clamps the gutter so cards keep a usable width under absurd lane counts", () => {
    const scene = twoBands([], Array.from({ length: 80 }, () => loop("n1", "n0")));
    expect(scene.cardW).toBeGreaterThanOrEqual(CARD_MIN_W);
    for (const r of scene.routes) {
      expect(r.pts[2][0]).toBeGreaterThanOrEqual(8); // lanes floored on-page
    }
  });

  it("fans shared departures and arrivals apart", () => {
    const scene = layoutTopology(
      mkMeta("A", "B"),
      ir(
        [node("n0", 0, "decision", "x?"), node("n1", 1, "agent", "t")],
        [edge("n0", "n1", { label: "yes" }), edge("n0", "n1", { label: "no" })],
      ),
      ["A", "B"],
    );
    const [r0, r1] = scene.routes;
    expect(r0.pts[0][0]).not.toBe(r1.pts[0][0]); // departures offset
    const tip0 = r0.pts[r0.pts.length - 1][0];
    const tip1 = r1.pts[r1.pts.length - 1][0];
    expect(tip0).not.toBe(tip1); // arrivals offset
  });
});

// ---------------------------------------------------------------------------
// Fallback bands & empty input
// ---------------------------------------------------------------------------

describe("fallback bands", () => {
  it("renders a node-less band as a v1 phase card of identical height", () => {
    const meta: Meta = {
      name: "wf",
      description: "d",
      phases: [
        { title: "Busy" },
        { title: "Idle", detail: "nothing recovered here", model: "haiku" },
      ],
    };
    const scene = layoutTopology(meta, ir([node("n0", 0, "agent", "a")]), ["Busy", "Idle"]);
    const band = scene.bands[1];
    expect(band.kind).toBe("fallback");
    if (band.kind !== "fallback") throw new Error("unreachable");
    expect(band.phase).toStrictEqual(meta.phases[1]);
    expect(band.height).toBe(
      renderPhaseCard(meta.phases[1], 2, scene.cardX, scene.cardW).height,
    );
  });

  it("synthesizes a phase for a body-only band title beyond meta.phases", () => {
    const scene = layoutTopology(
      mkMeta("A"),
      ir([node("n0", 0, "agent", "a")]),
      ["A", "Body only"],
    );
    const band = scene.bands[1];
    expect(band.kind).toBe("fallback");
    if (band.kind !== "fallback") throw new Error("unreachable");
    expect(band.phase).toStrictEqual({ title: "Body only" });
  });

  it("turns EMPTY input into all-fallback bands with no routes or gutter", () => {
    const scene = layoutTopology(mkMeta("A", "B"), ir([]), ["A", "B"]);
    expect(scene.bands.every((b) => b.kind === "fallback")).toBe(true);
    expect(scene.routes).toHaveLength(0);
    expect(scene.gutterLanes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Defensive drops
// ---------------------------------------------------------------------------

describe("defensive drops", () => {
  it("drops nodes with out-of-range bands and the edges that touch them", () => {
    const scene = layoutTopology(
      mkMeta("A"),
      ir(
        [node("n0", 0, "agent", "a"), node("n9", 99, "agent", "ghost"), node("nn", -1, "agent", "neg")],
        [edge("n0", "n9"), edge("nn", "n0")],
      ),
      ["A"],
    );
    const band = graphBand(scene, 0);
    expect(band.nodes.map((n) => n.id)).toStrictEqual(["n0"]);
    expect(band.edges).toHaveLength(0);
    expect(scene.routes).toHaveLength(0);
  });

  it("keeps only the first occurrence of a duplicate node id", () => {
    const scene = layoutTopology(
      mkMeta("A", "B"),
      ir([node("dup", 0, "agent", "first"), node("dup", 1, "agent", "second")]),
      ["A", "B"],
    );
    expect(graphBand(scene, 0).nodes.map((n) => n.id)).toStrictEqual(["dup"]);
    expect(scene.bands[1].kind).toBe("fallback"); // the duplicate never lands
  });

  it("drops dangling and self edges", () => {
    const band = graphBand(
      layoutTopology(
        mkMeta("A"),
        ir([node("n0", 0, "agent", "a")], [edge("n0", "missing"), edge("n0", "n0")]),
        ["A"],
      ),
      0,
    );
    expect(band.edges).toHaveLength(0);
  });

  it("drops an intra-band cycle-closing edge but keeps the chain", () => {
    const band = graphBand(
      layoutTopology(
        mkMeta("A"),
        ir(
          [node("n0", 0, "agent", "a"), node("n1", 0, "agent", "b")],
          [edge("n0", "n1"), edge("n1", "n0")],
        ),
        ["A"],
      ),
      0,
    );
    expect(band.edges).toHaveLength(1);
    expect(band.edges[0]).toMatchObject({ from: "n0", to: "n1" });
    expect(nodeIn(band, "n0").cx).toBeLessThan(nodeIn(band, "n1").cx);
  });

  it("drops invariant-violating cross links (backward edge, forward loop)", () => {
    const scene = layoutTopology(
      mkMeta("A", "B"),
      ir(
        [node("n0", 0, "agent", "a"), node("n1", 1, "agent", "b")],
        [edge("n1", "n0")], // edge invariant: band(from) ≤ band(to)
        [loop("n0", "n1")], // loop invariant: band(from) ≥ band(to)
      ),
      ["A", "B"],
    );
    expect(scene.routes).toHaveLength(0);
    expect(scene.gutterLanes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Kitchen sink: pairwise disjointness + determinism
// ---------------------------------------------------------------------------

const KITCHEN_META: Meta = {
  name: "kitchen sink",
  description: "exercises every glyph",
  phases: [
    { title: "Plan", detail: "the planning band", model: "haiku" },
    { title: "Fan out", detail: "the busy band", model: "sonnet" },
    { title: "Decide", model: "opus" },
  ],
};
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
    edge("n1", "n2"),
    edge("n2", "n3"),
    edge("n3", "n4", { label: "yes" }),
    edge("n3", "n5", { label: "no", untaken: true }),
    edge("n0", "n1"),
    edge("n4", "n5"),
    edge("n6", "n2"),
    edge("n7", "n2"),
  ],
  [loop("n3", "n0", "retry")],
);

interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
  what: string;
}

const labelBox = (l: SceneLabel, what: string): BBox => {
  const wMax = Math.max(...l.lines.map((line) => estTextW(line, l.size)));
  const x = l.anchor === "middle" ? l.x - wMax / 2 : l.anchor === "end" ? l.x - wMax : l.x;
  const lineH = l.lineH ?? 12;
  const top = l.y - l.size * 0.8;
  const bottom = l.y + (l.lines.length - 1) * lineH + 3;
  return { x, y: top, w: wMax, h: bottom - top, what };
};

const bandBoxes = (band: GraphBand): BBox[] => {
  const boxes: BBox[] = [];
  for (const n of band.nodes) {
    boxes.push({ x: n.cx - n.w / 2, y: n.cy - n.h / 2, w: n.w, h: n.h, what: `glyph:${n.id}` });
    // A task's label lives INSIDE its rect by design — overlap is the point.
    if (n.label && n.kind !== "task") boxes.push(labelBox(n.label, `label:${n.id}`));
    for (const [j, row] of n.rows.entries()) {
      if (row.label) boxes.push(labelBox(row.label, `row:${n.id}:${j}`));
    }
    if (n.badge) {
      boxes.push({
        x: n.badge.x,
        y: n.badge.y - 9,
        w: estTextW(n.badge.text, 11),
        h: 11,
        what: `badge:${n.id}`,
      });
    }
  }
  return boxes;
};

const overlaps = (a: BBox, b: BBox): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("kitchen sink", () => {
  it("keeps every glyph, label, and badge pairwise disjoint in every band", () => {
    const scene = layoutTopology(KITCHEN_META, KITCHEN_IR, ["Plan", "Fan out", "Decide"]);
    for (const band of scene.bands) {
      if (band.kind !== "graph") continue;
      const boxes = bandBoxes(band);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(
            overlaps(boxes[i], boxes[j]),
            `${boxes[i].what} overlaps ${boxes[j].what} in band ${band.index}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps all geometry inside the page", () => {
    const scene = layoutTopology(KITCHEN_META, KITCHEN_IR, ["Plan", "Fan out", "Decide"]);
    for (const route of scene.routes) {
      for (const [x, y] of route.pts) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(scene.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(scene.height);
      }
    }
    const last = scene.bands[scene.bands.length - 1];
    expect(last.y + last.height).toBeLessThanOrEqual(scene.height);
  });

  it("is deterministic", () => {
    const a = layoutTopology(KITCHEN_META, KITCHEN_IR, ["Plan", "Fan out", "Decide"]);
    const b = layoutTopology(KITCHEN_META, KITCHEN_IR, ["Plan", "Fan out", "Decide"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
