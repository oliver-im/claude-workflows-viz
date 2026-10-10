import { W } from "./svg-primitives.js";
import type { Meta } from "./model.js";
import {
  CARD_PAD_X,
  type CardInput,
  type CardSpec,
  DECK_DEPTH,
  DECK_STEP,
  agentCard,
  cardAtWidth,
  equalizeHeights,
  rowCardWidth,
} from "./node-card.js";
import { textWidth } from "./text-metrics.js";
import { modelFamily } from "./theme.js";
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
import type { ControlArc, GEdge, GEdgeKind, GFrame, GLane, GNode, LaneMember, Layout } from "./topo-geometry.js";

/**
 * The focused swimlane placement: an analyzer `Topology` tree (+ `Meta` for
 * phase models) → a positioned `Layout`. ONE graph laid out as a whole, flowed
 * top→down; phases become rows derived from where each shape's nodes land — not
 * containers the flow has to break out of. Because the hard parts of general DAG
 * layout exist to solve generality, and workflows are phase-ordered + small + a
 * known sub-shape vocabulary, placement is driven by phase order + per-shape
 * templates — no cycle-break, ranking, or crossing-minimisation, and zero new deps.
 *
 * Nodes are measured cards (see `node-card.ts`), and every edge is orthogonal:
 * each template knows exactly where its rails, drops, and joins run, so routing
 * needs no general edge router either.
 *
 * Total function by contract: it never throws on a weird-but-valid tree — an
 * unhandled shape degrades to an honest "task" placeholder node, and a body
 * with no phases still gets one lane. Determinism: nodes/edges/frames are
 * emitted in tree order; ids are a stable counter.
 */
export interface PlaceOptions {
  /** Show prompt-sliced (derived) agent labels on cards. The workflow view
   *  leaves them off — the phase row beside each node names it — while the
   *  graph-only topology view, which has no rows, shows them. */
  derivedLabels?: boolean;
}

export function placeTopology(topology: Topology, meta: Meta, opts: PlaceOptions = {}): Layout {
  const { lanes, titleToLane } = buildLanes(topology, meta);
  const laneOf = (phase: string | null): number =>
    phase !== null && titleToLane.has(phase) ? (titleToLane.get(phase) as number) : 0;

  const ctx: Ctx = {
    nodes: [],
    edges: [],
    frames: [],
    controlArcs: [],
    claimedGuards: new Set(),
    guardFrame: new Map(),
    notes: [],
    idSeq: 0,
    laneOf,
    derivedLabels: opts.derivedLabels === true,
  };

  // Flow top-level steps top→down. Empty bands between consecutive shapes (and
  // trailing) collapse to slim strips the graph simply flows past. Because the
  // body calls phase() in order, top-level step bands are non-decreasing, so a
  // band strictly between the last-covered band and the next shape's band is
  // genuinely empty — no later shape can reach back up to fill it. Entering a
  // new lane leaves room above its first node; continuing one keeps a tight gap.
  let y = LANE_HEADER_H;
  let prevExits: string[] = [];
  let prevBreaks: string[] = [];
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
    wireBreaks(ctx, prevBreaks, placed.entry);
    y = placed.bottom;
    prevExits = placed.exits;
    prevBreaks = placed.pendingBreaks ?? [];
    prevBand = Math.max(prevBand, placed.maxBand);
    placedAny = true;
  }
  for (let idx = prevBand + 1; idx < lanes.length; idx++) {
    y += gapInto(idx);
    const isTrailingTerminal = placedAny && idx === lanes.length - 1;
    if (isTrailingTerminal) {
      const terminal = placeTerminal(ctx, y, idx);
      for (const exit of prevExits) connect(ctx, exit, terminal.entry, "seq");
      wireBreaks(ctx, prevBreaks, terminal.entry); // a break with no real successor exits to "end"
      y = terminal.bottom;
      prevExits = terminal.exits;
      prevBreaks = [];
    } else {
      y = stripLane(lanes[idx], y);
    }
    prevBand = idx;
    placedAny = true;
  }

  // A break with nowhere left to go — its loop ends the workflow — still exits:
  // to a final node, so the jump is never silently dropped.
  if (prevBreaks.length > 0) {
    const terminal = placeTerminal(ctx, y + STACK_GAP, Math.max(0, prevBand), "The workflow ends here.");
    for (const exit of prevExits) connect(ctx, exit, terminal.entry, "seq");
    wireBreaks(ctx, prevBreaks, terminal.entry);
  }

  placeFrameHeaders(ctx);
  deriveLaneRanges(lanes, ctx.nodes, ctx.frames);
  fixupUnsetLanes(lanes);
  const height = pageHeight(lanes, ctx.nodes, ctx.frames);
  return {
    width: W,
    height,
    lanes,
    nodes: ctx.nodes,
    edges: ctx.edges,
    frames: ctx.frames,
    controlArcs: ctx.controlArcs,
    notes: ctx.notes,
  };
}

// ---------------------------------------------------------------------------
// Geometry constants — single place. A restyle is a constant swap here, never
// logic surgery; tests key off these names rather than literals.
// ---------------------------------------------------------------------------

/** The vertical centerline the graph flows down. */
export const SPINE_X = Math.round(W * 0.4);
/** A hub is a bare junction point: the fork a fan-out rail leaves from, or the
 *  stand-in for an empty branch arm. It has no drawn extent. */
export const HUB_R = 0;
/** Decision diamond half-diagonal. */
export const DIAMOND_HALF = 10;
/** Task/opaque box height and minimum width; a sub-workflow card is two lines. */
export const TASK_H = 30;
export const SUBFLOW_H = 40;
export const TASK_MIN_W = 96;
/** Room above a lane's first element, below the row's top edge. */
export const LANE_HEADER_H = 20;
/** Room below a lane's last element, above the row's bottom edge. */
export const LANE_PAD = 16;
/** Gap between stacked top-level shapes in the SAME lane. */
export const STACK_GAP = 24;
/** Gap when the flow crosses into a NEW lane. */
export const LANE_GAP_CROSS = LANE_HEADER_H + LANE_PAD + 4;
/** Slim height of an empty / control-only phase strip. */
export const STRIP_H = 30;
/** Drop from a fork's rail down to the cards it fans to, and from a join bar
 *  down to whatever follows. */
export const FAN_GAP = 20;
/** Gap from a row's card bottoms down to the join bar they drop onto. */
export const JOIN_GAP = 16;
/** Vertical gap between sequential steps inside a chain (arm / loop body). */
export const INNER_GAP = 22;
/** Vertical gap between pipeline stage rows. */
export const STAGE_GAP = 28;
/** Join bar thickness, and how far it reaches past the outer lanes. */
export const BARRIER_H = 4;
export const JOIN_OVERHANG = 12;
/** Horizontal gap between cards in a row. */
export const ROW_GAP = 16;
/** A row of members/columns must fit this width or it collapses to ×N. */
export const MAX_ROW_W = 600;
/** Horizontal separation between stacked branch / parallel arms (off the spine,
 *  so a connector to a lower arm never passes through an upper one). */
export const ARM_DX = 150;
/** A literal-count fan-out wider than this draws as ×N rather than N cards. */
export const ROW_CAP = 6;
/** A loop frame's header band (the verbatim condition) above its body, the
 *  frame's inner padding, the extra left lane a continue/break arc runs in, and
 *  the row a continue arc re-enters its body through. */
export const FRAME_HEAD = 30;
export const FRAME_PAD = 14;
export const ARC_LANE = 22;
export const ARC_ROW = 18;
/** How far a guard's self-loop (`continue` back to itself) swings left of the diamond. */
export const SELF_LOOP_DX = 20;
/** Final node (◉) radius — the workflow ends here. */
export const TERMINAL_R = 9;
/** Where an orthogonal connector turns: this far above the node it enters. */
export const ELBOW = 14;
/** Mono condition text set beside a decision diamond, and its gap from it. */
export const COND_FONT = { size: 11, mono: true } as const;
export const COND_GAP = 8;
/** Loop frame header typography (keyword sans-bold, condition mono). */
export const FRAME_KEYWORD_FONT = { size: 11, weight: 700 } as const;
export const FRAME_COND_FONT = { size: 11, mono: true } as const;
/** Width of the loop glyph + gap drawn before a frame's keyword. */
export const FRAME_ICON_W = 16;

// ---------------------------------------------------------------------------
// Placement context + node/edge helpers
// ---------------------------------------------------------------------------

interface Ctx {
  nodes: GNode[];
  edges: GEdge[];
  frames: GFrame[];
  controlArcs: ControlArc[];
  /** Guard diamonds already wired to a control arc — so a loop nested inside
   *  another doesn't let the outer loop re-claim a guard the inner already owns. */
  claimedGuards: Set<string>;
  /** The frame of the loop each claimed `break` guard belongs to — its arc is
   *  wired later, by the chain that places the loop's successor. */
  guardFrame: Map<string, string>;
  notes: string[];
  idSeq: number;
  laneOf: (phase: string | null) => number;
  derivedLabels: boolean;
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
  /** `break` guards inside this sub-graph whose forward exit arc still needs a
   *  target — the loop's successor, which the enclosing chain places next and
   *  wires (continue resolves in `placeLoop`; break can't, since its target does
   *  not exist yet). Propagated up until a chain connects this onward. */
  pendingBreaks?: string[];
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

/** Half a node's layout height — center to the top/bottom anchor an edge attaches to. */
function halfHeight(n: GNode): number {
  switch (n.kind) {
    case "hub":
      return 0;
    case "decision":
      return DIAMOND_HALF;
    default:
      return (n.h ?? 2 * n.r) / 2;
  }
}

/** A fork junction (rail source) or a stub (an empty arm's pass-through point). */
function addHub(ctx: Ctx, x: number, y: number, band: number, fork: boolean): GNode {
  return addNode(ctx, { kind: "hub", x, y, r: HUB_R, label: "", phase: band, ...(fork ? { fork: true } : {}) });
}

/**
 * The orthogonal route of a downward connector between two placed nodes:
 *   - onto a join bar: a straight drop at the source's own x;
 *   - same x: a straight vertical;
 *   - out of a fork: along the rail first, then down into the target;
 *   - into a hub: down first, then across into the junction;
 *   - otherwise: down, across just above the target (`ELBOW`), then down.
 */
function route(a: GNode, b: GNode): Array<{ x: number; y: number }> {
  const ay = a.y + halfHeight(a);
  const by = b.y - halfHeight(b);
  if (b.kind === "barrier") return [{ x: a.x, y: ay }, { x: a.x, y: by }];
  if (Math.abs(a.x - b.x) < 0.5) return [{ x: a.x, y: ay }, { x: a.x, y: by }];
  if (a.kind === "hub" && a.fork === true) return [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: by }];
  if (b.kind === "hub") return [{ x: a.x, y: ay }, { x: a.x, y: b.y }, { x: b.x, y: b.y }];
  const ym = Math.max(ay + (by - ay) / 2, by - ELBOW);
  return [{ x: a.x, y: ay }, { x: a.x, y: ym }, { x: b.x, y: ym }, { x: b.x, y: by }];
}

/** A downward sequential connector from one node's bottom anchor to another's top. */
function connect(ctx: Ctx, fromId: string, toId: string, kind: GEdgeKind, label?: string): void {
  ctx.edges.push({
    from: fromId,
    to: toId,
    points: route(byId(ctx, fromId), byId(ctx, toId)),
    kind,
    ...(label !== undefined ? { label } : {}),
  });
}

/** An edge with explicit points (a branch arm leaving a diamond's side vertex). */
function pushEdge(
  ctx: Ctx,
  fromId: string,
  toId: string,
  points: Array<{ x: number; y: number }>,
  kind: GEdgeKind,
  label?: string,
): void {
  ctx.edges.push({ from: fromId, to: toId, points, kind, ...(label !== undefined ? { label } : {}) });
}

/** Resolve pending `break` guards onto the loop's successor `toId` — a forward
 *  exit arc per gate. Called when a chain connects a loop onward to the node the
 *  break jumps to. */
function wireBreaks(ctx: Ctx, gateIds: string[], toId: string): void {
  for (const id of gateIds) {
    const gate = byId(ctx, id);
    const frame = ctx.guardFrame.get(id);
    ctx.controlArcs.push({
      fromId: id,
      toId,
      flow: "break",
      outcome: gate.guardOutcome ?? "yes",
      ...(frame !== undefined ? { frame } : {}),
    });
  }
}

/** Where the context's arrays stood before a sub-graph was placed. */
interface Marks {
  n: number;
  e: number;
  f: number;
}

function marks(ctx: Ctx): Marks {
  return { n: ctx.nodes.length, e: ctx.edges.length, f: ctx.frames.length };
}

/** Shift what was created between two marks horizontally by `dx`. */
function shiftRange(ctx: Ctx, from: Marks, to: Marks, dx: number): void {
  if (dx === 0) return;
  for (let i = from.n; i < to.n; i++) ctx.nodes[i].x += dx;
  for (let i = from.e; i < to.e; i++) {
    for (const p of ctx.edges[i].points) (p as { x: number }).x += dx;
  }
  for (let i = from.f; i < to.f; i++) {
    const f = ctx.frames[i];
    f.x0 += dx;
    f.x1 += dx;
    f.headerX += dx;
  }
}

/** Slide everything created since the given marks down by `dy`. */
function shiftDown(ctx: Ctx, n0: number, e0: number, f0: number, dy: number): void {
  for (let i = n0; i < ctx.nodes.length; i++) ctx.nodes[i].y += dy;
  for (let i = e0; i < ctx.edges.length; i++) {
    for (const p of ctx.edges[i].points) (p as { y: number }).y += dy;
  }
  for (let i = f0; i < ctx.frames.length; i++) {
    ctx.frames[i].y0 += dy;
    ctx.frames[i].y1 += dy;
  }
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** The card input for one agent call — the label shown only when authored (or
 *  when the view shows derived labels), the model's short family name. */
type CardAgent = Pick<AgentStep, "label" | "labelExplicit" | "model" | "effort" | "agentType" | "unread">;

function cardInput(
  ctx: Ctx,
  a: CardAgent,
  over: { label?: string; mult?: string; hint?: string } = {},
): CardInput {
  const label = over.label ?? a.label;
  const family = a.model !== undefined ? modelFamily(a.model) : undefined;
  return {
    ...(a.labelExplicit || ctx.derivedLabels ? { label } : {}),
    derived: !a.labelExplicit,
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(family !== undefined ? { modelShort: family } : {}),
    ...(a.agentType !== undefined ? { agentType: a.agentType } : {}),
    ...(a.effort !== undefined ? { effort: a.effort } : {}),
    ...(a.unread !== undefined ? { unread: a.unread } : {}),
    ...(over.mult !== undefined ? { mult: over.mult } : {}),
    ...(over.hint !== undefined ? { hint: over.hint } : {}),
  };
}

/** Place an agent card with its top edge at `top`. */
function addCard(
  ctx: Ctx,
  x: number,
  top: number,
  card: CardSpec,
  a: CardAgent,
  band: number,
  extra: Partial<GNode> = {},
): GNode {
  return addNode(ctx, {
    kind: "agent",
    x,
    y: top + card.h / 2,
    r: card.h / 2,
    w: card.w,
    h: card.h,
    card,
    label: a.label,
    labelExplicit: a.labelExplicit,
    phase: band,
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(a.effort !== undefined ? { effort: a.effort } : {}),
    ...(a.agentType !== undefined ? { agentType: a.agentType } : {}),
    ...(a.unread !== undefined ? { unread: a.unread } : {}),
    ...(card.mult !== undefined ? { mult: card.mult } : {}),
    ...extra,
  });
}

/** A join bar across `xs` (at least `minW` wide) with its top edge at `top`. */
function addJoin(ctx: Ctx, xs: number[], top: number, band: number, minW = 0): GNode {
  const at = xs.length > 0 ? xs : [SPINE_X];
  const lo = Math.min(...at);
  const hi = Math.max(...at);
  const w = Math.max(hi - lo + 2 * JOIN_OVERHANG, minW);
  return addNode(ctx, {
    kind: "barrier",
    x: (lo + hi) / 2,
    y: top + BARRIER_H / 2,
    r: BARRIER_H / 2,
    w,
    h: BARRIER_H,
    label: "",
    phase: band,
  });
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
      return placeTask(step.label, ctx, topY, ctx.laneOf(step.phase), "workflow", multBadge(step.multiplicity));
    case "opaque":
      return placeTask(step.label, ctx, topY, ctx.laneOf(step.phase), "opaque");
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
      return placeTask(`[${(step as Step).kind}]`, ctx, topY, ctx.laneOf((step as Step).phase), "opaque");
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
  let prevBreaks: string[] = [];
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
    wireBreaks(ctx, prevBreaks, placed.entry); // this step is the prior loop's break target
    prevExits = placed.exits;
    prevBreaks = placed.pendingBreaks ?? [];
    y = placed.bottom + INNER_GAP;
    prevBand = placed.maxBand;
    top = Math.min(top, placed.top);
    bottom = Math.max(bottom, placed.bottom);
    minBand = Math.min(minBand, placed.minBand);
    maxBand = Math.max(maxBand, placed.maxBand);
  }
  return {
    entry: entry as string,
    exits: prevExits,
    top,
    bottom,
    minBand,
    maxBand,
    ...(prevBreaks.length > 0 ? { pendingBreaks: prevBreaks } : {}),
  };
}

// ---------------------------------------------------------------------------
// Parallel — fan-out (one body × N) and branches (k distinct chains).
// ---------------------------------------------------------------------------

/**
 * A `.map` fan-out: a fork whose rail drops into a centered row of N member
 * cards, then a join bar every member drops onto — `parallel()` is a barrier, so
 * the flow leaves from the bar, and EVERY member has an onward edge (no dangling
 * fan). Width-bounded: a row that cannot fit even with two-line labels, or an
 * unknown/over-cap count, collapses to a single ×N stack (logged), never
 * silently truncated. The lone stack still waits at a join bar.
 */
function placeFanout(step: ParallelStep & { form: "fanout" }, ctx: Ctx, topY: number): Placed {
  const band = cellBand(step, ctx);
  const single = step.body.length === 1 && step.body[0].kind === "agent" ? (step.body[0] as AgentStep) : null;
  if (single === null) return placeFanoutBody(step, ctx, topY);
  const base = single;
  let members = fanMembers(step, single);

  let rowW: number | undefined;
  if (members.labels.length > 1) {
    const inputs = members.labels.map((label) => cardInput(ctx, base, { label }));
    rowW = rowCardWidth(inputs, inputs.length, MAX_ROW_W, ROW_GAP);
    if (rowW === undefined) {
      const badge = fanBadge(step.multiplicity);
      note(ctx, `fan-out of ${members.labels.length} drawn as ${badge} (row exceeds width)`);
      members = { labels: [base.label], badge };
    }
  }

  if (members.labels.length === 1) {
    const card = agentCard(
      cardInput(ctx, base, { label: members.labels[0], mult: members.badge, hint: members.hint }),
    );
    const n = addCard(ctx, SPINE_X, topY, card, base, band, { label: members.labels[0] });
    if (members.badge === undefined) {
      return { entry: n.id, exits: [n.id], top: topY, bottom: topY + card.h, minBand: band, maxBand: band };
    }
    const join = addJoin(ctx, [SPINE_X], topY + card.h + JOIN_GAP, band, card.w + 2 * JOIN_OVERHANG);
    connect(ctx, n.id, join.id, "merge");
    return { entry: n.id, exits: [join.id], top: topY, bottom: join.y + BARRIER_H / 2, minBand: band, maxBand: band };
  }

  const w = rowW as number;
  const xs = rowCenters(members.labels.length, w + ROW_GAP, SPINE_X);
  const fork = addHub(ctx, SPINE_X, topY, band, true);
  const rowTop = topY + FAN_GAP;
  let rowBottom = rowTop;
  const cards = equalizeHeights(members.labels.map((label) => cardAtWidth(cardInput(ctx, base, { label }), w)));
  const memberIds = members.labels.map((label, i) => {
    const card = cards[i];
    const n = addCard(ctx, xs[i], rowTop, card, base, band, { label });
    rowBottom = Math.max(rowBottom, rowTop + card.h);
    connect(ctx, fork.id, n.id, "fan");
    return n.id;
  });
  const join = addJoin(ctx, xs, rowBottom + JOIN_GAP, band);
  for (const id of memberIds) connect(ctx, id, join.id, "merge");
  return { entry: fork.id, exits: [join.id], top: topY, bottom: join.y + BARRIER_H / 2, minBand: band, maxBand: band };
}

/**
 * A fan-out whose body is not one agent call — several steps, a sub-workflow, a
 * loop — draws its body ONCE, as its own chain: the analyzer marks every step in
 * it with the fan-out's multiplicity, so each card is a stack. Then the join, as
 * for any `parallel()`. Never a stand-in card that names an agent the body
 * doesn't have.
 */
function placeFanoutBody(step: ParallelStep & { form: "fanout" }, ctx: Ctx, topY: number): Placed {
  const band = cellBand(step, ctx);
  const from = marks(ctx);
  const body = placeChain(step.body, ctx, topY) ?? placeTask("(empty fan-out body)", ctx, topY, band, "opaque");
  if (step.body.length > 1) note(ctx, `fan-out body of ${step.body.length} steps drawn once, each card a stack`);
  const box = contentBox(ctx, from);
  const join = addJoin(
    ctx,
    body.exits.map((id) => byId(ctx, id).x),
    body.bottom + JOIN_GAP,
    body.maxBand,
    Math.min(box.maxX - box.minX, MAX_ROW_W),
  );
  for (const exit of body.exits) connect(ctx, exit, join.id, "merge");
  return {
    entry: body.entry,
    exits: [join.id],
    top: topY,
    bottom: join.y + BARRIER_H / 2,
    minBand: body.minBand,
    maxBand: body.maxBand,
    ...(body.pendingBreaks ? { pendingBreaks: body.pendingBreaks } : {}),
  };
}

interface FanMembers {
  labels: string[];
  badge?: string;
  hint?: string;
}

/** Resolve a fan-out's drawn members from its literal multiplicity (honest
 *  counts only); unknown/over-cap counts become a single ×N representative. */
function fanMembers(step: ParallelStep & { form: "fanout" }, single: AgentStep): FanMembers {
  const baseLabel = single.label;
  const m = step.multiplicity;
  if (m.kind === "named") return { labels: single.expandedLabels ?? m.names.map((n) => `${baseLabel}:${n}`) };
  if (m.kind === "exact" && m.count <= ROW_CAP) {
    return { labels: Array.from({ length: Math.max(1, m.count) }, () => baseLabel) };
  }
  return { labels: [baseLabel], badge: fanBadge(m), ...(m.kind === "unknown" && m.hint ? { hint: m.hint } : {}) };
}

/**
 * Parallel branches (k distinct thunks): a fork whose rail drops to each arm;
 * every arm rejoins a shared join bar. Two layouts:
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
  if (step.branches.length === 0) {
    note(ctx, "parallel() with no branches drawn as a pass-through");
    return placeChainStub(ctx, topY, ctx.laneOf(step.phase));
  }
  const armBands = step.branches.map((arm) => (arm.length > 0 ? ctx.laneOf(arm[0].phase) : ctx.laneOf(step.phase)));
  const oneLane = armBands.every((b) => b === armBands[0]);
  const simpleArms = step.branches.every((arm) => arm.length <= 1);
  return oneLane && simpleArms
    ? placeBranchesRow(step, ctx, topY, armBands[0] ?? ctx.laneOf(step.phase))
    : placeBranchesStacked(step, ctx, topY, armBands);
}

/** One placed arm: its connection surface and the range of the context it drew. */
interface PlacedArm {
  placed: Placed;
  from: Marks;
  to: Marks;
}

/**
 * Spread placed arms into columns that clear each other: each column is as wide
 * as the widest arm ACTUALLY drew (a branch's side column, a loop frame, a row of
 * cards — not just its head), and each arm is centered in its own.
 */
function packArms(ctx: Ctx, arms: PlacedArm[]): void {
  const boxes = arms.map((a) => contentBox(ctx, a.from, a.to));
  const colW = Math.max(ARM_DX, ...boxes.map((b) => b.maxX - b.minX + ROW_GAP));
  const centers = rowCenters(arms.length, colW, SPINE_X);
  arms.forEach((a, i) => shiftRange(ctx, a.from, a.to, Math.round(centers[i] - (boxes[i].minX + boxes[i].maxX) / 2)));
}

/** The fork's fan edges, the join under every arm exit, and the shared surface. */
function joinArms(
  ctx: Ctx,
  fork: GNode,
  arms: PlacedArm[],
  top: number,
  band: number,
  bands: { minBand: number; maxBand: number },
): Placed {
  const exits = arms.flatMap((a) => a.placed.exits);
  for (const a of arms) connect(ctx, fork.id, a.placed.entry, "fan");
  const join = addJoin(
    ctx,
    [...arms.map((a) => byId(ctx, a.placed.entry).x), ...exits.map((id) => byId(ctx, id).x)],
    top,
    band,
  );
  for (const exit of exits) connect(ctx, exit, join.id, "merge");
  const breaks = arms.flatMap((a) => a.placed.pendingBreaks ?? []);
  return {
    entry: fork.id,
    exits: [join.id],
    top: fork.y,
    bottom: join.y + BARRIER_H / 2,
    ...bands,
    ...(breaks.length > 0 ? { pendingBreaks: breaks } : {}),
  };
}

/** Arms as side-by-side columns in one shared lane (see `placeBranches`). */
function placeBranchesRow(
  step: ParallelStep & { form: "branches" },
  ctx: Ctx,
  topY: number,
  band: number,
): Placed {
  const fork = addHub(ctx, SPINE_X, topY, band, true);
  const armTopY = topY + FAN_GAP;
  const arms: PlacedArm[] = step.branches.map((arm) => {
    const from = marks(ctx);
    const placed = placeChain(arm, ctx, armTopY) ?? placeChainStub(ctx, armTopY, band);
    return { placed, from, to: marks(ctx) };
  });
  packArms(ctx, arms);
  const bottom = arms.reduce((m, a) => Math.max(m, a.placed.bottom), armTopY);
  return joinArms(ctx, fork, arms, bottom + JOIN_GAP, band, {
    minBand: Math.min(band, ...arms.map((a) => a.placed.minBand)),
    maxBand: Math.max(band, ...arms.map((a) => a.placed.maxBand)),
  });
}

/** Arms stacked down their own lanes, each in its own column (see `placeBranches`). */
function placeBranchesStacked(
  step: ParallelStep & { form: "branches" },
  ctx: Ctx,
  topY: number,
  armBands: number[],
): Placed {
  const headBand = Math.min(...armBands);
  const fork = addHub(ctx, SPINE_X, topY, headBand, true);
  let y = topY + FAN_GAP;
  let prevEndBand = -1;
  const arms: PlacedArm[] = step.branches.map((arm, i) => {
    if (prevEndBand !== -1 && armBands[i] !== prevEndBand) y += LANE_HEADER_H;
    const from = marks(ctx);
    const placed = placeChain(arm, ctx, y) ?? placeChainStub(ctx, y, armBands[i]);
    y = placed.bottom + INNER_GAP;
    prevEndBand = placed.maxBand;
    return { placed, from, to: marks(ctx) };
  });
  packArms(ctx, arms);
  // The join sits under the last arm, in the lowest lane any arm reached.
  const maxBand = Math.max(...arms.map((a) => a.placed.maxBand));
  return joinArms(ctx, fork, arms, y - INNER_GAP + JOIN_GAP, maxBand, {
    minBand: Math.min(headBand, ...arms.map((a) => a.placed.minBand)),
    maxBand,
  });
}

/** A bare junction standing in for an empty branch/parallel arm: edges pass
 *  straight through it, so the arm reads as a skip around its sibling. */
function placeChainStub(ctx: Ctx, topY: number, band: number): Placed {
  const n = addHub(ctx, SPINE_X, topY, band, false);
  return { entry: n.id, exits: [n.id], top: n.y, bottom: n.y, minBand: band, maxBand: band };
}

// ---------------------------------------------------------------------------
// Pipeline — N item columns × stage rows; stage edges span lanes directly.
// ---------------------------------------------------------------------------

/**
 * `pipeline(items, ...stages)`: each item threads independently through every
 * stage (no barrier between stages). Drawn as a grid — one column per item, one
 * row per stage — with a fork rail dropping into each column's first cell, and a
 * join bar the last cells drop onto: `await pipeline(…)` resolves once every item
 * is done. Stage rows sit in their own phase lanes, so a `stage` edge that
 * crosses phases is just a short vertical here. Columns collapse to a single ×N
 * column when unknown / over-cap / over-wide; every cell in it is a ×N stack.
 */
function placePipeline(step: PipelineStep, ctx: Ctx, topY: number): Placed {
  if (step.stages.length === 0) {
    note(ctx, "pipeline() with no stages drawn as an opaque step");
    return placeTask("pipeline(…)", ctx, topY, ctx.laneOf(step.phase), "opaque");
  }
  const stageBands = step.stages.map((stage) => (stage.length > 0 ? cellBand(stage[0], ctx) : ctx.laneOf(step.phase)));
  const headBand = stageBands.length > 0 ? stageBands[0] : ctx.laneOf(step.phase);
  const cols = pipelineColumns(step, ctx);
  const specs = step.stages.map((stage, s) =>
    equalizeCells(Array.from({ length: cols.count }, (_, c) => stageCellSpec(stage, ctx, c, s, cols))),
  );

  const fork = addHub(ctx, SPINE_X, topY, headBand, true);
  const xs = rowCenters(cols.count, cols.w + ROW_GAP, SPINE_X);

  // Each stage row's top y, with headroom where a row changes lane.
  const rowTops: number[] = [];
  let rowY = topY + FAN_GAP;
  for (let s = 0; s < step.stages.length; s++) {
    if (s > 0 && stageBands[s] !== stageBands[s - 1]) rowY += LANE_HEADER_H;
    rowTops.push(rowY);
    rowY += specs[s].reduce((m, cell) => Math.max(m, cell.h), 0) + STAGE_GAP;
  }

  const colExits: string[] = [];
  let lastBottom = topY + FAN_GAP;
  for (let c = 0; c < cols.count; c++) {
    let prevExit: string | null = null;
    let colEntry: string | null = null;
    for (let s = 0; s < step.stages.length; s++) {
      const cell = placeStageCell(ctx, xs[c], rowTops[s], specs[s][c]);
      if (colEntry === null) colEntry = cell.id;
      if (prevExit !== null) connect(ctx, prevExit, cell.id, "stage");
      prevExit = cell.id;
      lastBottom = Math.max(lastBottom, cell.y + halfHeight(cell));
    }
    connect(ctx, fork.id, colEntry as string, "fan");
    colExits.push(prevExit as string);
  }

  const tailBand = stageBands.length > 0 ? stageBands[stageBands.length - 1] : headBand;
  const join = addJoin(ctx, xs, lastBottom + JOIN_GAP, tailBand, cols.count === 1 ? cols.w + 2 * JOIN_OVERHANG : 0);
  for (const exit of colExits) connect(ctx, exit, join.id, "merge");
  return {
    entry: fork.id,
    exits: [join.id],
    top: topY,
    bottom: join.y + BARRIER_H / 2,
    minBand: Math.min(headBand, ...stageBands),
    maxBand: Math.max(headBand, ...stageBands),
  };
}

interface PipelineCols {
  count: number;
  /** Uniform card width of every cell. */
  w: number;
  badge?: string;
  hint?: string;
}

/** The card a pipeline cell draws (for an agent or nested fan-out stage). */
interface StageCell {
  kind: "agent" | "hub" | "task";
  h: number;
  card?: CardSpec;
  agent?: CardAgent;
  band: number;
  label: string;
}

/** The card input of stage `s`'s cell in column `c` (before a width is chosen). */
function stageCellInput(stage: Step[], ctx: Ctx, c: number, s: number, cols: Omit<PipelineCols, "w">): CardInput | null {
  const head = stage[0];
  if (head?.kind === "agent") {
    const own = multBadge(head.multiplicity);
    const ownHint = head.multiplicity.kind === "unknown" ? head.multiplicity.hint : undefined;
    const mult = own ?? cols.badge;
    const hint = own !== undefined ? ownHint : s === 0 ? cols.hint : undefined;
    return cardInput(ctx, head, {
      label: head.expandedLabels?.[c] ?? head.label,
      ...(mult !== undefined ? { mult } : {}),
      ...(hint !== undefined ? { hint } : {}),
    });
  }
  const inner =
    head?.kind === "parallel" && head.form === "fanout" && head.body.length === 1 && head.body[0].kind === "agent"
      ? (head.body[0] as AgentStep)
      : null;
  if (head?.kind === "parallel" && head.form === "fanout" && inner) {
    const m = head.multiplicity;
    return cardInput(ctx, inner, {
      mult: fanBadge(m),
      ...(m.kind === "unknown" && m.hint ? { hint: m.hint } : {}),
    });
  }
  return null;
}

/** Column count from the items multiplicity (literal-only); collapse unknown/
 *  over-cap/over-wide to one ×N representative column. */
function pipelineColumns(step: PipelineStep, ctx: Ctx): PipelineCols {
  const m = step.items;
  const collapsed = (): PipelineCols => {
    const badge = fanBadge(m);
    const hint = m.kind === "unknown" ? m.hint : undefined;
    const inputs = step.stages
      .map((stage, s) => stageCellInput(stage, ctx, 0, s, { count: 1, badge, ...(hint ? { hint } : {}) }))
      .filter((x): x is CardInput => x !== null);
    const w = inputs.reduce((mw, input) => Math.max(mw, agentCard(input).w), 0);
    return { count: 1, w: Math.max(w, TASK_MIN_W), badge, ...(hint ? { hint } : {}) };
  };
  let count: number;
  if (m.kind === "named") count = m.names.length;
  else if (m.kind === "exact" && m.count <= ROW_CAP) count = Math.max(1, m.count);
  else return collapsed();

  const inputs = step.stages.flatMap((stage, s) =>
    Array.from({ length: count }, (_, c) => stageCellInput(stage, ctx, c, s, { count })).filter(
      (x): x is CardInput => x !== null,
    ),
  );
  const cardW = inputs.length > 0 ? rowCardWidth(inputs, count, MAX_ROW_W, ROW_GAP) : TASK_MIN_W;
  // A task cell (a stage shape no card can stand for) needs its own width too.
  const taskW = step.stages.reduce((m, stage) => {
    const head = stage[0];
    if (head === undefined || stageCellInput(stage, ctx, 0, 0, { count }) !== null) return m;
    return Math.max(m, taskWidth("label" in head ? (head as { label: string }).label : `[${head.kind}]`, "opaque"));
  }, 0);
  const w = cardW === undefined ? undefined : Math.max(cardW, taskW);
  if (w === undefined || count * w + (count - 1) * ROW_GAP > MAX_ROW_W) {
    note(ctx, `pipeline of ${count} items drawn as ${fanBadge(m)} (row exceeds width)`);
    return collapsed();
  }
  return { count, w };
}

/** Equal drawn heights across one stage row's agent cards. */
function equalizeCells(cells: StageCell[]): StageCell[] {
  const cards = cells.filter((c) => c.card !== undefined).map((c) => c.card as CardSpec);
  if (cards.length < 2) return cells;
  const even = equalizeHeights(cards);
  let k = 0;
  return cells.map((c) => (c.card === undefined ? c : { ...c, card: even[k], h: even[k++].h }));
}

/** Lay out one pipeline cell at the columns' shared width. */
function stageCellSpec(stage: Step[], ctx: Ctx, c: number, s: number, cols: PipelineCols): StageCell {
  if (stage.length > 1) note(ctx, "pipeline stage with multiple steps drawn as its head");
  const head = stage[0];
  if (head === undefined) return { kind: "hub", h: 0, band: 0, label: "" };
  const band = cellBand(head, ctx);
  const input = stageCellInput(stage, ctx, c, s, cols);
  if (input !== null) {
    const card = cardAtWidth(input, cols.w);
    const agent = head.kind === "agent" ? head : ((head as ParallelStep & { form: "fanout" }).body[0] as AgentStep);
    return { kind: "agent", h: card.h, card, agent, band, label: input.label ?? agent.label };
  }
  // Any other nested shape in a stage cell → an honest task blob + a note.
  note(ctx, `pipeline stage shape '${head.kind}' drawn as a task node`);
  const label = "label" in head ? (head as { label: string }).label : `[${head.kind}]`;
  return { kind: "task", h: TASK_H, band, label };
}

/** Place one pipeline cell (a stage's representative node) at (x, top). Corpus
 *  stages are single steps; a multi-step stage is summarized to its head + a
 *  note, and a nested fan-out collapses to a ×N stack in the cell. */
function placeStageCell(ctx: Ctx, x: number, top: number, cell: StageCell): GNode {
  if (cell.kind === "hub") return addHub(ctx, x, top, 0, false);
  if (cell.kind === "agent" && cell.card && cell.agent) {
    // A cell's label is the per-column expansion, not the template.
    return addCard(ctx, x, top, cell.card, cell.agent, cell.band, { label: cell.label });
  }
  const w = Math.min(MAX_ROW_W, taskWidth(cell.label, "opaque"));
  return addNode(ctx, {
    kind: "task",
    task: "opaque",
    x,
    y: top + TASK_H / 2,
    r: TASK_H / 2,
    w,
    h: TASK_H,
    label: cell.label,
    phase: cell.band,
  });
}

// ---------------------------------------------------------------------------
// Branch — a quiet decision diamond fanning to each arm (all arms shown).
// ---------------------------------------------------------------------------

/**
 * A loop-control GUARD: `if (cond) continue;` / `break;` / `return;` — one arm is
 * purely abrupt-flow control, the other empty. The diamond is real, but it's
 * plumbing for the surrounding loop, not its purpose.
 */
function isControlGuard(step: BranchStep): boolean {
  const abrupt = new Set(["continue", "break", "return", "throw"]);
  const onlyControl = (arm: Step[]): boolean =>
    arm.length > 0 && arm.every((s) => s.kind === "control" && abrupt.has((s as ControlStep).flow ?? ""));
  return (
    (onlyControl(step.thenSteps) && step.elseSteps.length === 0) ||
    (onlyControl(step.elseSteps) && step.thenSteps.length === 0)
  );
}

/**
 * If `step` is a guard whose taken arm is exactly a `continue`/`break` (the other
 * arm empty), reports that flow, the triggering outcome, and the straight-through
 * arm. Such a guard draws its abrupt jump as a coral ARC — `continue` back to the
 * top of the loop body (wired in `placeLoop`), `break` out to the loop's
 * successor (wired by the enclosing chain) — instead of a box, so `placeBranch`
 * short-circuits to a lone gate whose one real exit flows on.
 */
function controlGuardArm(
  step: BranchStep,
): { flow: "continue" | "break"; outcome: string; otherSteps: Step[]; otherOutcome: string } | null {
  const arcFlow = (arm: Step[]): "continue" | "break" | null => {
    if (arm.length === 0) return null;
    const flows = arm.map((s) => (s.kind === "control" ? (s as ControlStep).flow : undefined));
    const f = flows[0];
    return (f === "continue" || f === "break") && flows.every((x) => x === f) ? f : null;
  };
  const thenFlow = arcFlow(step.thenSteps);
  if (thenFlow && step.elseSteps.length === 0)
    return { flow: thenFlow, outcome: "yes", otherSteps: step.elseSteps, otherOutcome: "no" };
  const elseFlow = arcFlow(step.elseSteps);
  if (elseFlow && step.thenSteps.length === 0)
    return { flow: elseFlow, outcome: "no", otherSteps: step.thenSteps, otherOutcome: "yes" };
  return null;
}

/**
 * An `if`/ternary: a small decision diamond (the verbatim condition rides beside
 * it), then every arm. The primary (first non-empty) arm continues straight down
 * from the bottom vertex; any other arm leaves the right vertex and drops into
 * its own column, `ARM_DX` off the spine, so its connector passes the primary
 * arm cleanly. An empty arm is a bare junction, so it reads as a skip edge
 * around its sibling. No join: a branch is an exclusive choice, so every arm's
 * tail is an exit. The condition sits on the side no arm leaves from.
 */
function placeBranch(step: BranchStep, ctx: Ctx, topY: number): Placed {
  const band = ctx.laneOf(step.phase);
  const cg = controlGuardArm(step);
  const decision = addNode(ctx, {
    kind: "decision",
    x: SPINE_X,
    y: topY + DIAMOND_HALF,
    r: DIAMOND_HALF,
    label: step.conditionLabel,
    phase: band,
    labelSide: cg ? "right" : "left",
    ...(isControlGuard(step) ? { isGuard: true } : {}),
  });

  // A `continue`/`break` guard: the abrupt arm is drawn as a coral arc (wired in
  // placeLoop / by the enclosing chain), not a box. The diamond becomes a lone
  // gate whose one real exit — the straight-through arm — flows on down the spine.
  if (cg) {
    decision.guardFlow = cg.flow;
    decision.guardOutcome = cg.outcome;
    if (cg.otherSteps.length > 0) {
      // Crossing into a new lane under the diamond leaves that lane its headroom.
      const cross = ctx.laneOf(cg.otherSteps[0].phase) !== band ? LANE_HEADER_H : 0;
      const other = placeChain(cg.otherSteps, ctx, decision.y + DIAMOND_HALF + INNER_GAP + cross) as Placed;
      connect(ctx, decision.id, other.entry, "seq", cg.otherOutcome);
      return {
        entry: decision.id,
        exits: other.exits,
        top: decision.y - DIAMOND_HALF,
        bottom: other.bottom,
        minBand: Math.min(band, other.minBand),
        maxBand: Math.max(band, other.maxBand),
        ...(other.pendingBreaks ? { pendingBreaks: other.pendingBreaks } : {}),
      };
    }
    // Empty straight-through arm: the gate itself is the exit, flowing directly
    // into whatever the enclosing chain places next — no stub, no box.
    return {
      entry: decision.id,
      exits: [decision.id],
      top: decision.y - DIAMOND_HALF,
      bottom: decision.y + DIAMOND_HALF,
      minBand: band,
      maxBand: band,
    };
  }

  let y = decision.y + DIAMOND_HALF + INNER_GAP;
  const arms: Array<{ steps: Step[]; outcome: string }> = [
    { steps: step.thenSteps, outcome: "yes" },
    { steps: step.elseSteps, outcome: "no" },
  ];
  const primary = Math.max(0, arms.findIndex((a) => a.steps.length > 0));
  const armBands = arms.map((a) => (a.steps.length > 0 ? ctx.laneOf(a.steps[0].phase) : band));
  // The diamond's own lane is where the first arm crosses from.
  let prevEndBand = band;
  const placedArms: PlacedArm[] = arms.map((arm, i) => {
    if (armBands[i] !== prevEndBand) y += LANE_HEADER_H;
    const from = marks(ctx);
    const placed = arm.steps.length > 0 ? (placeChain(arm.steps, ctx, y) as Placed) : placeChainStub(ctx, y, band);
    y = placed.bottom + INNER_GAP;
    prevEndBand = placed.maxBand;
    return { placed, from, to: marks(ctx) };
  });
  // Every other arm moves into its own column right of everything drawn so far,
  // so its connector — down past the primary arm — never crosses a card.
  let rightEdge = contentBox(ctx, placedArms[primary].from, placedArms[primary].to).maxX;
  placedArms.forEach((a, i) => {
    if (i === primary) return;
    const box = contentBox(ctx, a.from, a.to);
    const dx = Math.max(ARM_DX, Math.round(rightEdge + ROW_GAP - box.minX));
    shiftRange(ctx, a.from, a.to, dx);
    rightEdge = box.maxX + dx;
  });
  placedArms.forEach((a, i) => {
    const target = byId(ctx, a.placed.entry);
    if (i === primary) {
      connect(ctx, decision.id, target.id, "seq", arms[i].outcome);
      return;
    }
    pushEdge(
      ctx,
      decision.id,
      target.id,
      [
        { x: decision.x + DIAMOND_HALF, y: decision.y },
        { x: target.x, y: decision.y },
        { x: target.x, y: target.y - halfHeight(target) },
      ],
      "seq",
      arms[i].outcome,
    );
  });
  const breaks = placedArms.flatMap((a) => a.placed.pendingBreaks ?? []);
  return {
    entry: decision.id,
    exits: placedArms.flatMap((a) => a.placed.exits),
    top: decision.y - DIAMOND_HALF,
    bottom: Math.max(decision.y + DIAMOND_HALF, ...placedArms.map((a) => a.placed.bottom)),
    minBand: Math.min(band, ...placedArms.map((a) => a.placed.minBand)),
    maxBand: Math.max(band, ...placedArms.map((a) => a.placed.maxBand)),
    ...(breaks.length > 0 ? { pendingBreaks: breaks } : {}),
  };
}

// ---------------------------------------------------------------------------
// Loop — the body placed once, inside a frame that names the condition.
// ---------------------------------------------------------------------------

/**
 * Any orchestrating loop: place the body once and draw a FRAME around it — the
 * enclosure says "this repeats", its header gives the verbatim condition, and
 * its scope is exactly the nodes inside. NEVER a routed back-edge for the loop
 * itself. Nested loops nest frames; a body that spans phases simply spans rows.
 *
 * The loop's own `continue` guards become arcs back to the top of the body (a
 * row opens below the header for them to re-enter through); its `break` guards
 * ride out in `pendingBreaks` for the enclosing chain to wire to the successor.
 * Either kind runs in an extra lane on the frame's left. A `break` that escapes
 * a nested loop ending this body has nothing left to run in it, so it returns
 * to the top of THIS body (the next iteration) — never past this loop too.
 */
function placeLoop(step: LoopStep, ctx: Ctx, topY: number): Placed {
  const from = marks(ctx);
  const bodyTop = topY + FRAME_HEAD;
  const body = placeChain(step.body, ctx, bodyTop) ?? placeTask("(empty loop body)", ctx, bodyTop, ctx.laneOf(step.phase), "opaque");

  // Claim this loop's own control guards (skipping any an inner loop already took).
  const backArcs: ControlArc[] = [];
  const pendingBreaks: string[] = [];
  for (const n of ctx.nodes.slice(from.n)) {
    if (n.kind !== "decision" || n.guardFlow === undefined || ctx.claimedGuards.has(n.id)) continue;
    ctx.claimedGuards.add(n.id);
    if (n.guardFlow === "continue") {
      backArcs.push({ fromId: n.id, toId: body.entry, flow: "continue", outcome: n.guardOutcome ?? "yes" });
    } else {
      pendingBreaks.push(n.id);
    }
  }
  // It climbs in THIS loop's lane: its way back runs past this body's nodes.
  for (const id of body.pendingBreaks ?? []) {
    const gate = byId(ctx, id);
    backArcs.push({ fromId: id, toId: body.entry, flow: "break", outcome: gate.guardOutcome ?? "yes" });
  }
  if (backArcs.length > 0) shiftDown(ctx, from.n, from.e, from.f, ARC_ROW);

  const box = contentBox(ctx, from);
  const keyword = step.loopKind === "while" || step.loopKind === "do-while" ? "while" : "for";
  // An arc that leaves the frame or climbs past body nodes needs its own lane on
  // the left; a guard that heads the body loops tightly beside its own diamond.
  const needsLane = pendingBreaks.length > 0 || backArcs.some((a) => a.fromId !== a.toId);
  const x0 = box.minX - FRAME_PAD - (needsLane ? ARC_LANE : 0);
  const placedNodes = ctx.nodes.slice(from.n);
  const own = placedNodes.some((n) => n.kind !== "hub") ? placedNodes.filter((n) => n.kind !== "hub") : placedNodes;
  const frame: GFrame = {
    id: `f${ctx.frames.length}`,
    x0,
    y0: topY,
    x1: box.maxX + FRAME_PAD,
    y1: box.maxY + FRAME_PAD,
    topLane: Math.min(...own.map((n) => n.phase)),
    botLane: Math.max(...own.map((n) => n.phase)),
    keyword,
    condition: step.conditionLabel,
    ...(step.conditionTooltip !== undefined && step.conditionTooltip !== step.conditionLabel
      ? { tooltip: step.conditionTooltip }
      : {}),
    ...(step.iterations !== undefined ? { iterations: step.iterations } : {}),
    headerX: x0 + FRAME_PAD, // settled by placeFrameHeaders once every edge exists
    entry: body.entry,
  };
  for (const inner of ctx.frames.slice(from.f)) if (inner.outer === undefined) inner.outer = frame.id;
  ctx.frames.push(frame);
  for (const arc of backArcs) ctx.controlArcs.push({ ...arc, frame: frame.id, into: frame.id });
  for (const id of pendingBreaks) ctx.guardFrame.set(id, frame.id);

  const breaks = pendingBreaks;
  return {
    entry: body.entry,
    exits: body.exits,
    top: topY,
    bottom: frame.y1,
    minBand: body.minBand,
    maxBand: body.maxBand,
    ...(breaks.length > 0 ? { pendingBreaks: breaks } : {}),
  };
}

/**
 * Settle each loop header once every edge exists: at the frame's left, unless an
 * edge enters the body from above and the text would cross it — then just right
 * of that edge. A frame widens to hold its header (within the graph frame), and
 * each loop around it widens in turn, inner loops first.
 */
function placeFrameHeaders(ctx: Ctx): void {
  const byFrame = new Map(ctx.frames.map((f) => [f.id, f]));
  for (const f of ctx.frames) {
    const entry = byId(ctx, f.entry);
    // An edge that enters the loop from outside turns ABOVE the frame, never
    // inside its header band, where the turn would run through the condition.
    for (const e of ctx.edges) {
      const first = e.points[0];
      const last = e.points[e.points.length - 1];
      if (e.to !== f.entry || first.y >= f.y0 || Math.abs(first.x - last.x) < 0.5) continue;
      const turnY = f.y0 - ELBOW / 2;
      if (turnY <= first.y + 4) continue;
      e.points = [first, { x: first.x, y: turnY }, { x: last.x, y: turnY }, last];
    }
    const incoming = ctx.edges.some((e) => e.to === f.entry && e.points[0].y < f.y0);
    const w = frameHeaderWidth(f.keyword, f.condition, f.iterations);
    const left = f.x0 + FRAME_PAD;
    f.headerX = !incoming || left + w <= entry.x - 8 ? left : entry.x + 10;
    f.x1 = Math.max(f.x1, Math.min(f.headerX + w + FRAME_PAD, W + FRAME_PAD));
    for (let o = f.outer; o !== undefined; ) {
      const outer = byFrame.get(o);
      if (!outer) break;
      outer.x1 = Math.max(outer.x1, f.x1 + FRAME_PAD);
      o = outer.outer;
    }
  }
}

/** Header text width: loop glyph, keyword, condition, and a literal iteration count. */
export function frameHeaderWidth(keyword: string, condition: string, iterations?: number): number {
  return (
    FRAME_ICON_W +
    textWidth(keyword, FRAME_KEYWORD_FONT) +
    6 +
    textWidth(condition, FRAME_COND_FONT) +
    (iterations !== undefined ? textWidth(` · ×${iterations}`, FRAME_COND_FONT) : 0)
  );
}

/**
 * The drawn extent of everything placed between two marks: cards (their stack and
 * badge), decision diamonds with the condition beside them, boxes, final nodes
 * with their label, nested frames, and edge points.
 */
function contentBox(ctx: Ctx, from: Marks, to: Marks = marks(ctx)): { minX: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of ctx.nodes.slice(from.n, to.n)) {
    const [lo, hi] = nodeXExtent(n);
    minX = Math.min(minX, lo);
    maxX = Math.max(maxX, hi);
    maxY = Math.max(maxY, n.y + halfHeight(n));
  }
  for (const e of ctx.edges.slice(from.e, to.e)) {
    for (const p of e.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
  }
  for (const f of ctx.frames.slice(from.f, to.f)) {
    minX = Math.min(minX, f.x0);
    maxX = Math.max(maxX, f.x1);
    maxY = Math.max(maxY, f.y1);
  }
  return { minX, maxX, maxY };
}

/** A node's horizontal drawn extent, including text set beside it. */
export function nodeXExtent(n: GNode): [number, number] {
  const half = (n.w ?? 2 * n.r) / 2;
  switch (n.kind) {
    case "agent": {
      const stack = n.card?.mult !== undefined ? DECK_STEP * DECK_DEPTH + 8 : 0;
      const caption = n.card?.caption !== undefined ? half + CARD_PAD_X : half;
      return [n.x - Math.max(half, caption), n.x + Math.max(half + stack, caption)];
    }
    case "decision": {
      const condW = textWidth(n.label, COND_FONT) + COND_GAP;
      return n.labelSide === "left"
        ? [n.x - DIAMOND_HALF - condW, n.x + DIAMOND_HALF]
        : [n.x - DIAMOND_HALF, n.x + DIAMOND_HALF + condW];
    }
    case "control":
      if (isFinalNode(n)) return [n.x - TERMINAL_R, n.x + TERMINAL_R + 8 + textWidth(n.label, COND_FONT)];
      return [n.x - half, n.x + half];
    case "task":
      return [n.x - half, n.x + half + (n.mult !== undefined ? DECK_STEP * DECK_DEPTH + 8 : 0)];
    case "hub":
      return [n.x, n.x];
    default:
      return [n.x - half, n.x + half];
  }
}

/** A control node drawn as the UML final node (◉): the workflow ends here. */
export function isFinalNode(n: GNode): boolean {
  return n.kind === "control" && (n.flow === "terminal" || n.flow === "return" || n.flow === "throw");
}

// ---------------------------------------------------------------------------
// Row / grid geometry + multiplicity badges
// ---------------------------------------------------------------------------

/** N evenly-spaced cell centers of width `cellW`, centered on `centerX`. */
function rowCenters(n: number, cellW: number, centerX: number): number[] {
  const left = centerX - (n * cellW) / 2 + cellW / 2;
  return Array.from({ length: n }, (_, i) => left + i * cellW);
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
 * first node always clears the previous content.
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
  const mult = multBadge(step.multiplicity);
  const hint = step.multiplicity.kind === "unknown" ? step.multiplicity.hint : undefined;
  const card = agentCard(cardInput(ctx, step, { ...(mult !== undefined ? { mult } : {}), ...(hint ? { hint } : {}) }));
  const n = addCard(ctx, SPINE_X, topY, card, step, band, {
    ...(step.promptPreview !== undefined ? { tooltip: step.promptPreview } : {}),
  });
  return { entry: n.id, exits: [n.id], top: topY, bottom: topY + card.h, minBand: band, maxBand: band };
}

/** Width of a task box: its mono label, padding, and (sub-workflow) the double rule. */
export function taskWidth(label: string, task: "workflow" | "opaque"): number {
  const text = textWidth(label, { size: 11, mono: true });
  const sub = task === "workflow" ? Math.max(text, textWidth("sub-workflow", { size: 10 })) + 8 : text;
  return Math.ceil(Math.min(MAX_ROW_W, Math.max(TASK_MIN_W, sub + 2 * CARD_PAD_X)));
}

/** A task box (sub-workflow card or opaque box); one run per item of a fan-out
 *  is a stack, like an agent card's. */
function placeTask(
  label: string,
  ctx: Ctx,
  topY: number,
  band: number,
  task: "workflow" | "opaque",
  mult?: string,
): Placed {
  const h = (task === "workflow" ? SUBFLOW_H : TASK_H) + (mult !== undefined ? DECK_STEP * DECK_DEPTH : 0);
  const n = addNode(ctx, {
    kind: "task",
    task,
    x: SPINE_X,
    y: topY + h / 2,
    r: h / 2,
    w: taskWidth(label, task),
    h,
    label,
    phase: band,
    ...(mult !== undefined ? { mult } : {}),
  });
  return { entry: n.id, exits: [n.id], top: topY, bottom: topY + h, minBand: band, maxBand: band };
}

function controlExits(flow: ControlStep["flow"], id: string): string[] {
  return flow === undefined ? [id] : [];
}

/** A control step: a final node (◉) for return/throw — the workflow ends — or a
 *  small pill naming the jump (`continue`, `break`) where no arc can carry it. */
function placeControl(step: ControlStep, ctx: Ctx, topY: number): Placed {
  const band = ctx.laneOf(step.phase);
  const final = step.flow === "return" || step.flow === "throw";
  const label = step.flow === "continue" ? "continue" : step.flow === "break" ? "break" : step.label;
  const h = final ? 2 * TERMINAL_R : 24;
  const w = final ? 2 * TERMINAL_R : Math.ceil(textWidth(label, { size: 11, mono: true }) + 2 * CARD_PAD_X + 4);
  const n = addNode(ctx, {
    kind: "control",
    x: SPINE_X,
    y: topY + h / 2,
    r: h / 2,
    w,
    h,
    label,
    phase: band,
    ...(step.flow !== undefined ? { flow: step.flow } : {}),
    ...(step.tooltip !== undefined ? { tooltip: step.tooltip } : {}),
  });
  return {
    entry: n.id,
    exits: controlExits(step.flow, n.id),
    top: topY,
    bottom: topY + h,
    minBand: band,
    maxBand: band,
  };
}

function placeTerminal(
  ctx: Ctx,
  topY: number,
  band: number,
  tooltip = "No agent/workflow calls were recovered in this phase.",
): Placed {
  const n = addNode(ctx, {
    kind: "control",
    x: SPINE_X,
    y: topY + TERMINAL_R,
    r: TERMINAL_R,
    w: 2 * TERMINAL_R,
    h: 2 * TERMINAL_R,
    label: "end",
    phase: band,
    flow: "terminal",
    tooltip,
  });
  return {
    entry: n.id,
    exits: [],
    top: topY,
    bottom: topY + 2 * TERMINAL_R,
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
 * appearance — which is exactly `topology.bands`. The declared model comes from
 * the matching meta phase; body-only bands carry none. A body with no bands at
 * all still gets one untitled lane so placement has somewhere to land.
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
          // Two or three phases side by side still leave each sub-cell a readable
          // measure; more stay separate rows (placed stacked, which never overlaps).
          if (idx.length >= 2 && idx.length <= 3 && idx[idx.length - 1] - idx[0] === idx.length - 1) {
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

/** Content lanes (those a node landed in) span their nodes — and the frame edges
 *  that sit in them — plus padding. Strip lanes keep the range `stripLane` gave. */
function deriveLaneRanges(lanes: GLane[], nodes: GNode[], frames: GFrame[]): void {
  for (const lane of lanes) {
    // A stub (an empty arm or stage) is a routing point that sits wherever its
    // siblings put it — it never stretches a row; it only marks a row that has
    // nothing else.
    const all = nodes.filter((n) => n.phase === lane.phaseIndex);
    const solid = all.filter((n) => !(n.kind === "hub" && n.fork !== true));
    const own = solid.length > 0 ? solid : all;
    if (own.length === 0) continue;
    const top = Math.min(
      ...own.map((n) => n.y - halfHeight(n)),
      ...frames.filter((f) => f.topLane === lane.phaseIndex).map((f) => f.y0),
    );
    const bot = Math.max(
      ...own.map((n) => n.y + halfHeight(n)),
      ...frames.filter((f) => f.botLane === lane.phaseIndex).map((f) => f.y1),
    );
    lane.yTop = Math.max(0, top - LANE_HEADER_H);
    lane.yBot = bot + LANE_PAD;
    lane.empty = false;
  }
}

/**
 * Safety net for the rare orphan lane — one with no nodes that the flow never
 * struck a strip for (a phase index a structured shape skipped over). Wedge it
 * in as a slim strip between its band-order neighbors so rows stay ordered and
 * the lane is never left with a degenerate zero range.
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

/**
 * The placed graph's total height — i.e. its true content bottom. Content lanes
 * already carry a LANE_PAD below their last node, so the page ends exactly at
 * `laneBot`; the pad applies only to the rare node or frame that dangles below
 * every lane.
 */
function pageHeight(lanes: GLane[], nodes: GNode[], frames: GFrame[]): number {
  const laneBot = lanes.reduce((m, l) => Math.max(m, l.yBot), 0);
  const nodeBot = nodes.reduce((m, n) => Math.max(m, n.y + halfHeight(n)), 0);
  const frameBot = frames.reduce((m, f) => Math.max(m, f.y1), 0);
  return Math.max(laneBot, Math.max(nodeBot, frameBot) + LANE_PAD);
}

/**
 * Co-registration for the swimlane-table render: make each lane's row at least
 * as tall as its left label cell, so the label and its graph slice share one
 * row. `minHeights[i]` is the required height for lane `i` (the label cell's
 * measured height); a lane shorter than its label is inflated and everything
 * strictly below it slides down by the same delta — the rigid downward shift
 * keeps every edge flowing down (the layout invariant) and leaves the graph's
 * internal placement otherwise untouched. A frame's top and bottom edges move
 * with the lanes they sit in, so a frame spanning rows stretches with them.
 *
 * The extra space is added at the row's BOTTOM: graph nodes already sit at the
 * top of their row and the label cell is top-aligned, so the surplus becomes
 * trailing whitespace in whichever cell is shorter. Lanes are processed in band
 * order; each shift moves later lanes rigidly, so heights stay stable.
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
    for (const f of layout.frames) {
      if (f.topLane > i) f.y0 += delta;
      if (f.botLane > i) f.y1 += delta;
    }
    total += delta;
  }
  layout.height += total;
}

/**
 * Snap adjacent lane rows together so the swimlane table reads as one
 * continuous table with NO gaps between rows. The graph flow leaves a small,
 * uneven gap between consecutive phases (some of `LANE_GAP_CROSS`/`STACK_GAP`
 * that neither row covers); this moves every interior boundary to the midpoint
 * of that gap, so row `i`'s bottom meets row `i+1`'s top exactly.
 *
 * Purely cosmetic and safe: only the row bounds move, and only OUTWARD into the
 * gaps — a row can grow but never shrinks below its label cell — while nodes,
 * edges, and the table's outer top/bottom are untouched, so `layout.height` is
 * unchanged.
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
