import { W } from "./svg-primitives.js";
import type { Meta } from "./model.js";
import type {
  AgentStep,
  BranchStep,
  ControlStep,
  LoopStep,
  Multiplicity,
  ParallelStep,
  PipelineStep,
  Step,
  Topology,
} from "./topology.js";
import type { GEdge, GEdgeKind, GLane, GLoop, GNode, LaneMember, Layout } from "./topo-geometry.js";

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
  const { lanes, titleToLane } = buildLanes(topology, meta);
  const laneOf = (phase: string | null): number =>
    phase !== null && titleToLane.has(phase) ? (titleToLane.get(phase) as number) : 0;

  const ctx: Ctx = { nodes: [], edges: [], loops: [], notes: [], idSeq: 0, laneOf };

  // Flow top-level steps top→down. Empty bands between consecutive shapes (and
  // trailing) collapse to slim strips the graph simply flows past. Because the
  // body calls phase() in order, top-level step bands are non-decreasing, so a
  // band strictly between the last-covered band and the next shape's band is
  // genuinely empty — no later shape can reach back up to fill it. Entering a
  // new lane leaves chrome room; continuing one keeps a tight gap.
  let y = LANE_HEADER_H + LANE_PAD;
  let prevExits: string[] = [];
  let prevBand = -1;
  let placedAny = false;
  const gapInto = (b: number): number =>
    !placedAny ? 0 : b !== prevBand ? LANE_GAP_CROSS : STACK_GAP;
  for (const step of topology.steps) {
    const band = entryBand(step, ctx);
    for (let idx = prevBand + 1; idx < band; idx++) {
      y += gapInto(idx);
      y = stripLane(lanes[idx], y);
      prevBand = idx;
      placedAny = true;
    }
    y += gapInto(band);
    const placed = placeStep(step, ctx, y);
    for (const exit of prevExits) connect(ctx, exit, placed.entry, "seq");
    y = placed.bottom;
    prevExits = placed.exits;
    prevBand = Math.max(prevBand, placed.maxBand);
    placedAny = true;
  }
  for (let idx = prevBand + 1; idx < lanes.length; idx++) {
    y += gapInto(idx);
    const isTrailingTerminal = placedAny && idx === lanes.length - 1;
    if (isTrailingTerminal) {
      const terminal = placeTerminal(ctx, y, idx);
      for (const exit of prevExits) connect(ctx, exit, terminal.entry, "seq");
      y = terminal.bottom;
      prevExits = terminal.exits;
    } else {
      y = stripLane(lanes[idx], y);
    }
    prevBand = idx;
    placedAny = true;
  }

  deriveLaneRanges(lanes, ctx.nodes);
  fixupUnsetLanes(lanes);
  const height = pageHeight(lanes, ctx.nodes);
  return {
    width: W,
    height,
    lanes,
    nodes: ctx.nodes,
    edges: ctx.edges,
    loops: ctx.loops,
    notes: ctx.notes,
  };
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
/** Chrome row (chip + title + model chip) reserved above a lane's first node —
 *  large enough that the title clears the node circles beneath it. */
export const LANE_HEADER_H = 38;
/** Padding between a lane's node bbox and its painted stripe edge. */
export const LANE_PAD = 12;
/** Gap between stacked top-level shapes in the SAME lane. */
export const STACK_GAP = 26;
/** Gap when the flow crosses into a NEW lane (leaves room for its chrome). */
export const LANE_GAP_CROSS = LANE_HEADER_H + LANE_PAD + 4;
/** Slim height of an empty / control-only phase strip. */
export const STRIP_H = 30;
/** Vertical gap between a fork/barrier/sink and the row it brackets. */
export const FAN_GAP = 16;
/** Vertical gap between sequential steps inside a chain (arm / loop body). */
export const INNER_GAP = 20;
/** Height of one "↻ repeat …" badge row reserved below a loop head so the
 *  badge never paints over the body content beneath it. Must match the
 *  renderer's per-badge step (`LOOP_FONT + 3`). */
export const LOOP_BADGE_ROW = 14;
/** Vertical gap between pipeline stage rows. */
export const STAGE_GAP = 26;
/** Coral barrier (join bar) thickness. */
export const BARRIER_H = 7;
/** Label typography for fan-out members / pipeline cells set below the node. */
export const MEMBER_FONT = 11;
export const MEMBER_LABEL_H = 14;
export const LABEL_GAP = 7;
/** Min / max horizontal cell a member or pipeline column occupies. */
export const MIN_CELL = 2 * NODE_R + 16;
export const MAX_CELL = 150;
/** A row of members/columns must fit this width or it collapses to ×N. */
export const MAX_ROW_W = W - 2 * 24;
/** Horizontal separation between stacked branch / parallel arms (off the spine,
 *  so a connector to a lower arm never passes through an upper one). */
export const ARM_DX = 130;
/** A literal-count fan-out wider than this draws as ×N rather than N circles. */
export const ROW_CAP = 6;
/** Full height of a single-node row/grid cell (circle + label below). */
const CELL_H = 2 * NODE_R + LABEL_GAP + MEMBER_LABEL_H;

// ---------------------------------------------------------------------------
// Placement context + node/edge helpers
// ---------------------------------------------------------------------------

interface Ctx {
  nodes: GNode[];
  edges: GEdge[];
  loops: GLoop[];
  notes: string[];
  idSeq: number;
  laneOf: (phase: string | null) => number;
}

/** Record an honest placement-time degradation once (deduped). */
function note(ctx: Ctx, message: string): void {
  if (!ctx.notes.includes(message)) ctx.notes.push(message);
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
    case "control":
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
function connect(ctx: Ctx, fromId: string, toId: string, kind: GEdgeKind, label?: string): void {
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
    ...(label !== undefined ? { label } : {}),
  });
}

/** An edge with explicit points — for drops onto a barrier bar at the member's
 *  own x (not converging on the bar center). */
function pushEdge(
  ctx: Ctx,
  fromId: string,
  toId: string,
  points: Array<{ x: number; y: number }>,
  kind: GEdgeKind,
): void {
  ctx.edges.push({ from: fromId, to: toId, points, kind });
}

/**
 * Place a sub-graph, then shift everything it created horizontally by `dx` — so
 * a parallel/branch arm can sit off the spine without threading an x parameter
 * through every template. Nodes and the points of edges created during the call
 * move together; loop badges key off ids, so they ride along untouched. The
 * surrounding fork/decision/barrier edges are made AFTER, against the shifted
 * positions, so they connect cleanly.
 */
function placeTranslated(ctx: Ctx, dx: number, place: () => Placed): Placed {
  const n0 = ctx.nodes.length;
  const e0 = ctx.edges.length;
  const placed = place();
  if (dx === 0) return placed;
  let bottom = placed.bottom;
  for (let i = n0; i < ctx.nodes.length; i++) {
    const n = ctx.nodes[i];
    n.x += dx;
    // Off the spine now → its label belongs below, not to the right (where a
    // sibling arm or the spine would sit). Keeps placement and renderer in
    // agreement, and grows the reported bottom so the label's footprint is
    // spaced for.
    if (n.kind === "agent" && n.label !== "") {
      n.labelBelow = true;
      bottom = Math.max(bottom, n.y + n.r + LABEL_GAP + MEMBER_LABEL_H);
    }
  }
  for (let i = e0; i < ctx.edges.length; i++) {
    for (const p of ctx.edges[i].points) (p as { x: number }).x += dx;
  }
  return { ...placed, bottom };
}

/** Symmetric horizontal offsets for n arms spread around the spine. */
function symmetricOffsets(n: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * step);
}

/** The label of an arm's first step, when it's an agent — used to size the
 *  side-by-side column so a wide arm label doesn't collide with its neighbor. */
function firstChainLabel(arm: Step[]): string | undefined {
  const head = arm[0];
  return head?.kind === "agent" ? (head as AgentStep).label : undefined;
}

// ---------------------------------------------------------------------------
// Per-step placement: one compact, self-contained template per analyzer shape,
// each recursing over `Step` and exposing an entry/exit surface so siblings and
// stages connect by short edges — no general graph algorithm, no edge router.
// ---------------------------------------------------------------------------

function placeStep(step: Step, ctx: Ctx, topY: number): Placed {
  switch (step.kind) {
    case "agent":
      return placeAgent(step, ctx, topY);
    case "workflow":
    case "opaque":
      return placeTask(step.label, ctx, topY, ctx.laneOf(step.phase));
    case "control":
      return placeControl(step, ctx, topY);
    case "parallel":
      return step.form === "fanout"
        ? placeFanout(step, ctx, topY)
        : placeBranches(step, ctx, topY);
    case "pipeline":
      return placePipeline(step, ctx, topY);
    case "branch":
      return placeBranch(step, ctx, topY);
    case "loop":
      return placeLoop(step, ctx, topY);
    default:
      // Unknown-but-valid shape: an honest blob in its own lane (totality).
      return placeTask(`[${(step as Step).kind}]`, ctx, topY, ctx.laneOf((step as Step).phase));
  }
}

/**
 * Place a Step[] as a vertical chain on the spine: each step below the last,
 * joined by `seq` edges, with extra headroom when a step crosses into a new
 * lane. Returns null for an empty chain. The shared building block for branch
 * arms, parallel-branch arms, and loop bodies.
 */
function placeChain(steps: Step[], ctx: Ctx, topY: number): Placed | null {
  if (steps.length === 0) return null;
  let y = topY;
  let entry: string | null = null;
  let prevExits: string[] = [];
  let prevBand = -1;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let minBand = Number.POSITIVE_INFINITY;
  let maxBand = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    if (prevBand !== -1 && ctx.laneOf(step.phase) !== prevBand) y += LANE_HEADER_H;
    const placed = placeStep(step, ctx, y);
    if (entry === null) entry = placed.entry;
    for (const exit of prevExits) connect(ctx, exit, placed.entry, "seq");
    prevExits = placed.exits;
    y = placed.bottom + INNER_GAP;
    prevBand = placed.maxBand;
    top = Math.min(top, placed.top);
    bottom = Math.max(bottom, placed.bottom);
    minBand = Math.min(minBand, placed.minBand);
    maxBand = Math.max(maxBand, placed.maxBand);
  }
  return { entry: entry as string, exits: prevExits, top, bottom, minBand, maxBand };
}

// ---------------------------------------------------------------------------
// Parallel — fan-out (one body × N) and branches (k distinct chains).
// ---------------------------------------------------------------------------

/**
 * A `.map` fan-out: a fork hub, a centered row of N member circles, a coral
 * join barrier every member drops onto, and a sink hub the flow leaves from —
 * so EVERY member has an onward edge (no dangling fan, the review-pr bug).
 * Width-bounded: a row that would overflow, or an unknown/over-cap count,
 * collapses to a single ×N member (logged), never silently truncated.
 */
function placeFanout(step: ParallelStep & { form: "fanout" }, ctx: Ctx, topY: number): Placed {
  const band = cellBand(step, ctx);
  const single = step.body.length === 1 && step.body[0].kind === "agent" ? (step.body[0] as AgentStep) : null;
  const model = single?.model;
  const members = fanMembers(step, single, ctx);

  // One effective member (unknown width, collapse, or non-agent body) → a lone
  // badged circle; no fork/join scaffolding to draw around a single node.
  if (members.labels.length === 1) {
    const cy = topY + NODE_R;
    const n = addNode(ctx, {
      kind: "agent",
      x: SPINE_X,
      y: cy,
      r: NODE_R,
      label: members.labels[0],
      phase: band,
      ...(single ? { labelExplicit: single.labelExplicit } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(members.badge !== undefined ? { mult: members.badge } : {}),
    });
    return { entry: n.id, exits: [n.id], top: cy - NODE_R, bottom: cy + NODE_R, minBand: band, maxBand: band };
  }

  const cellW = rowCellWidth(members.labels);
  const xs = rowCenters(members.labels.length, cellW, SPINE_X);

  const source = addNode(ctx, { kind: "hub", x: SPINE_X, y: topY + HUB_R, r: HUB_R, label: "", phase: band });
  const rowCy = source.y + HUB_R + FAN_GAP + NODE_R;
  const memberIds = members.labels.map((label, i) => {
    const n = addNode(ctx, {
      kind: "agent",
      x: xs[i],
      y: rowCy,
      r: NODE_R,
      label,
      labelBelow: true,
      phase: band,
      ...(single ? { labelExplicit: single.labelExplicit } : {}),
      ...(model !== undefined ? { model } : {}),
    });
    connect(ctx, source.id, n.id, "fan");
    return n.id;
  });

  const rowBottom = rowCy + NODE_R + LABEL_GAP + MEMBER_LABEL_H;
  const barrierY = rowBottom + FAN_GAP;
  const span = xs[xs.length - 1] - xs[0] + 2 * NODE_R;
  const barrier = addNode(ctx, {
    kind: "barrier",
    x: SPINE_X,
    y: barrierY,
    r: BARRIER_H / 2,
    w: span,
    h: BARRIER_H,
    label: "",
    phase: band,
  });
  for (let i = 0; i < memberIds.length; i++) {
    pushEdge(
      ctx,
      memberIds[i],
      barrier.id,
      [
        { x: xs[i], y: rowCy + NODE_R },
        { x: xs[i], y: barrierY - BARRIER_H / 2 },
      ],
      "merge",
    );
  }

  const sink = addNode(ctx, {
    kind: "hub",
    x: SPINE_X,
    y: barrierY + BARRIER_H / 2 + FAN_GAP + HUB_R,
    r: HUB_R,
    label: "",
    phase: band,
  });
  connect(ctx, barrier.id, sink.id, "seq");
  return {
    entry: source.id,
    exits: [sink.id],
    top: source.y - HUB_R,
    bottom: sink.y + HUB_R,
    minBand: band,
    maxBand: band,
  };
}

interface FanMembers {
  labels: string[];
  badge?: string;
}

/** Resolve a fan-out's drawn members from its literal multiplicity (honest
 *  counts only); collapse unknown/over-cap/over-wide to a single ×N rep. */
function fanMembers(
  step: ParallelStep & { form: "fanout" },
  single: AgentStep | null,
  ctx: Ctx,
): FanMembers {
  const baseLabel = single?.label ?? "task";
  const m = step.multiplicity;
  let labels: string[];
  if (m.kind === "named") {
    labels = single?.expandedLabels ?? m.names.map((n) => `${baseLabel}:${n}`);
  } else if (m.kind === "exact" && m.count <= ROW_CAP) {
    labels = Array.from({ length: Math.max(1, m.count) }, () => baseLabel);
  } else {
    // unknown, or a literal count past the cap → one representative ×N circle.
    return { labels: [representativeFanLabel(baseLabel, m)], badge: fanBadge(m) };
  }
  // Width guard: a row that would overflow collapses to ×N as well.
  if (labels.length * rowCellWidth(labels) > MAX_ROW_W) {
    note(ctx, `fan-out of ${labels.length} drawn as ${fanBadge(m)} (row exceeds width)`);
    return { labels: [representativeFanLabel(baseLabel, m)], badge: fanBadge(m) };
  }
  return { labels };
}

function representativeFanLabel(baseLabel: string, m: Multiplicity): string {
  if (m.kind !== "unknown" || !m.hint) return baseLabel;
  const action = /^[A-Za-z][\w -]{1,24}:/.test(baseLabel)
    ? baseLabel.slice(0, baseLabel.indexOf(":"))
    : baseLabel;
  return `${action} each ${m.hint}`;
}

/**
 * Parallel branches (k distinct thunks): a fork hub fans to each arm, every arm
 * rejoins a shared barrier → sink. Two layouts:
 *
 *  - SIDE BY SIDE (`placeBranchesRow`) when every arm is a single step landing
 *    in ONE shared lane (the common case — incl. a multi-phase parallel whose
 *    phases `buildLanes` collapsed into one row): the arms spread as columns at
 *    the SAME y, so the fork→arms→join diamond reads as concurrent at a glance.
 *  - STACKED (`placeBranchesStacked`) otherwise (arms in distinct lanes, or
 *    deep multi-step arms): arms stack down their own lanes, concurrency carried
 *    by the fork/join edges — the honest fallback when columns can't co-register.
 */
function placeBranches(step: ParallelStep & { form: "branches" }, ctx: Ctx, topY: number): Placed {
  const armBands = step.branches.map((arm) => (arm.length > 0 ? ctx.laneOf(arm[0].phase) : ctx.laneOf(step.phase)));
  const oneLane = armBands.every((b) => b === armBands[0]);
  const simpleArms = step.branches.every((arm) => arm.length <= 1);
  return oneLane && simpleArms
    ? placeBranchesRow(step, ctx, topY, armBands[0] ?? ctx.laneOf(step.phase))
    : placeBranchesStacked(step, ctx, topY, armBands);
}

/** Arms as side-by-side columns in one shared lane (see `placeBranches`). */
function placeBranchesRow(
  step: ParallelStep & { form: "branches" },
  ctx: Ctx,
  topY: number,
  band: number,
): Placed {
  const source = addNode(ctx, { kind: "hub", x: SPINE_X, y: topY + HUB_R, r: HUB_R, label: "", phase: band });
  const armTopY = source.y + HUB_R + FAN_GAP;
  const armExits: string[] = [];
  let minBand = band;
  let maxBand = band;
  const firstLabels = step.branches.map((arm) => firstChainLabel(arm) ?? "");
  const cellW = Math.max(ARM_DX, rowCellWidth(firstLabels));
  const xs = rowCenters(step.branches.length, cellW, SPINE_X);
  let bottom = armTopY;
  step.branches.forEach((arm, i) => {
    const placed = placeTranslated(ctx, xs[i] - SPINE_X, () =>
      placeChain(arm, ctx, armTopY) ?? placeChainStub(ctx, armTopY, band),
    );
    connect(ctx, source.id, placed.entry, "fan");
    armExits.push(...placed.exits);
    bottom = Math.max(bottom, placed.bottom);
    minBand = Math.min(minBand, placed.minBand);
    maxBand = Math.max(maxBand, placed.maxBand);
  });

  const span = xs[xs.length - 1] - xs[0] + 2 * NODE_R;
  const barrier = addNode(ctx, {
    kind: "barrier",
    x: SPINE_X,
    y: bottom + FAN_GAP + BARRIER_H / 2,
    r: BARRIER_H / 2,
    w: span,
    h: BARRIER_H,
    label: "",
    phase: band,
  });
  for (const exit of armExits) connect(ctx, exit, barrier.id, "merge");
  const sink = addNode(ctx, {
    kind: "hub",
    x: SPINE_X,
    y: barrier.y + BARRIER_H / 2 + FAN_GAP + HUB_R,
    r: HUB_R,
    label: "",
    phase: band,
  });
  connect(ctx, barrier.id, sink.id, "seq");
  return { entry: source.id, exits: [sink.id], top: source.y - HUB_R, bottom: sink.y + HUB_R, minBand, maxBand };
}

/** Arms stacked down their own lanes (see `placeBranches`). */
function placeBranchesStacked(
  step: ParallelStep & { form: "branches" },
  ctx: Ctx,
  topY: number,
  armBands: number[],
): Placed {
  const headBand = armBands.length > 0 ? Math.min(...armBands) : ctx.laneOf(step.phase);
  const tailBand = armBands.length > 0 ? Math.max(...armBands) : ctx.laneOf(step.phase);

  const source = addNode(ctx, { kind: "hub", x: SPINE_X, y: topY + HUB_R, r: HUB_R, label: "", phase: headBand });
  let y = source.y + HUB_R + FAN_GAP;
  const armExits: string[] = [];
  let minBand = headBand;
  let maxBand = tailBand;
  const offsets = symmetricOffsets(step.branches.length, ARM_DX);
  let prevEndBand = -1;
  step.branches.forEach((arm, i) => {
    if (prevEndBand !== -1 && armBands[i] !== prevEndBand) y += LANE_HEADER_H;
    const placed = placeTranslated(ctx, offsets[i], () =>
      placeChain(arm, ctx, y) ?? placeChainStub(ctx, y, ctx.laneOf(step.phase)),
    );
    connect(ctx, source.id, placed.entry, "fan");
    armExits.push(...placed.exits);
    y = placed.bottom + INNER_GAP;
    prevEndBand = placed.maxBand;
    minBand = Math.min(minBand, placed.minBand);
    maxBand = Math.max(maxBand, placed.maxBand);
  });

  const barrier = addNode(ctx, {
    kind: "barrier",
    x: SPINE_X,
    y: y + BARRIER_H / 2,
    r: BARRIER_H / 2,
    w: 2 * NODE_R + 8,
    h: BARRIER_H,
    label: "",
    phase: tailBand,
  });
  for (const exit of armExits) connect(ctx, exit, barrier.id, "merge");
  const sink = addNode(ctx, {
    kind: "hub",
    x: SPINE_X,
    y: barrier.y + BARRIER_H / 2 + FAN_GAP + HUB_R,
    r: HUB_R,
    label: "",
    phase: tailBand,
  });
  connect(ctx, barrier.id, sink.id, "seq");
  return {
    entry: source.id,
    exits: [sink.id],
    top: source.y - HUB_R,
    bottom: sink.y + HUB_R,
    minBand,
    maxBand,
  };
}

/** A tiny terminal hub for an empty branch/parallel arm — the labeled stub. */
function placeChainStub(ctx: Ctx, topY: number, band: number): Placed {
  const n = addNode(ctx, { kind: "hub", x: SPINE_X, y: topY + HUB_R, r: HUB_R, label: "", phase: band });
  return { entry: n.id, exits: [n.id], top: n.y - HUB_R, bottom: n.y + HUB_R, minBand: band, maxBand: band };
}

// ---------------------------------------------------------------------------
// Pipeline — N item columns × stage rows; stage edges span lanes directly.
// ---------------------------------------------------------------------------

/**
 * `pipeline(items, ...stages)`: each item threads independently through every
 * stage (no barrier between stages). Drawn as a grid — one column per item,
 * one row per stage — with a fork hub fanning to each column's first cell and a
 * sink hub the last cells rejoin. Stage rows sit in their own phase lanes, so a
 * `stage` edge that crosses phases is just a short vertical here. Columns
 * collapse to a single ×N representative when unknown / over-cap / over-wide.
 */
function placePipeline(step: PipelineStep, ctx: Ctx, topY: number): Placed {
  const stageBands = step.stages.map((stage) => (stage.length > 0 ? cellBand(stage[0], ctx) : ctx.laneOf(step.phase)));
  const headBand = stageBands.length > 0 ? stageBands[0] : ctx.laneOf(step.phase);
  const cols = pipelineColumns(step, ctx);

  const source = addNode(ctx, { kind: "hub", x: SPINE_X, y: topY + HUB_R, r: HUB_R, label: "", phase: headBand });
  const xs = rowCenters(cols.count, pipelineCellWidth(step), SPINE_X);

  // Pre-compute each stage row's top y, with headroom where a row changes lane.
  const rowTops: number[] = [];
  let rowY = source.y + HUB_R + FAN_GAP;
  for (let s = 0; s < step.stages.length; s++) {
    if (s > 0 && stageBands[s] !== stageBands[s - 1]) rowY += LANE_HEADER_H;
    rowTops.push(rowY);
    rowY += CELL_H + STAGE_GAP;
  }

  const colExits: string[] = [];
  for (let c = 0; c < cols.count; c++) {
    let prevExit: string | null = null;
    let colEntry: string | null = null;
    for (let s = 0; s < step.stages.length; s++) {
      const badge = c === 0 && cols.badge !== undefined && s === 0 ? cols.badge : undefined;
      const cell = placeStageCell(step.stages[s], ctx, xs[c], rowTops[s], c, badge);
      if (colEntry === null) colEntry = cell.id;
      if (prevExit !== null) connect(ctx, prevExit, cell.id, "stage");
      prevExit = cell.id;
    }
    connect(ctx, source.id, colEntry as string, "fan");
    colExits.push(prevExit as string);
  }

  const tailBand = stageBands.length > 0 ? stageBands[stageBands.length - 1] : headBand;
  const sink = addNode(ctx, {
    kind: "hub",
    x: SPINE_X,
    y: rowY - STAGE_GAP + FAN_GAP + HUB_R,
    r: HUB_R,
    label: "",
    phase: tailBand,
  });
  for (const exit of colExits) connect(ctx, exit, sink.id, "merge");
  return {
    entry: source.id,
    exits: [sink.id],
    top: source.y - HUB_R,
    bottom: sink.y + HUB_R,
    minBand: Math.min(headBand, ...stageBands),
    maxBand: Math.max(headBand, ...stageBands),
  };
}

interface PipelineCols {
  count: number;
  badge?: string;
}

/** Column count from the items multiplicity (literal-only); collapse unknown/
 *  over-cap/over-wide to one ×N representative column. */
function pipelineColumns(step: PipelineStep, ctx: Ctx): PipelineCols {
  const m = step.items;
  let count: number;
  if (m.kind === "named") count = m.names.length;
  else if (m.kind === "exact" && m.count <= ROW_CAP) count = Math.max(1, m.count);
  else return { count: 1, badge: fanBadge(m) };

  if (count * pipelineCellWidth(step) > MAX_ROW_W) {
    note(ctx, `pipeline of ${count} items drawn as ${fanBadge(m)} (row exceeds width)`);
    return { count: 1, badge: fanBadge(m) };
  }
  return { count };
}

/** Place one pipeline cell (a stage's representative node) at (x, top). Corpus
 *  stages are single steps; a multi-step stage is summarized to its head + a
 *  note, and a nested fan-out collapses to a ×N circle in the cell. */
function placeStageCell(
  stage: Step[],
  ctx: Ctx,
  x: number,
  top: number,
  colIdx: number,
  colBadge: string | undefined,
): GNode {
  if (stage.length > 1) note(ctx, "pipeline stage with multiple steps drawn as its head");
  const s = stage[0];
  if (s === undefined) {
    return addNode(ctx, { kind: "hub", x, y: top + HUB_R, r: HUB_R, label: "", phase: 0 });
  }
  const band = cellBand(s, ctx);
  if (s.kind === "agent") {
    const label = s.expandedLabels?.[colIdx] ?? s.label;
    const own = multBadge(s.multiplicity);
    const badge = colBadge ?? own;
    return addNode(ctx, {
      kind: "agent",
      x,
      y: top + NODE_R,
      r: NODE_R,
      label,
      labelExplicit: s.labelExplicit,
      labelBelow: true,
      phase: band,
      ...(s.model !== undefined ? { model: s.model } : {}),
      ...(badge !== undefined ? { mult: badge } : {}),
    });
  }
  if (s.kind === "parallel" && s.form === "fanout") {
    const inner = s.body.length === 1 && s.body[0].kind === "agent" ? (s.body[0] as AgentStep) : null;
    const badge = colBadge ?? fanBadge(s.multiplicity);
    return addNode(ctx, {
      kind: "agent",
      x,
      y: top + NODE_R,
      r: NODE_R,
      label: inner?.label ?? "task",
      labelBelow: true,
      phase: band,
      ...(inner ? { labelExplicit: inner.labelExplicit } : {}),
      ...(inner?.model !== undefined ? { model: inner.model } : {}),
      mult: badge,
    });
  }
  // Any other nested shape in a stage cell → an honest task blob + a note.
  note(ctx, `pipeline stage shape '${s.kind}' drawn as a task node`);
  const label = "label" in s ? (s as { label: string }).label : `[${s.kind}]`;
  const w = Math.min(MAX_CELL, Math.max(MIN_CELL, Math.round(label.length * 7) + 24));
  return addNode(ctx, { kind: "task", x, y: top + TASK_H / 2, r: TASK_H / 2, w, h: TASK_H, label, phase: band });
}

// ---------------------------------------------------------------------------
// Branch — a quiet decision diamond fanning to each arm (all arms shown).
// ---------------------------------------------------------------------------

/**
 * An `if`/ternary: a small decision diamond (the verbatim condition rides as
 * its label/tooltip), then both arms placed below it on the spine — the
 * condition-true ("yes") arm first, the "no" arm next, each flowing into its
 * own lane. An empty arm becomes a tiny labeled stub. No barrier: a branch is
 * an exclusive choice, so both arms' tails are the shape's exits.
 */
function placeBranch(step: BranchStep, ctx: Ctx, topY: number): Placed {
  const band = ctx.laneOf(step.phase);
  const decision = addNode(ctx, {
    kind: "decision",
    x: SPINE_X,
    y: topY + DIAMOND_HALF,
    r: DIAMOND_HALF,
    label: step.conditionLabel,
    phase: band,
  });

  let y = decision.y + DIAMOND_HALF + INNER_GAP;
  const exits: string[] = [];
  let minBand = band;
  let maxBand = band;
  const arms: Array<{ steps: Step[]; outcome: string }> = [
    { steps: step.thenSteps, outcome: "yes" },
    { steps: step.elseSteps, outcome: "no" },
  ];
  // The primary (first non-empty) arm continues straight down the spine — the
  // main flow stays a vertical; the other arm(s) stack below and fan off to the
  // side so the spine connector passes them cleanly. No barrier: exclusive
  // choice, so every arm tail is an exit.
  const primary = Math.max(0, arms.findIndex((a) => a.steps.length > 0));
  const armBands = arms.map((a) => (a.steps.length > 0 ? ctx.laneOf(a.steps[0].phase) : band));
  let sideRank = 0;
  let prevEndBand = -1;
  arms.forEach((arm, i) => {
    if (prevEndBand !== -1 && armBands[i] !== prevEndBand) y += LANE_HEADER_H;
    const dx = i === primary ? 0 : ++sideRank * ARM_DX;
    const placed = placeTranslated(ctx, dx, () =>
      arm.steps.length > 0 ? (placeChain(arm.steps, ctx, y) as Placed) : placeChainStub(ctx, y, band),
    );
    connect(ctx, decision.id, placed.entry, "seq", arm.outcome);
    exits.push(...placed.exits);
    y = placed.bottom + INNER_GAP;
    prevEndBand = placed.maxBand;
    minBand = Math.min(minBand, placed.minBand);
    maxBand = Math.max(maxBand, placed.maxBand);
  });
  return {
    entry: decision.id,
    exits,
    top: decision.y - DIAMOND_HALF,
    bottom: y - INNER_GAP,
    minBand,
    maxBand,
  };
}

// ---------------------------------------------------------------------------
// Loop — the body placed once, the looping noted as a local badge (no edge).
// ---------------------------------------------------------------------------

/**
 * Any orchestrating loop: place the body once, then pin a local "↻ repeat …"
 * badge to the body's head — NEVER a routed back-edge. Nested same-lane loops
 * stack their badges on the same node (inner-first). A loop body that spans
 * phases is kept local with the badge on its first lane and logged (no
 * cross-lane back-route) — the multi-phase-loop residual.
 */
function placeLoop(step: LoopStep, ctx: Ctx, topY: number): Placed {
  const n0 = ctx.nodes.length;
  const e0 = ctx.edges.length;
  const body = placeChain(step.body, ctx, topY);
  if (body === null) {
    const stub = placeTask("(empty loop body)", ctx, topY, ctx.laneOf(step.phase));
    ctx.loops.push({ onNode: stub.entry, label: loopLabel(step), tooltip: loopTooltip(step) });
    return stub;
  }
  ctx.loops.push({ onNode: body.entry, label: loopLabel(step), tooltip: loopTooltip(step) });
  if (body.minBand !== body.maxBand) {
    note(ctx, `loop body spans phases; kept local with a repeat badge (no cross-lane back-edge)`);
  }
  // The badge pins to the body's head and paints to its lower-right. Reserve a
  // row of space by sliding everything the loop placed BELOW the head down one
  // badge row, so the body content (a decision's arms, the next step) clears
  // the badge. Nested loops share the head and reserve cumulatively — two
  // stacked badges get two rows — which is exactly the choose-approach fix.
  const head = byId(ctx, body.entry);
  const newBottom = reserveBadgeRow(ctx, head, n0, e0);
  return { ...body, bottom: Math.max(body.bottom, newBottom) };
}

/**
 * Slide the loop's own nodes/edges that sit below its head down by one badge
 * row, anchoring at the head's bottom so the head→body edge just lengthens
 * (still downward — the invariant holds). Returns the new lowest extent.
 */
function reserveBadgeRow(ctx: Ctx, head: GNode, n0: number, e0: number): number {
  const cut = head.y + halfHeight(head);
  let bottom = head.y + halfHeight(head);
  for (let i = n0; i < ctx.nodes.length; i++) {
    const n = ctx.nodes[i];
    if (n.id !== head.id && n.y > head.y) n.y += LOOP_BADGE_ROW;
    bottom = Math.max(bottom, n.y + halfHeight(n) + (n.labelBelow === true ? LABEL_GAP + MEMBER_LABEL_H : 0));
  }
  for (let i = e0; i < ctx.edges.length; i++) {
    for (const p of ctx.edges[i].points) {
      if (p.y > cut) (p as { y: number }).y += LOOP_BADGE_ROW;
    }
  }
  return bottom;
}

/** Verbatim loop phrasing for the repeat badge. */
function loopLabel(step: LoopStep): string {
  const verb = step.loopKind === "while" || step.loopKind === "do-while" ? "while" : "for";
  return `repeat ${verb} ${step.conditionLabel}`;
}

function loopTooltip(step: LoopStep): string {
  const verb = step.loopKind === "while" || step.loopKind === "do-while" ? "while" : "for";
  return `repeat ${verb} ${step.conditionTooltip ?? step.conditionLabel}`;
}

// ---------------------------------------------------------------------------
// Row / grid geometry + multiplicity badges
// ---------------------------------------------------------------------------

/** N evenly-spaced cell centers of width `cellW`, centered on `centerX`. */
function rowCenters(n: number, cellW: number, centerX: number): number[] {
  const left = centerX - (n * cellW) / 2 + cellW / 2;
  return Array.from({ length: n }, (_, i) => left + i * cellW);
}

/** Uniform member-cell width: the widest label, clamped to [MIN_CELL, MAX_CELL]. */
function rowCellWidth(labels: string[]): number {
  const widest = labels.reduce((m, l) => Math.max(m, estTextW(l, MEMBER_FONT)), 0);
  return Math.min(MAX_CELL, Math.max(MIN_CELL, widest + 14));
}

/** Pipeline column width: widest stage-0 cell label (per-item expanded). */
function pipelineCellWidth(step: PipelineStep): number {
  const stage0 = step.stages[0] ?? [];
  const head = stage0[0];
  const labels =
    head?.kind === "agent" && head.expandedLabels !== undefined
      ? head.expandedLabels
      : [head && "label" in head ? (head as { label: string }).label : "stage"];
  return rowCellWidth(labels);
}

/** Conservative text-width estimate (mirrors svg-primitives' 0.58em glyph). */
function estTextW(s: string, size: number): number {
  return s.length * size * 0.58;
}

/**
 * The lane a shape's work belongs to — its leaf agent's phase, not a structural
 * wrapper's. A `parallel` in a pipeline stage keeps the lexical phase of where
 * the call sits, but the author tags the inner agent (e.g. review-pr's verify
 * fan tagged "Adversarially verify"); the cell follows that intent.
 */
function cellBand(step: Step, ctx: Ctx): number {
  if (step.kind === "parallel" && step.form === "fanout") {
    const inner = step.body.length === 1 && step.body[0].kind === "agent" ? (step.body[0] as AgentStep) : null;
    return ctx.laneOf(inner?.phase ?? step.phase);
  }
  return ctx.laneOf(step.phase);
}

/**
 * The lane a shape's ENTRY node lands in — which can differ from its own
 * `.phase` (a parallel/pipeline keeps the lexical phase of the call site, but
 * its fork/first row belongs to the first arm/stage's phase). The flow uses
 * this, not `step.phase`, to size the gap before a shape so the new lane's
 * chrome always clears the previous content.
 */
function entryBand(step: Step, ctx: Ctx): number {
  switch (step.kind) {
    case "parallel":
      if (step.form === "fanout") return cellBand(step, ctx);
      return step.branches.length > 0
        ? Math.min(...step.branches.map((a) => (a.length > 0 ? ctx.laneOf(a[0].phase) : ctx.laneOf(step.phase))))
        : ctx.laneOf(step.phase);
    case "pipeline":
      return step.stages.length > 0 && step.stages[0].length > 0
        ? cellBand(step.stages[0][0], ctx)
        : ctx.laneOf(step.phase);
    case "loop":
      return step.body.length > 0 ? entryBand(step.body[0], ctx) : ctx.laneOf(step.phase);
    default:
      return ctx.laneOf(step.phase);
  }
}

/** Multiplicity → fan badge, treating unknown as ×N (used for collapses). */
function fanBadge(m: Multiplicity): string {
  return multBadge(m) ?? "×N";
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
    labelExplicit: step.labelExplicit,
    phase: band,
    ...(step.model !== undefined ? { model: step.model } : {}),
    ...(mult !== undefined ? { mult } : {}),
    ...(step.promptPreview !== undefined ? { tooltip: step.promptPreview } : {}),
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

function controlExits(flow: ControlStep["flow"], id: string): string[] {
  return flow === undefined ? [id] : [];
}

function placeControl(step: ControlStep, ctx: Ctx, topY: number): Placed {
  const band = ctx.laneOf(step.phase);
  const cy = topY + TASK_H / 2;
  const w = Math.min(W - 2 * LANE_PAD, Math.max(TASK_MIN_W, Math.round(step.label.length * 7) + 30));
  const n = addNode(ctx, {
    kind: "control",
    x: SPINE_X,
    y: cy,
    r: TASK_H / 2,
    w,
    h: TASK_H,
    label: step.label,
    phase: band,
    ...(step.flow !== undefined ? { flow: step.flow } : {}),
    ...(step.tooltip !== undefined ? { tooltip: step.tooltip } : {}),
  });
  return {
    entry: n.id,
    exits: controlExits(step.flow, n.id),
    top: cy - TASK_H / 2,
    bottom: cy + TASK_H / 2,
    minBand: band,
    maxBand: band,
  };
}

function placeTerminal(ctx: Ctx, topY: number, band: number): Placed {
  const cy = topY + TASK_H / 2;
  const n = addNode(ctx, {
    kind: "control",
    x: SPINE_X,
    y: cy,
    r: TASK_H / 2,
    w: TASK_MIN_W,
    h: TASK_H,
    label: "end",
    phase: band,
    flow: "terminal",
    tooltip: "No agent/workflow calls were recovered in this phase.",
  });
  return {
    entry: n.id,
    exits: [],
    top: cy - TASK_H / 2,
    bottom: cy + TASK_H / 2,
    minBand: band,
    maxBand: band,
  };
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
 *
 * Concurrent phases collapse: when a `parallel([…])` runs each arm in a distinct
 * (but consecutive) phase, those phases would otherwise stack as separate rows
 * and read as sequential. `collapseRanges` folds each such run into ONE lane
 * carrying its arms as side-by-side `members`, so the row reads as parallel and
 * the side-by-side placement (`placeBranchesRow`) has a single lane to land in.
 * Returns the lanes plus the title→lane-index map (member titles included).
 */
function buildLanes(topology: Topology, meta: Meta): { lanes: GLane[]; titleToLane: Map<string, number> } {
  const modelByTitle = new Map(
    meta.phases.filter((p) => p.model?.trim()).map((p) => [p.title, p.model as string]),
  );
  const bands = topology.bands;
  const modelOf = (i: number): string | undefined =>
    bands[i].inMeta && modelByTitle.has(bands[i].title) ? modelByTitle.get(bands[i].title) : undefined;

  const ranges = collapseRanges(topology, new Map(bands.map((b, i) => [b.title, i])));
  const startOfRange = new Map(ranges.map((r) => [r[0], r]));
  const insideRange = (i: number): boolean => ranges.some(([s, e]) => i > s && i <= e);

  const lanes: GLane[] = [];
  const titleToLane = new Map<string, number>();
  for (let i = 0; i < bands.length; i++) {
    if (insideRange(i)) continue; // folded into the lane its range started
    const phaseIndex = lanes.length;
    const range = startOfRange.get(i);
    if (range) {
      const members: LaneMember[] = [];
      for (let j = range[0]; j <= range[1]; j++) {
        members.push({ ordinal: j + 1, title: bands[j].title, ...(modelOf(j) !== undefined ? { model: modelOf(j) } : {}) });
        titleToLane.set(bands[j].title, phaseIndex);
      }
      lanes.push({
        phaseIndex,
        ordinal: range[0] + 1,
        title: bands[range[0]].title,
        members,
        yTop: 0,
        yBot: 0,
        empty: true,
      });
    } else {
      titleToLane.set(bands[i].title, phaseIndex);
      lanes.push({
        phaseIndex,
        ordinal: i + 1,
        title: bands[i].title,
        ...(modelOf(i) !== undefined ? { model: modelOf(i) } : {}),
        yTop: 0,
        yBot: 0,
        empty: true,
      });
    }
  }
  if (lanes.length === 0) {
    lanes.push({ phaseIndex: 0, ordinal: 1, title: "", yTop: 0, yBot: 0, empty: false });
  }
  return { lanes, titleToLane };
}

/**
 * The consecutive band ranges to collapse into one parallel row: each is a
 * `branches` parallel whose arms are all single agents landing in ≥2 distinct,
 * gap-free phases. Walks the whole tree (parallels nest), de-dupes, and keeps
 * only genuine multi-band runs. A non-consecutive or single-band parallel is
 * left alone — it places stacked, which never overlaps.
 */
function collapseRanges(topology: Topology, bandOf: Map<string, number>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (steps: Step[]): void => {
    for (const step of steps) {
      if (step.kind === "parallel" && step.form === "branches") {
        const eligible = step.branches.every((arm) => arm.length === 1 && arm[0].kind === "agent");
        if (eligible) {
          const idx = [
            ...new Set(
              step.branches
                .map((arm) => bandOf.get((arm[0] as AgentStep).phase ?? ""))
                .filter((b): b is number => b !== undefined),
            ),
          ].sort((a, b) => a - b);
          if (idx.length >= 2 && idx[idx.length - 1] - idx[0] === idx.length - 1) {
            ranges.push([idx[0], idx[idx.length - 1]]);
          }
        }
        step.branches.forEach(visit);
      } else if (step.kind === "parallel") visit(step.body);
      else if (step.kind === "pipeline") step.stages.forEach(visit);
      else if (step.kind === "branch") {
        visit(step.thenSteps);
        visit(step.elseSteps);
      } else if (step.kind === "loop") visit(step.body);
    }
  };
  visit(topology.steps);
  return ranges;
}

/** Mark a lane as a slim strip at the current cursor; returns the bottom (the
 *  flow adds the gap before the next thing). */
function stripLane(lane: GLane, y: number): number {
  lane.yTop = y;
  lane.yBot = y + STRIP_H;
  lane.empty = true;
  return y + STRIP_H;
}

/** Visual bottom of a node — its drawn extent, including a below-set label so a
 *  lane's stripe encloses the text under its circles. */
function visualBottom(n: GNode): number {
  return n.y + halfHeight(n) + (n.labelBelow === true ? LABEL_GAP + MEMBER_LABEL_H : 0);
}

/** Content lanes (those a node landed in) get a stripe = node bbox + padding,
 *  with header room reserved above for the chrome row. Strip lanes keep the
 *  range `stripLane` already gave them. */
function deriveLaneRanges(lanes: GLane[], nodes: GNode[]): void {
  for (const lane of lanes) {
    const own = nodes.filter((n) => n.phase === lane.phaseIndex);
    if (own.length === 0) continue;
    const top = Math.min(...own.map((n) => n.y - halfHeight(n)));
    const bot = Math.max(...own.map(visualBottom));
    lane.yTop = Math.max(0, top - LANE_HEADER_H);
    lane.yBot = bot + LANE_PAD;
    lane.empty = false;
  }
}

/**
 * Safety net for the rare orphan lane — one with no nodes that the flow never
 * struck a strip for (a phase index a structured shape skipped over). Wedge it
 * in as a slim strip between its band-order neighbors so stripes stay ordered
 * and the lane is never left with a degenerate zero range.
 */
function fixupUnsetLanes(lanes: GLane[]): void {
  let runningBottom = 0;
  for (const lane of lanes) {
    if (lane.yBot > lane.yTop) {
      runningBottom = Math.max(runningBottom, lane.yBot);
      continue;
    }
    lane.yTop = runningBottom;
    lane.yBot = runningBottom + STRIP_H;
    lane.empty = true;
    runningBottom = lane.yBot;
  }
}

function pageHeight(lanes: GLane[], nodes: GNode[]): number {
  const laneBot = lanes.reduce((m, l) => Math.max(m, l.yBot), 0);
  const nodeBot = nodes.reduce((m, n) => Math.max(m, n.y + halfHeight(n)), 0);
  return Math.max(laneBot, nodeBot) + LANE_PAD;
}

/**
 * Co-registration for the swimlane-table render: make each lane's painted band
 * at least as tall as its left label cell, so the label and its graph slice
 * share one row. `minHeights[i]` is the required height for lane `i` (the label
 * cell's measured height); a lane shorter than its label is inflated and
 * everything strictly below it slides down by the same delta — the rigid
 * downward shift keeps every edge flowing down (the layout invariant) and
 * leaves the graph's internal placement otherwise untouched.
 *
 * The extra space is added at the band's BOTTOM: graph nodes already sit at the
 * top of their band and the label cell is top-aligned, so the surplus becomes
 * trailing whitespace in whichever cell is shorter. Mirrors `reserveBadgeRow`'s
 * shift (nodes by lane index, edge points by a y-cut). Lanes are processed in
 * band order; each shift moves later lanes rigidly, so heights stay stable.
 */
export function reserveLaneHeights(layout: Layout, minHeights: number[]): void {
  let total = 0;
  for (let i = 0; i < layout.lanes.length; i++) {
    const lane = layout.lanes[i];
    const delta = (minHeights[i] ?? 0) - (lane.yBot - lane.yTop);
    if (delta <= 0) continue;
    const cut = lane.yBot;
    lane.yBot += delta;
    for (let j = i + 1; j < layout.lanes.length; j++) {
      layout.lanes[j].yTop += delta;
      layout.lanes[j].yBot += delta;
    }
    for (const n of layout.nodes) {
      if (n.phase > i) n.y += delta;
    }
    for (const e of layout.edges) {
      for (const p of e.points) {
        if (p.y > cut) (p as { y: number }).y += delta;
      }
    }
    total += delta;
  }
  layout.height += total;
}

/**
 * Snap adjacent lane bands together so the swimlane table reads as one
 * continuous table with NO gaps between rows. The graph flow leaves a small,
 * uneven gap between consecutive phases (some of `LANE_GAP_CROSS`/`STACK_GAP`
 * that neither band's stripe covers); this moves every interior boundary to the
 * midpoint of that gap, so row `i`'s bottom meets row `i+1`'s top exactly.
 *
 * Purely cosmetic and safe: only the painted band bounds move, and only OUTWARD
 * into the gaps — a band can grow but never shrinks below its label cell — while
 * nodes, edges, and the table's outer top/bottom are untouched, so
 * `layout.height` is unchanged.
 */
export function closeLaneGaps(layout: Layout): void {
  for (let i = 0; i < layout.lanes.length - 1; i++) {
    const a = layout.lanes[i];
    const b = layout.lanes[i + 1];
    const mid = (a.yBot + b.yTop) / 2;
    a.yBot = mid;
    b.yTop = mid;
  }
}
