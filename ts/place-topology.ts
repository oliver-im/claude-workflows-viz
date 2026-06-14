import { W } from "./svg-primitives.js";
import type { Meta } from "./model.js";
import type {
  AgentStep,
  Multiplicity,
  Step,
  Topology,
} from "./topology.js";
import type { GEdge, GEdgeKind, GLane, GLoop, GNode, Layout } from "./topo-geometry.js";

/**
 * The focused swimlane placement: an analyzer `Topology` tree (+ `Meta` for
 * phase models) → a positioned `Layout`. ONE graph laid out as a whole, flowed
 * top→down; phases become painted lane stripes derived from where each shape's
 * nodes land — not containers the flow has to break out of. Because the hard
 * parts of general DAG layout exist to solve generality, and workflows are
 * phase-ordered + small + a known sub-shape vocabulary, placement is driven by
 * phase order + per-shape templates (Unit 03) — no cycle-break, ranking, or
 * crossing-minimisation, and zero new deps.
 *
 * Total function by contract: it never throws on a weird-but-valid tree — an
 * unhandled shape degrades to an honest "task" placeholder node, and a body
 * with no phases still gets one lane. Determinism: nodes/edges/loops are
 * emitted in tree order; ids are a stable counter.
 */
export function placeTopology(topology: Topology, meta: Meta): Layout {
  const lanes = buildLanes(topology, meta);
  const titleToLane = new Map(lanes.map((l) => [l.title, l.phaseIndex]));
  const laneOf = (phase: string | null): number =>
    phase !== null && titleToLane.has(phase) ? (titleToLane.get(phase) as number) : 0;

  const ctx: Ctx = { nodes: [], edges: [], loops: [], idSeq: 0, laneOf };

  // Flow top-level steps top→down. Empty bands between consecutive shapes (and
  // trailing) collapse to slim strips the graph simply flows past. Because the
  // body calls phase() in order, top-level step bands are non-decreasing, so a
  // band strictly between the last-covered band and the next shape's band is
  // genuinely empty — no later shape can reach back up to fill it.
  let y = LANE_HEADER_H + LANE_PAD;
  let prevExits: string[] = [];
  let prevBand = -1;
  for (const step of topology.steps) {
    const band = laneOf(step.phase);
    for (let idx = prevBand + 1; idx < band; idx++) y = stripLane(lanes[idx], y);
    const placed = placeStep(step, ctx, y);
    for (const exit of prevExits) connect(ctx, exit, placed.entry, "seq");
    y = placed.bottom + STACK_GAP;
    prevExits = placed.exits;
    prevBand = Math.max(prevBand, placed.maxBand);
  }
  for (let idx = prevBand + 1; idx < lanes.length; idx++) y = stripLane(lanes[idx], y);

  deriveLaneRanges(lanes, ctx.nodes);
  const height = pageHeight(lanes, ctx.nodes);
  return { width: W, height, lanes, nodes: ctx.nodes, edges: ctx.edges, loops: ctx.loops };
}

// ---------------------------------------------------------------------------
// Geometry constants — single place. A restyle is a constant swap here, never
// logic surgery; tests key off these names rather than literals.
// ---------------------------------------------------------------------------

/** The vertical centerline the graph flows down (left-of-center leaves room
 *  for node labels set to the right). */
export const SPINE_X = Math.round(W * 0.4);
/** Agent circle radius. */
export const NODE_R = 13;
/** Tiny fork/merge dot radius. */
export const HUB_R = 3.5;
/** Decision diamond half-diagonal. */
export const DIAMOND_HALF = 11;
/** Coral barrier bar width. */
export const BARRIER_W = 30;
/** Task/opaque box height and minimum width. */
export const TASK_H = 30;
export const TASK_MIN_W = 96;
/** Chrome row (chip + title + model chip) reserved at the top of each lane. */
export const LANE_HEADER_H = 26;
/** Padding between a lane's node bbox and its painted stripe edge. */
export const LANE_PAD = 12;
/** Vertical gap between stacked top-level shapes. */
export const STACK_GAP = 38;
/** Slim height of an empty / control-only phase strip. */
export const STRIP_H = 30;

// ---------------------------------------------------------------------------
// Placement context + node/edge helpers
// ---------------------------------------------------------------------------

interface Ctx {
  nodes: GNode[];
  edges: GEdge[];
  loops: GLoop[];
  idSeq: number;
  laneOf: (phase: string | null) => number;
}

/**
 * A placed sub-graph's connection surface: the node an incoming sequential edge
 * attaches to (`entry`), the node(s) an outgoing one leaves from (`exits`), the
 * vertical extent it occupies, and the lane span its nodes cover.
 */
interface Placed {
  entry: string;
  exits: string[];
  top: number;
  bottom: number;
  minBand: number;
  maxBand: number;
}

function addNode(ctx: Ctx, node: Omit<GNode, "id">): GNode {
  const placed: GNode = { id: `n${ctx.idSeq++}`, ...node };
  ctx.nodes.push(placed);
  return placed;
}

function byId(ctx: Ctx, id: string): GNode {
  const n = ctx.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`place-topology: no node ${id}`);
  return n;
}

/** Half the drawn height of a node — the distance from center to top/bottom
 *  anchor an edge clips to. */
function halfHeight(n: GNode): number {
  switch (n.kind) {
    case "task":
    case "barrier":
      return (n.h ?? 2 * n.r) / 2;
    case "decision":
      return DIAMOND_HALF;
    default:
      return n.r;
  }
}

/** A downward sequential connector from one node's bottom anchor to another's
 *  top anchor (a straight vertical when they share x, a short diagonal else). */
function connect(ctx: Ctx, fromId: string, toId: string, kind: GEdgeKind): void {
  const a = byId(ctx, fromId);
  const b = byId(ctx, toId);
  ctx.edges.push({
    from: fromId,
    to: toId,
    points: [
      { x: a.x, y: a.y + halfHeight(a) },
      { x: b.x, y: b.y - halfHeight(b) },
    ],
    kind,
  });
}

// ---------------------------------------------------------------------------
// Per-step placement. Unit 02 handles the leaf shapes (agent / workflow /
// opaque) and degrades every structured shape to an honest placeholder; Unit 03
// fills in fan-out / pipeline / branch / loop templates.
// ---------------------------------------------------------------------------

function placeStep(step: Step, ctx: Ctx, topY: number): Placed {
  switch (step.kind) {
    case "agent":
      return placeAgent(step, ctx, topY);
    case "workflow":
    case "opaque":
      return placeTask(step.label, ctx, topY, ctx.laneOf(step.phase));
    default:
      // Structured shape, not yet templated: an honest blob in its own lane.
      return placeTask(`[${step.kind}]`, ctx, topY, ctx.laneOf(step.phase));
  }
}

function placeAgent(step: AgentStep, ctx: Ctx, topY: number): Placed {
  const band = ctx.laneOf(step.phase);
  const cy = topY + NODE_R;
  const mult = multBadge(step.multiplicity);
  const n = addNode(ctx, {
    kind: "agent",
    x: SPINE_X,
    y: cy,
    r: NODE_R,
    label: step.label,
    phase: band,
    ...(step.model !== undefined ? { model: step.model } : {}),
    ...(mult !== undefined ? { mult } : {}),
  });
  return { entry: n.id, exits: [n.id], top: cy - NODE_R, bottom: cy + NODE_R, minBand: band, maxBand: band };
}

function placeTask(label: string, ctx: Ctx, topY: number, band: number): Placed {
  const cy = topY + TASK_H / 2;
  const w = Math.min(W - 2 * LANE_PAD, Math.max(TASK_MIN_W, Math.round(label.length * 7) + 24));
  const n = addNode(ctx, {
    kind: "task",
    x: SPINE_X,
    y: cy,
    r: TASK_H / 2,
    w,
    h: TASK_H,
    label,
    phase: band,
  });
  return { entry: n.id, exits: [n.id], top: cy - TASK_H / 2, bottom: cy + TASK_H / 2, minBand: band, maxBand: band };
}

/** Literal-only multiplicity → badge text; `one` and bare unknown collapse to
 *  no badge / "×N" respectively. Honesty: counts appear only when literal. */
function multBadge(m: Multiplicity): string | undefined {
  switch (m.kind) {
    case "one":
      return undefined;
    case "exact":
      return `×${m.count}`;
    case "named":
      return `×${m.names.length}`;
    case "unknown":
      return "×N";
  }
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/**
 * Lanes in band order — meta phases first, then body-only phases by first
 * appearance — which is exactly `topology.bands`. Model (for tint + chip) comes
 * from the matching meta phase; body-only bands carry none. A body with no
 * bands at all still gets one untitled lane so placement has somewhere to land.
 */
function buildLanes(topology: Topology, meta: Meta): GLane[] {
  const modelByTitle = new Map(
    meta.phases.filter((p) => p.model?.trim()).map((p) => [p.title, p.model as string]),
  );
  const lanes: GLane[] = topology.bands.map((b, i) => ({
    phaseIndex: i,
    title: b.title,
    ...(b.inMeta && modelByTitle.has(b.title) ? { model: modelByTitle.get(b.title) } : {}),
    yTop: 0,
    yBot: 0,
    empty: true,
  }));
  if (lanes.length === 0) {
    lanes.push({ phaseIndex: 0, title: "", yTop: 0, yBot: 0, empty: false });
  }
  return lanes;
}

/** Mark a lane as a slim strip at the current cursor; returns the advanced cursor. */
function stripLane(lane: GLane, y: number): number {
  lane.yTop = y;
  lane.yBot = y + STRIP_H;
  lane.empty = true;
  return y + STRIP_H + STACK_GAP;
}

/** Content lanes (those a node landed in) get a stripe = node bbox + padding,
 *  with header room reserved above for the chrome row. Strip lanes keep the
 *  range `stripLane` already gave them. */
function deriveLaneRanges(lanes: GLane[], nodes: GNode[]): void {
  for (const lane of lanes) {
    const own = nodes.filter((n) => n.phase === lane.phaseIndex);
    if (own.length === 0) continue;
    const top = Math.min(...own.map((n) => n.y - halfHeight(n)));
    const bot = Math.max(...own.map((n) => n.y + halfHeight(n)));
    lane.yTop = Math.max(0, top - LANE_HEADER_H);
    lane.yBot = bot + LANE_PAD;
    lane.empty = false;
  }
}

function pageHeight(lanes: GLane[], nodes: GNode[]): number {
  const laneBot = lanes.reduce((m, l) => Math.max(m, l.yBot), 0);
  const nodeBot = nodes.reduce((m, n) => Math.max(m, n.y + halfHeight(n)), 0);
  return Math.max(laneBot, nodeBot) + LANE_PAD;
}
