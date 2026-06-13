import type { Meta, Phase } from "./model.js";
import type {
  FlatMultiplicity,
  TopoEdge,
  TopoLoop,
  TopoNode,
  TopologyIR,
  NodeKind,
} from "./topology-ir.js";
import {
  GAP,
  MARGIN,
  W,
  truncatePlain,
  truncateToWidth,
  wrapToWidth,
} from "./svg-primitives.js";
import { renderHeader, renderPhaseCard } from "./render-svg.js";

/**
 * Hand-rolled deterministic layout for the banded topology view: pure function
 * of `(meta, TopologyIR, bandTitles)` → a `TopoScene` the renderer draws 1:1.
 * No external layout engine — bands stack vertically like v1 phase cards, and
 * within a band the flat graph is layered into columns by longest path. All
 * positions are computed here; the renderer only turns the scene into SVG
 * elements, so every geometry decision is testable on the scene object.
 *
 * Coordinates: x is always absolute page x (cards never move horizontally
 * within a page). Node/edge y's are BAND-LOCAL (relative to the band card's
 * top); cross-band route points are absolute PAGE coordinates, computed after
 * the bands are stacked.
 *
 * Defensive posture: the IR is internally produced, but the layout still
 * drops — silently and deterministically — anything it cannot place: nodes
 * with out-of-range bands, edges/loops with dangling endpoints or
 * invariant-violating band directions, and intra-band cycle-closing edges.
 * Dropping (not throwing) keeps the render total; the flattener's tests are
 * the honesty gate for the IR itself.
 */

// ---------------------------------------------------------------------------
// Tunable constants — the whole visual dialect in one block. A restyle is a
// constant swap, not logic surgery.
// ---------------------------------------------------------------------------

/** Gutter width reserved left of the cards when one route runs through it. */
export const GUTTER_W_BASE = 34;
/** Extra gutter width per additional gutter lane. */
export const GUTTER_LANE_STEP = 9;
/** Innermost gutter lane sits this far left of the card edge. */
export const GUTTER_LANE_INSET = 20;
/** Cards never get narrower than this — the gutter clamps instead. */
export const CARD_MIN_W = 360;

export const GRAPH_PAD_X = 18;
export const GRAPH_PAD_TOP = 14;
export const GRAPH_PAD_BOTTOM = 14;
/** Height of the one-line caption under a graph band's title row. */
export const CAPTION_H = 17;

export const NODE_R = 11;
/** Fan-out source / join-exit junction dot. */
export const HUB_R = 4.5;
/** Vertical rhythm: one multiplicity row per ROW_H. */
export const ROW_H = 34;
export const DIAMOND_HALF = 14;
export const BARRIER_W = 6;
/** The barrier bar extends this far past its outermost fan-in rows. */
export const BARRIER_OVERHANG = 8;
export const TASK_H = 26;
export const TASK_PAD_X = 9;
export const TASK_MAX_W = 150;
export const TASK_MIN_W = 40;

export const COL_GAP = 34;
export const LABEL_BELOW_MAX_W = 88;
export const LABEL_RIGHT_MAX_W = 104;
/** Named multiplicities show up to this many rows (else 3 + "+n more"). */
export const NAMED_SHOW_MAX = 4;
/** Exact multiplicities draw one circle per run up to this count (else ×n). */
export const EXACT_DRAW_MAX = 4;

/** Cross-band horizontal runs claim lanes of this height in the band gaps. */
export const LANE_H = 11;
export const LANE_PAD = 6;
/** Corner radius for routed elbows (gutter arcs, gap jogs). */
export const ELBOW_R = 10;

// Graph-band chrome mirrors the v1 phase card (renderPhaseCard's locals) so
// graph bands read as the same card family. Keep in sync by eye, not import —
// v1's values are frozen by the byte-identity snapshot.
export const CHROME_PAD_TOP = 16;
export const CHROME_PAD_X = 18;
export const CHIP_R = 13;
export const CHROME_H = CHROME_PAD_TOP + 2 * CHIP_R;

// Font sizes (px).
export const F_CAPTION = 11.5;
export const F_LABEL = 10.5;
export const F_ROW = 10;
export const F_EDGE = 9.5;
export const F_BADGE = 11;
export const F_LOOP = 10;
/** Line height for wrapped below-labels. */
export const LABEL_LINE_H = 12;

/** Gap between a glyph's right edge and its right-hand label. */
const RIGHT_LABEL_GAP = 6;
/** Echo circles (×n / ×N) draw a second circle offset by this much. */
const ECHO_OFFSET = 3;
/** Arrivals into the same node fan out horizontally by this step. */
const ARRIVAL_X_STEP = 8;
/** Stacked top-approach runs inside a band's headroom are this far apart. */
const APPROACH_Y_STEP = 7;

/**
 * Rough text width estimate (the inverse of `fitChars`): deliberately
 * conservative so footprints reserve at least the drawn width.
 */
export function estTextW(s: string, size: number): number {
  return s.length * size * 0.58;
}

// ---------------------------------------------------------------------------
// Scene types — everything the renderer needs, fully positioned. Strings are
// final display text (already truncated/wrapped) but RAW: escaping stays in
// the renderer.
// ---------------------------------------------------------------------------

export interface SceneLabel {
  /** Anchor x; y is the FIRST line's baseline. Band-local for node/edge labels, page coords for route labels. */
  x: number;
  y: number;
  lines: string[];
  size: number;
  anchor: "start" | "middle" | "end";
  tone: "label" | "muted" | "accent";
  italic?: boolean;
  /** Baseline step between lines (defaults to LABEL_LINE_H). */
  lineH?: number;
}

export interface SceneRow {
  /** Band-local row center. Circles share the node's cx. */
  cy: number;
  /** The "+n more" overflow row draws dashed. */
  dashed?: boolean;
  label?: SceneLabel;
}

export interface SceneNode {
  id: string;
  kind: NodeKind;
  band: number;
  /** Glyph-cluster center; cy is band-local. */
  cx: number;
  cy: number;
  /** Glyph bbox (labels excluded; barrier h includes its overhang). */
  w: number;
  h: number;
  model?: string;
  /** Multiplicity rows (agents); single-row for everything else. */
  rows: SceneRow[];
  /** Draw a second offset circle behind (the ×n / ×N stack hint). */
  echo?: boolean;
  /** The ×n / ×N marker. */
  badge?: { x: number; y: number; text: string };
  label?: SceneLabel;
  /** Full text behind a truncated label/caption — renderer emits as <title>. */
  tooltip?: string;
}

/** Intra-band edge: one straight segment, band-local coords. */
export interface SceneEdge {
  from: string;
  to: string;
  pts: readonly [readonly [number, number], readonly [number, number]];
  /** False for fan-in segments that run flush into a barrier bar. */
  arrow: boolean;
  label?: SceneLabel;
  untaken?: boolean;
}

/** Cross-band edge or loop, routed in PAGE coords (drawn in the overlay). */
export interface SceneRoute {
  kind: "edge" | "loop";
  /** Axis-aligned polyline for roundedElbowPath; last point is the arrow tip. */
  pts: ReadonlyArray<readonly [number, number]>;
  label?: SceneLabel;
  untaken?: boolean;
}

export interface GraphBand {
  kind: "graph";
  index: number;
  title: string;
  y: number;
  height: number;
  /** Bottom of chrome+caption — the graph area starts here (band-local). */
  graphTop: number;
  /** Reserved space under graphTop for incoming top-approach runs. */
  headroom: number;
  /** The flow midline rows center on (band-local). */
  midline: number;
  /** Truncated one-line caption (phase detail); absent without detail. */
  caption?: string;
  /** Full detail when a caption exists — renderer emits as <title>. */
  tooltip?: string;
  model?: string;
  nodes: SceneNode[];
  edges: SceneEdge[];
}

export interface FallbackBand {
  kind: "fallback";
  index: number;
  title: string;
  y: number;
  height: number;
  /** Fed verbatim to v1's renderPhaseCard — byte-equal degradation. */
  phase: Phase;
}

export type SceneBand = GraphBand | FallbackBand;

export interface TopoScene {
  width: number;
  height: number;
  cardX: number;
  cardW: number;
  gutterLanes: number;
  headerH: number;
  bands: SceneBand[];
  routes: SceneRoute[];
}

// ---------------------------------------------------------------------------
// IR sanitation
// ---------------------------------------------------------------------------

interface CleanIR {
  nodes: TopoNode[];
  byId: Map<string, TopoNode>;
  intraByBand: Map<number, TopoEdge[]>;
  cross: TopoEdge[];
  loops: TopoLoop[];
}

function sanitize(ir: TopologyIR, bandCount: number): CleanIR {
  const inRange = ir.nodes.filter(
    (n) => Number.isInteger(n.band) && n.band >= 0 && n.band < bandCount,
  );
  const byId = new Map<string, TopoNode>();
  for (const n of inRange) if (!byId.has(n.id)) byId.set(n.id, n);
  // First occurrence wins on a duplicate id (the flattener never emits one);
  // later duplicates are dropped like any other unplaceable input.
  const nodes = [...byId.values()];

  const intraByBand = new Map<number, TopoEdge[]>();
  const cross: TopoEdge[] = [];
  for (const e of ir.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to || from === to) continue;
    if (from.band > to.band) continue; // violates the frozen IR invariant
    if (from.band === to.band) {
      const list = intraByBand.get(from.band) ?? [];
      list.push(e);
      intraByBand.set(from.band, list);
    } else {
      cross.push(e);
    }
  }
  const loops = ir.loops.filter((l) => {
    const from = byId.get(l.from);
    const to = byId.get(l.to);
    return !!from && !!to && from.band >= to.band;
  });
  return { nodes, byId, intraByBand, cross, loops };
}

/**
 * Drop intra-band cycle-closing edges via DFS (nodes visited in IR order,
 * out-edges followed in IR order) — a gray-node hit marks the closing edge.
 * Deterministic by construction; the surviving edge set is a DAG.
 */
function dropCycleEdges(nodeIds: string[], edges: TopoEdge[]): TopoEdge[] {
  const out = new Map<string, TopoEdge[]>();
  for (const id of nodeIds) out.set(id, []);
  for (const e of edges) out.get(e.from)?.push(e);
  const dropped = new Set<TopoEdge>();
  const state = new Map<string, "gray" | "done">();
  const visit = (id: string): void => {
    state.set(id, "gray");
    for (const e of out.get(id) ?? []) {
      const s = state.get(e.to);
      if (s === "gray") dropped.add(e);
      else if (s === undefined) visit(e.to);
    }
    state.set(id, "done");
  };
  for (const id of nodeIds) if (!state.has(id)) visit(id);
  return edges.filter((e) => !dropped.has(e));
}

/** Longest-path column per node over the (acyclic) intra-band edge set. */
function layerColumns(nodeIds: string[], edges: TopoEdge[]): Map<string, number> {
  const col = new Map<string, number>();
  for (const id of nodeIds) col.set(id, 0);
  // Relaxation converges in ≤ V passes on a DAG; the cap is defensive.
  for (let pass = 0; pass < nodeIds.length + 1; pass++) {
    let changed = false;
    for (const e of edges) {
      const want = (col.get(e.from) ?? 0) + 1;
      if (want > (col.get(e.to) ?? 0)) {
        col.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return col;
}

// ---------------------------------------------------------------------------
// Multiplicity → row display
// ---------------------------------------------------------------------------

interface MultDisplay {
  rows: number;
  /** Per-row right labels (named multiplicities). */
  rowNames?: string[];
  /** Trailing dashed "+n more" row label (named > NAMED_SHOW_MAX). */
  moreRow?: string;
  echo: boolean;
  badge?: string;
  /** Exact ≤ EXACT_DRAW_MAX: the node label is shared across the rows. */
  sharedLabel: boolean;
}

function multDisplay(mult: FlatMultiplicity | undefined): MultDisplay {
  if (!mult) return { rows: 1, echo: false, sharedLabel: false };
  switch (mult.kind) {
    case "exact":
      if (mult.n >= 1 && mult.n <= EXACT_DRAW_MAX) {
        return { rows: mult.n, echo: false, sharedLabel: true };
      }
      return { rows: 1, echo: true, badge: `×${mult.n}`, sharedLabel: false };
    case "named": {
      const names = mult.names;
      if (names.length === 0) {
        // Degenerate (the flattener never emits it) — honest ×0 echo.
        return { rows: 1, echo: true, badge: "×0", sharedLabel: false };
      }
      if (names.length <= NAMED_SHOW_MAX) {
        return { rows: names.length, rowNames: [...names], echo: false, sharedLabel: false };
      }
      return {
        rows: NAMED_SHOW_MAX,
        rowNames: names.slice(0, NAMED_SHOW_MAX - 1),
        moreRow: `+${names.length - (NAMED_SHOW_MAX - 1)} more`,
        echo: false,
        sharedLabel: false,
      };
    }
    case "unknown":
      return { rows: 1, echo: true, badge: "×N", sharedLabel: false };
  }
}

// ---------------------------------------------------------------------------
// Per-band layout
// ---------------------------------------------------------------------------

interface NodeSpec {
  node: TopoNode;
  disp: MultDisplay;
  glyphW: number;
  glyphH: number;
  /** Vertical allocation when stacking nodes in a column. */
  stackH: number;
  labelPos: "below" | "right" | "inside" | "none";
  col: number;
}

function glyphDims(node: TopoNode, disp: MultDisplay): { w: number; h: number } {
  switch (node.kind) {
    case "hub":
      return { w: 2 * HUB_R, h: 2 * HUB_R };
    case "barrier":
      return { w: BARRIER_W, h: 2 * NODE_R + 2 * BARRIER_OVERHANG };
    case "decision":
      return { w: 2 * DIAMOND_HALF, h: 2 * DIAMOND_HALF };
    case "task": {
      const label = truncatePlain(node.label, 28);
      const w = Math.max(
        TASK_MIN_W,
        Math.min(TASK_MAX_W, estTextW(label, F_LABEL) + 2 * TASK_PAD_X),
      );
      return { w, h: TASK_H };
    }
    case "agent": {
      const extra = disp.echo ? ECHO_OFFSET : 0;
      return {
        w: 2 * NODE_R + extra,
        h: (disp.rows - 1) * ROW_H + 2 * NODE_R + extra,
      };
    }
  }
}

function badgeTextFor(mult: FlatMultiplicity | undefined): string | undefined {
  if (!mult) return undefined;
  if (mult.kind === "exact") return `×${mult.n}`;
  if (mult.kind === "named") return `×${mult.names.length}`;
  return "×N";
}

function layoutBand(
  index: number,
  title: string,
  phase: Phase | undefined,
  bandNodes: TopoNode[],
  intraEdges: TopoEdge[],
  departs: ReadonlySet<string>,
  approachCount: number,
  cardX: number,
  cardW: number,
): GraphBand {
  const ids = bandNodes.map((n) => n.id);
  const kept = dropCycleEdges(ids, intraEdges);
  const col = layerColumns(ids, kept);

  // Column membership (IR order within each column), with sparse column
  // indices (possible after defensive drops) compressed to dense ones.
  const usedCols = [...new Set(bandNodes.map((n) => col.get(n.id) ?? 0))].sort(
    (a, b) => a - b,
  );
  const dense = new Map(usedCols.map((c, i) => [c, i]));
  const columns: TopoNode[][] = usedCols.map(() => []);
  const specs = new Map<string, NodeSpec>();
  for (const node of bandNodes) {
    const c = dense.get(col.get(node.id) ?? 0) ?? 0;
    columns[c].push(node);
    const disp = node.kind === "agent" ? multDisplay(node.mult) : multDisplay(undefined);
    const { w, h } = glyphDims(node, disp);
    specs.set(node.id, {
      node,
      disp,
      glyphW: w,
      glyphH: h,
      stackH: node.kind === "agent" ? disp.rows * ROW_H : ROW_H,
      labelPos: "none", // resolved below, once solo-ness is known
      col: c,
    });
  }

  // Label placement: below for a solo single-row column (the classic chain
  // look), right for stacks, shared-row labels, decisions (whose yes/no edge
  // labels would collide with a below-label), and any cross-band departure
  // source (a below-label would sit under the departing drop). A single-row
  // glyph's right label sits as one block above its midline, clear of the
  // edge passing at cy; a stack's two-line right label instead straddles the
  // midline, slotting between row lines 34px apart. Tasks label inside their
  // rect; barriers draw bare; named rows label per-row, floating just above
  // each row's line.
  for (const node of bandNodes) {
    const spec = specs.get(node.id)!;
    if (node.kind === "barrier" || node.label === "") spec.labelPos = "none";
    else if (node.kind === "task") spec.labelPos = "inside";
    else if (spec.disp.rowNames) spec.labelPos = "none";
    else if (node.kind === "decision") spec.labelPos = "right";
    else if (spec.disp.sharedLabel && spec.disp.rows > 1) spec.labelPos = "right";
    else {
      const solo = columns[spec.col].length === 1;
      spec.labelPos = solo && !departs.has(node.id) ? "below" : "right";
    }
  }

  // Column footprints (glyph + reserved label width), then x placement with
  // proportional scale-to-fit. Scaling shrinks positions and label caps, not
  // glyph sizes — glyphs may then eat into the side paddings, which is why
  // GRAPH_PAD_X exceeds NODE_R.
  const footprint = (spec: NodeSpec): number => {
    const badge = spec.disp.badge ?? badgeTextFor(spec.node.kind === "task" ? spec.node.mult : undefined);
    const badgeW = badge ? 3 + estTextW(badge, F_BADGE) : 0;
    switch (spec.labelPos) {
      case "inside":
        return spec.glyphW + badgeW;
      case "none": {
        const rowW = spec.disp.rowNames
          ? Math.max(
              ...[...spec.disp.rowNames, ...(spec.disp.moreRow ? [spec.disp.moreRow] : [])].map(
                (n) => Math.min(estTextW(n, F_ROW), LABEL_RIGHT_MAX_W),
              ),
            )
          : 0;
        return spec.glyphW + (rowW > 0 ? RIGHT_LABEL_GAP + rowW : 0) + badgeW;
      }
      case "right": {
        const est = Math.min(estTextW(spec.node.label, F_LABEL), LABEL_RIGHT_MAX_W);
        return spec.glyphW + RIGHT_LABEL_GAP + Math.max(est, badgeW);
      }
      case "below": {
        const est = Math.min(estTextW(spec.node.label, F_LABEL), LABEL_BELOW_MAX_W);
        return Math.max(spec.glyphW + badgeW, est);
      }
    }
  };
  const colFp = columns.map((nodes) => Math.max(...nodes.map((n) => footprint(specs.get(n.id)!))));
  const avail = cardW - 2 * GRAPH_PAD_X;
  const totalW = colFp.reduce((a, b) => a + b, 0) + (columns.length - 1) * COL_GAP;
  const s = totalW > avail ? avail / totalW : 1;
  if (s < 1) {
    // Fixed-size glyphs (circles, diamonds, bars) ride out the squeeze, but a
    // task rect is label-sized — shrink it with its column or neighboring
    // rects overlap. Its label re-truncates to the new width below.
    //
    // Accepted degradation: glyph minimum sizes (circles, TASK_MIN_W) don't
    // scale, so a band squeezed far enough (~17+ columns in one band — far
    // beyond any real workflow body) can overlap glyphs or point a segment
    // backwards. Positions stay on-card either way; readable glyphs at sane
    // densities beat strict disjointness at absurd ones.
    for (const spec of specs.values()) {
      if (spec.node.kind === "task") {
        spec.glyphW = Math.max(TASK_MIN_W, spec.glyphW * s);
      }
    }
  }

  const colLeft: number[] = [];
  const colCenter: number[] = [];
  let cursor = cardX + GRAPH_PAD_X;
  for (const fp of colFp) {
    colLeft.push(cursor);
    colCenter.push(cursor + (fp * s) / 2);
    cursor += fp * s + COL_GAP * s;
  }

  // Vertical extents around the flow midline.
  const labelLinesOf = new Map<string, string[]>();
  let above = ROW_H / 2;
  let below = ROW_H / 2;
  columns.forEach((nodes, c) => {
    const stack = nodes.reduce((a, n) => a + specs.get(n.id)!.stackH, 0);
    above = Math.max(above, stack / 2);
    let extra = 0;
    for (const n of nodes) {
      const spec = specs.get(n.id)!;
      if (spec.labelPos === "right") {
        // Reserve the headroom a two-line right label's top line needs
        // (measured from the node's own center — a best-effort reservation
        // for stacked columns): single-row glyphs hold the whole block above
        // their midline, stacks only the straddle's upper line.
        const cap = Math.max(24, LABEL_RIGHT_MAX_W * s);
        if (wrapToWidth(n.label, cap, F_LABEL, 2).length > 1) {
          above = Math.max(above, spec.stackH === ROW_H ? 31 : 23);
        }
        continue;
      }
      if (spec.labelPos !== "below") continue;
      const cap = Math.max(24, Math.min(LABEL_BELOW_MAX_W * s, colFp[c] * s));
      const lines = wrapToWidth(n.label, cap, F_LABEL, 2);
      labelLinesOf.set(n.id, lines);
      extra = Math.max(extra, 4 + lines.length * LABEL_LINE_H);
    }
    below = Math.max(below, stack / 2 + extra);
  });

  const detail = phase?.detail?.trim();
  const caption = detail
    ? truncateToWidth(detail, cardW - 2 * CHROME_PAD_X, F_CAPTION)
    : undefined;
  const graphTop = CHROME_H + (caption ? CAPTION_H : 0);
  // Headroom hosts the top-approach runs of incoming gutter routes; two fit
  // inside GRAPH_PAD_TOP, more grow it so no run climbs into the chrome.
  const headroom = Math.max(GRAPH_PAD_TOP, 7 + (approachCount - 1) * APPROACH_Y_STEP);
  const midline = graphTop + headroom + above;
  const height = midline + below + GRAPH_PAD_BOTTOM;

  // Place nodes: each column's stack centered on the midline.
  const sceneById = new Map<string, SceneNode>();
  const sceneNodes: SceneNode[] = [];
  columns.forEach((nodes, c) => {
    const stack = nodes.reduce((a, n) => a + specs.get(n.id)!.stackH, 0);
    let top = midline - stack / 2;
    for (const n of nodes) {
      const spec = specs.get(n.id)!;
      const cy = top + spec.stackH / 2;
      top += spec.stackH;
      const cx =
        spec.labelPos === "right" || spec.disp.rowNames
          ? colLeft[c] + spec.glyphW / 2
          : colCenter[c];
      const rows: SceneRow[] = [];
      if (n.kind === "agent") {
        const rowTop = cy - spec.stackH / 2;
        for (let j = 0; j < spec.disp.rows; j++) {
          rows.push({ cy: rowTop + ROW_H / 2 + j * ROW_H });
        }
      }
      const scene: SceneNode = {
        id: n.id,
        kind: n.kind,
        band: index,
        cx,
        cy,
        w: spec.glyphW,
        h: spec.glyphH,
        rows,
        ...(n.model !== undefined ? { model: n.model } : {}),
        ...(spec.disp.echo ? { echo: true } : {}),
      };
      sceneNodes.push(scene);
      sceneById.set(n.id, scene);
    }
  });

  // Barrier bars span their intra-band fan-in rows ± overhang.
  for (const scene of sceneNodes) {
    if (scene.kind !== "barrier") continue;
    const sourceYs: number[] = [];
    for (const e of kept) {
      if (e.to !== scene.id) continue;
      const src = sceneById.get(e.from);
      if (!src) continue;
      if (src.rows.length > 0) for (const r of src.rows) sourceYs.push(r.cy);
      else sourceYs.push(src.cy);
    }
    if (sourceYs.length > 0) {
      const topY = Math.min(...sourceYs) - NODE_R - BARRIER_OVERHANG;
      const botY = Math.max(...sourceYs) + NODE_R + BARRIER_OVERHANG;
      scene.cy = (topY + botY) / 2;
      scene.h = botY - topY;
    }
  }

  // Labels, badges, tooltips.
  const cardRight = cardX + cardW;
  for (const n of bandNodes) {
    const spec = specs.get(n.id)!;
    const scene = sceneById.get(n.id)!;
    const tooltip: string[] = [];
    const rightX = scene.cx + spec.glyphW / 2 + RIGHT_LABEL_GAP;
    // The 24px floor can overrule the card-edge clamp by a few px at absurd
    // densities — a sliver of label over the card border beats losing the
    // label, and the page margin keeps it on-page.
    const rightCap = Math.max(24, Math.min(LABEL_RIGHT_MAX_W * s, cardRight - rightX - 4));

    if (spec.disp.rowNames) {
      const all = [...spec.disp.rowNames, ...(spec.disp.moreRow ? [spec.disp.moreRow] : [])];
      scene.rows.forEach((row, j) => {
        const name = all[j];
        if (name === undefined) return;
        const isMore = spec.disp.moreRow !== undefined && j === all.length - 1;
        if (isMore) row.dashed = true;
        row.label = {
          // Floats just above the row's line, so fan-in/fan-out segments
          // never strike through the text.
          x: rightX,
          y: row.cy - 6,
          lines: [truncateToWidth(name, rightCap, F_ROW)],
          size: F_ROW,
          anchor: "start",
          tone: isMore ? "muted" : "label",
          ...(isMore ? { italic: true } : {}),
        };
      });
      tooltip.push(n.label);
    } else if (spec.labelPos === "right") {
      // A single-row glyph (decision, lone circle) reads its label as one
      // tight block above its midline, clear of the edge passing at cy. A
      // stack's two lines instead straddle the midline — they slot between
      // row lines 34px apart, where a block above would strike the top row.
      const lines = wrapToWidth(n.label, rightCap, F_LABEL, 2);
      const solo = spec.stackH === ROW_H;
      scene.label = {
        x: rightX,
        y: solo
          ? scene.cy - 7 - (lines.length - 1) * LABEL_LINE_H
          : lines.length > 1
            ? scene.cy - 14
            : scene.cy - 7,
        lines,
        size: F_LABEL,
        anchor: "start",
        tone: "label",
        ...(!solo && lines.length > 1 ? { lineH: 26 } : {}),
      };
      if (lines.join(" ") !== n.label) tooltip.push(n.label);
    } else if (spec.labelPos === "below") {
      const lines = labelLinesOf.get(n.id) ?? [n.label];
      scene.label = {
        x: scene.cx,
        y: scene.cy + spec.glyphH / 2 + LABEL_LINE_H,
        lines,
        size: F_LABEL,
        anchor: "middle",
        tone: "label",
      };
      if (lines.join(" ") !== n.label) tooltip.push(n.label);
    } else if (spec.labelPos === "inside") {
      const inner = truncateToWidth(n.label, spec.glyphW - 2 * TASK_PAD_X, F_LABEL);
      scene.label = {
        x: scene.cx,
        y: scene.cy + 3.5,
        lines: [inner],
        size: F_LABEL,
        anchor: "middle",
        tone: "label",
      };
      if (inner !== n.label) tooltip.push(n.label);
    }

    const badgeText =
      spec.disp.badge ?? (n.kind === "task" ? badgeTextFor(n.mult) : undefined);
    if (badgeText) {
      scene.badge = {
        x: scene.cx + spec.glyphW / 2 + 3,
        y: scene.cy - spec.glyphH / 2 + 4,
        text: badgeText,
      };
    }
    if (n.mult?.kind === "unknown" && n.mult.hint) tooltip.push(`×N — ${n.mult.hint}`);
    if (tooltip.length > 0) scene.tooltip = tooltip.join(" — ");
  }

  // Intra-band edges → straight segments.
  const sceneEdges: SceneEdge[] = [];
  for (const e of kept) {
    const src = sceneById.get(e.from)!;
    const dst = sceneById.get(e.to)!;
    // Edge labels hug the line's origin: below it for horizontal/descending
    // segments, above for ascending ones — so two labeled exits from one
    // decision never share a spot. (The source's own right-hand label sits
    // above its midline, leaving the origin clear.)
    const label = (sy: number, ty: number): SceneLabel | undefined =>
      e.label
        ? {
            x: src.cx + src.w / 2 + 4,
            y: ty < sy ? sy - 7 : sy + 12,
            lines: [truncatePlain(e.label, 14)],
            size: F_EDGE,
            anchor: "start" as const,
            tone: "muted" as const,
          }
        : undefined;
    const base = { from: e.from, to: e.to, ...(e.untaken ? { untaken: true } : {}) };
    if (src.rows.length > 1 && dst.kind === "barrier") {
      // Fan-in: per-row horizontals flush into the bar (no arrowheads).
      for (const row of src.rows) {
        sceneEdges.push({
          ...base,
          pts: [
            [src.cx + src.w / 2, row.cy],
            [dst.cx - BARRIER_W / 2, row.cy],
          ],
          arrow: false,
        });
      }
    } else if (dst.rows.length > 1) {
      // Fan-out: per-row diagonals from the source's right anchor.
      const sx = src.cx + src.w / 2;
      for (const row of dst.rows) {
        sceneEdges.push({
          ...base,
          pts: [
            [sx, src.cy],
            [dst.cx - dst.w / 2 - 1, row.cy],
          ],
          arrow: true,
          ...(e.label && row === dst.rows[0] ? { label: label(src.cy, row.cy) } : {}),
        });
      }
    } else {
      const flush = dst.kind === "barrier";
      const sx = src.cx + src.w / 2;
      const tx = dst.cx - dst.w / 2 - (flush ? 0 : 1);
      // Into a barrier the segment stays horizontal at the source's own row —
      // the bar spans its sources; aiming at bar-center would cut diagonals
      // through neighboring labels.
      const ty = flush
        ? Math.max(dst.cy - dst.h / 2 + 2, Math.min(src.cy, dst.cy + dst.h / 2 - 2))
        : dst.cy;
      sceneEdges.push({
        ...base,
        pts: [
          [sx, src.cy],
          [tx, ty],
        ],
        arrow: !flush,
        ...(e.label ? { label: label(src.cy, ty) } : {}),
      });
    }
  }

  return {
    kind: "graph",
    index,
    title,
    y: 0,
    height,
    graphTop,
    headroom,
    midline,
    ...(caption !== undefined ? { caption } : {}),
    ...(detail !== undefined && caption !== undefined ? { tooltip: detail } : {}),
    ...(phase?.model !== undefined ? { model: phase.model } : {}),
    nodes: sceneNodes,
    edges: sceneEdges,
  };
}

// ---------------------------------------------------------------------------
// Page assembly + cross-band routing
// ---------------------------------------------------------------------------

interface RouteIntent {
  kind: "edge" | "loop";
  from: TopoNode;
  to: TopoNode;
  label?: string;
  untaken?: boolean;
  /** Lane index in the gap below the source band. */
  gapLane: number;
  /** Gutter lane (loops and band-skipping forwards only). */
  gutterLane?: number;
  /** Top-approach slot inside the target band's headroom (gutter routes). */
  approach?: number;
  /** Arrival slot at the target node (fans tips apart when shared). */
  arrival: number;
  arrivalCount: number;
  /** Departure slot at the source node (fans drops apart when shared). */
  departure: number;
  departureCount: number;
}

export function layoutTopology(
  meta: Meta,
  ir: TopologyIR,
  bandTitles: readonly string[],
): TopoScene {
  const clean = sanitize(ir, bandTitles.length);

  // The gutter exists iff something must travel alongside the cards: every
  // loop, plus forward edges that skip at least one band. Each gets its own
  // vertical lane.
  const gutterRoutes =
    clean.cross.filter((e) => bandOf(clean, e.to) - bandOf(clean, e.from) >= 2).length +
    clean.loops.length;
  // Clamped so cards keep a usable width no matter how many routes pile up;
  // past the clamp, lanes share the outermost x (degenerate, far beyond any
  // real workflow body).
  const gutterW =
    gutterRoutes > 0
      ? Math.min(
          GUTTER_W_BASE + (gutterRoutes - 1) * GUTTER_LANE_STEP,
          W - 2 * MARGIN - CARD_MIN_W,
        )
      : 0;
  const cardX = MARGIN + gutterW;
  const cardW = W - MARGIN - cardX;
  const headerH = renderHeader(meta, cardX, cardW).height;

  const departs = new Set<string>([
    ...clean.cross.map((e) => e.from),
    ...clean.loops.map((l) => l.from),
  ]);

  // Route bookkeeping in one deterministic order: cross edges (IR order),
  // then loops (IR order). Each route claims a horizontal lane in the gap
  // below its source band; gutter routes also claim a gutter lane and a
  // top-approach slot in the target band's headroom. Runs BEFORE band layout
  // so each band can size its headroom to the approaches it will receive.
  const gapLanes = new Map<number, number>();
  const approaches = new Map<number, number>();
  const arrivals = new Map<string, number>();
  const departures = new Map<string, number>();
  let nextGutterLane = 0;
  const intents: RouteIntent[] = [];
  const queue: Array<{ kind: "edge" | "loop"; from: string; to: string; label?: string; untaken?: boolean }> = [
    ...clean.cross.map((e) => ({ kind: "edge" as const, from: e.from, to: e.to, label: e.label, untaken: e.untaken })),
    ...clean.loops.map((l) => ({ kind: "loop" as const, from: l.from, to: l.to, label: l.label })),
  ];
  for (const q of queue) {
    const from = clean.byId.get(q.from)!;
    const to = clean.byId.get(q.to)!;
    const gapLane = gapLanes.get(from.band) ?? 0;
    gapLanes.set(from.band, gapLane + 1);
    const viaGutter = q.kind === "loop" || to.band - from.band >= 2;
    let gutterLane: number | undefined;
    let approach: number | undefined;
    if (viaGutter) {
      gutterLane = nextGutterLane++;
      approach = approaches.get(to.band) ?? 0;
      approaches.set(to.band, approach + 1);
    }
    const arrival = arrivals.get(q.to) ?? 0;
    arrivals.set(q.to, arrival + 1);
    const departure = departures.get(q.from) ?? 0;
    departures.set(q.from, departure + 1);
    intents.push({
      kind: q.kind,
      from,
      to,
      ...(q.label !== undefined ? { label: q.label } : {}),
      ...(q.untaken ? { untaken: true } : {}),
      gapLane,
      ...(gutterLane !== undefined ? { gutterLane } : {}),
      ...(approach !== undefined ? { approach } : {}),
      arrival,
      arrivalCount: 0, // filled below once totals are known
      departure,
      departureCount: 0,
    });
  }
  for (const intent of intents) {
    intent.arrivalCount = arrivals.get(intent.to.id) ?? 1;
    intent.departureCount = departures.get(intent.from.id) ?? 1;
  }

  // Per-band layout (graph or v1 fallback), y resolved after stacking.
  const bands: SceneBand[] = bandTitles.map((title, b) => {
    const bandNodes = clean.nodes.filter((n) => n.band === b);
    const phase = b < meta.phases.length ? meta.phases[b] : undefined;
    if (bandNodes.length === 0) {
      const fallbackPhase = phase ?? { title };
      return {
        kind: "fallback",
        index: b,
        title,
        y: 0,
        height: renderPhaseCard(fallbackPhase, b + 1, cardX, cardW).height,
        phase: fallbackPhase,
      } satisfies FallbackBand;
    }
    return layoutBand(
      b,
      title,
      phase,
      bandNodes,
      clean.intraByBand.get(b) ?? [],
      departs,
      approaches.get(b) ?? 0,
      cardX,
      cardW,
    );
  });

  // Stack the bands. A gap with lanes widens to fit them; the page's bottom
  // margin does the same when routes depart below the last band.
  let y = MARGIN + headerH + GAP;
  bands.forEach((band, b) => {
    band.y = y;
    const lanes = gapLanes.get(b) ?? 0;
    const gapAfter = Math.max(GAP, lanes > 0 ? 2 * LANE_PAD + lanes * LANE_H : 0);
    y += band.height + gapAfter;
  });
  let height: number;
  if (bands.length === 0) {
    height = MARGIN + headerH + MARGIN;
  } else {
    const last = bands[bands.length - 1];
    const lastLanes = gapLanes.get(bands.length - 1) ?? 0;
    height =
      last.y +
      last.height +
      Math.max(MARGIN, lastLanes > 0 ? 2 * LANE_PAD + lastLanes * LANE_H : 0);
  }

  // Resolve routes to page-coordinate polylines. Both shapes share the same
  // skeleton: drop from the source's glyph bottom into the gap lane, then
  // either jog straight to the target (adjacent forwards) or detour through a
  // gutter lane to a top-approach run inside the target band's headroom
  // (loops and band-skipping forwards). The top-approach run crosses earlier
  // columns' headroom — the one accepted imperfection of this vocabulary: a
  // tall earlier column could graze it (the corpus never does). The same
  // acceptance covers arrivals/departures at a node that is NOT the top of a
  // stacked column: the vertical run would cross the glyphs stacked above it.
  // Flattener-produced IRs never do this either — entries/exits are always
  // their column's first-emitted (topmost) node.
  const sceneNodeById = new Map<string, { node: SceneNode; band: GraphBand }>();
  for (const band of bands) {
    if (band.kind !== "graph") continue;
    for (const node of band.nodes) sceneNodeById.set(node.id, { node, band });
  }
  const routes: SceneRoute[] = [];
  for (const intent of intents) {
    const src = sceneNodeById.get(intent.from.id);
    const dst = sceneNodeById.get(intent.to.id);
    if (!src || !dst) continue; // unreachable: sanitized nodes always place
    const sx =
      src.node.cx +
      (intent.departureCount > 1
        ? (intent.departure - (intent.departureCount - 1) / 2) * ARRIVAL_X_STEP
        : 0);
    const sy = src.band.y + src.node.cy + src.node.h / 2;
    const laneY =
      src.band.y + src.band.height + LANE_PAD + intent.gapLane * LANE_H + LANE_H / 2;
    const tx =
      dst.node.cx +
      (intent.arrivalCount > 1
        ? (intent.arrival - (intent.arrivalCount - 1) / 2) * ARRIVAL_X_STEP
        : 0);
    const ty = dst.band.y + dst.node.cy - dst.node.h / 2 - 1;
    let pts: ReadonlyArray<readonly [number, number]>;
    if (intent.gutterLane === undefined) {
      pts = [
        [sx, sy],
        [sx, laneY],
        [tx, laneY],
        [tx, ty],
      ];
    } else {
      // Lane x floored on-page; past the gutter-width clamp, lanes coincide.
      const gx = Math.max(
        8,
        cardX - GUTTER_LANE_INSET - intent.gutterLane * GUTTER_LANE_STEP,
      );
      const apprY =
        dst.band.y +
        dst.band.graphTop +
        dst.band.headroom -
        5 -
        (intent.approach ?? 0) * APPROACH_Y_STEP;
      pts = [
        [sx, sy],
        [sx, laneY],
        [gx, laneY],
        [gx, apprY],
        [tx, apprY],
        [tx, ty],
      ];
    }
    let label: SceneLabel | undefined;
    if (intent.label !== undefined && intent.kind === "loop") {
      const gx = pts[2][0];
      label = {
        x: (sx + gx) / 2,
        y: laneY - 4,
        lines: [truncatePlain(intent.label, 18)],
        size: F_LOOP,
        anchor: "middle",
        tone: "accent",
        italic: true,
      };
    } else if (intent.label !== undefined) {
      // Left of the drop, so sibling departures fanning right never strike
      // it; stacked by departure slot so sibling labels never share a y.
      label = {
        x: sx - 5,
        y: sy + 11 + intent.departure * 10,
        lines: [truncatePlain(intent.label, 14)],
        size: F_EDGE,
        anchor: "end",
        tone: "muted",
      };
    }
    routes.push({
      kind: intent.kind,
      pts,
      ...(label !== undefined ? { label } : {}),
      ...(intent.untaken ? { untaken: true } : {}),
    });
  }

  return {
    width: W,
    height,
    cardX,
    cardW,
    gutterLanes: gutterRoutes,
    headerH,
    bands,
    routes,
  };
}

function bandOf(clean: CleanIR, id: string): number {
  return clean.byId.get(id)?.band ?? 0;
}


