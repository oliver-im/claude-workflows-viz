import type { Meta } from "./model.js";
import type {
  FlatMultiplicity,
  NodeKind,
  TopoEdge,
  TopoLoop,
  TopoNode,
  TopologyIR,
} from "./topology-ir.js";
import type {
  BranchStep,
  LoopStep,
  Multiplicity,
  PipelineStep,
  Step,
  Topology,
} from "./topology.js";

/**
 * The flattener: analyzer tree IR + meta → the flat banded node/edge/loop
 * graph the layout consumes, plus the merged band-title list the renderer
 * shows alongside it. ALL graph-shape policy lives here, in one reviewable
 * place — the analyzer stays source-faithful, the renderer stays geometry.
 *
 * The cross-cutting sequence rule: consecutive steps connect by an edge only
 * inside one band; implicit CROSS-band succession draws nothing (vertical
 * band stacking already says "then" — v1 semantics). Only a structure's own
 * explicit connections — fan-ins to a barrier, pipeline stage chains, branch
 * arms and merges, loop arcs and exits — cross bands.
 *
 * Honesty is preserved by construction: labels, condition slices, and
 * multiplicities pass through verbatim (the one rewrite is substituting an
 * agent's pre-computed `expandedLabels` as a named multiplicity's names).
 * The flattener never re-derives, paraphrases, or counts anything new. A
 * loop's `iterations` stays a tree-level detail — the verbatim condition
 * slice on the decision node already says it.
 */

export interface FlattenResult {
  ir: TopologyIR;
  /**
   * The renderer's band list: meta phase titles first (in meta order), then
   * body-only bands appended in first-appearance order. `TopoNode.band`
   * indexes into this list; a title with no nodes still renders (as the v1
   * fallback card).
   */
  bandTitles: string[];
}

/** Turn the analyzer's nested tree into the flat renderable graph. */
export function flattenTopology(topology: Topology, meta: Meta): FlattenResult {
  const ctx: Ctx = {
    nodes: [],
    edges: [],
    loops: [],
    bandTitles: [],
    bandIndex: new Map(),
  };
  for (const phase of meta.phases) bandOf(ctx, phase.title);
  for (const band of topology.bands) bandOf(ctx, band.title);
  // A phase-less workflow (meta.phases defaults to [], body has no phase()
  // markers) still flattens its steps somewhere: seed one untitled band so
  // node.band always indexes into bandTitles.
  if (ctx.bandTitles.length === 0 && topology.steps.length > 0) bandOf(ctx, "");
  flattenSeq(ctx, topology.steps, 0, null);
  return {
    ir: { nodes: ctx.nodes, edges: ctx.edges, loops: ctx.loops },
    bandTitles: ctx.bandTitles,
  };
}

// ---------------------------------------------------------------------------
// Flatten state
// ---------------------------------------------------------------------------

interface Ctx {
  nodes: TopoNode[];
  edges: TopoEdge[];
  loops: TopoLoop[];
  bandTitles: string[];
  /** title → index into `bandTitles` (first occurrence wins). */
  bandIndex: Map<string, number>;
}

/**
 * The connection surface of a flattened step (or sequence): where an incoming
 * edge lands, and how control leaves.
 */
interface Flat {
  /** Nodes an incoming connection lands on (the step's visual head). */
  entries: TopoNode[];
  /** Nodes an implicit outgoing connection leaves from. */
  exits: TopoNode[];
  /** Present when the step owns its outgoing connection (branch/loop). */
  out?: OutPolicy;
}

type OutPolicy =
  | { kind: "branch"; decision: TopoNode; arms: Flat[]; bypassLabels: string[] }
  | { kind: "loop"; decision: TopoNode };

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/**
 * Resolve a band title to its index, appending it if never seen (defensive —
 * the analyzer registers every phase it attributes, so after the upfront
 * meta + `topology.bands` seeding this only fires for malformed trees).
 */
function bandOf(ctx: Ctx, title: string): number {
  const existing = ctx.bandIndex.get(title);
  if (existing !== undefined) return existing;
  ctx.bandTitles.push(title);
  ctx.bandIndex.set(title, ctx.bandTitles.length - 1);
  return ctx.bandTitles.length - 1;
}

/**
 * Band per step of a sequence: the step's own phase when present; otherwise
 * the band of the nearest FOLLOWING step with one; otherwise the enclosing
 * structure's band (band 0 at top level). The fallbacks are note-free
 * defensive defaults — once a `phase()` marker has run the analyzer
 * attributes a phase to every step, and the example corpus never produces a
 * phase-less one.
 */
function resolveBands(ctx: Ctx, steps: readonly Step[], fallback: number): number[] {
  const bands = new Array<number>(steps.length);
  let next = fallback;
  for (let i = steps.length - 1; i >= 0; i--) {
    const phase = steps[i].phase;
    if (phase !== null) next = bandOf(ctx, phase);
    bands[i] = next;
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function emitNode(
  ctx: Ctx,
  band: number,
  kind: NodeKind,
  label: string,
  extra?: { model?: string; mult?: FlatMultiplicity },
): TopoNode {
  const node: TopoNode = {
    id: `n${ctx.nodes.length}`,
    band,
    kind,
    label,
    ...(extra?.model !== undefined ? { model: extra.model } : {}),
    ...(extra?.mult !== undefined ? { mult: extra.mult } : {}),
  };
  ctx.nodes.push(node);
  return node;
}

/**
 * Emit one connection, keeping the IR invariants by construction: a link
 * pointing down the page lands in `edges` (band(from) ≤ band(to)) and one
 * pointing back up lands in `loops` (band(from) ≥ band(to)); `intent` decides
 * the level case.
 *
 * Direction deliberately wins over the producing structure's kind when the
 * two disagree (it takes a `phase()` marker jumping to an EARLIER band inside
 * an arm, lane, or stage — the corpus never does). The IR's taxonomy is
 * geometric — a TopoLoop IS "a back arc, routed via the gutter" — so an
 * up-pointing arm edge drawn as a gutter arc reads truthfully, while emitting
 * it as a contract-violating forward edge would get it silently dropped by
 * the layout's defenses, and the one thing this pipeline never does is drop
 * a connection silently.
 */
function emitLink(
  ctx: Ctx,
  intent: "forward" | "back",
  from: TopoNode,
  to: TopoNode,
  label?: string,
): void {
  const link: TopoEdge & TopoLoop = {
    from: from.id,
    to: to.id,
    ...(label !== undefined ? { label } : {}),
  };
  const back = intent === "back" ? from.band >= to.band : from.band > to.band;
  (back ? ctx.loops : ctx.edges).push(link);
}

/**
 * Connect a flattened step to the entries of whatever follows it.
 *
 * `"same-band"` is the implicit-succession rule (see the module header);
 * `"always"` is for a structure's own explicit connections, which cross
 * bands freely.
 *
 * A branch hands control forward through its arms: each arm's terminal
 * merges into the successor (explicit, any band), and an EMPTY arm becomes a
 * direct decision → successor bypass still carrying that arm's yes/no label
 * (it is the same logical edge as decision → arm head, landing further on
 * because the arm has no nodes). A loop hands control forward from its
 * synthesized decision, labeled "no" — the exit path.
 */
function connectInto(
  ctx: Ctx,
  prev: Flat,
  entries: readonly TopoNode[],
  mode: "same-band" | "always",
): void {
  const out = prev.out;
  if (out?.kind === "branch") {
    for (const arm of out.arms) connectInto(ctx, arm, entries, "always");
    for (const label of out.bypassLabels) {
      for (const to of entries) emitLink(ctx, "forward", out.decision, to, label);
    }
    return;
  }
  if (out?.kind === "loop") {
    for (const to of entries) emitLink(ctx, "forward", out.decision, to, "no");
    return;
  }
  for (const from of prev.exits) {
    for (const to of entries) {
      if (mode === "always" || from.band === to.band) emitLink(ctx, "forward", from, to);
    }
  }
}

/** The nodes `connectInto(prev, …)` would draw from — a join's fan-in sources. */
function sourcesOf(flat: Flat): TopoNode[] {
  if (flat.out?.kind === "branch") {
    const arms = flat.out.arms.flatMap(sourcesOf);
    return flat.out.bypassLabels.length > 0 ? [...arms, flat.out.decision] : arms;
  }
  if (flat.out?.kind === "loop") return [flat.out.decision];
  return flat.exits;
}

/** The latest-emitted node among `candidates` (emission order = `ctx.nodes` order). */
function lastEmitted(ctx: Ctx, candidates: readonly TopoNode[]): TopoNode | undefined {
  let best: TopoNode | undefined;
  let bestIndex = -1;
  for (const node of candidates) {
    const index = ctx.nodes.indexOf(node);
    if (index > bestIndex) {
      bestIndex = index;
      best = node;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Flatten a sequence of sibling steps, connecting consecutive ones by the
 * implicit same-band rule (branches and loops override it through their
 * `out` policy). Returns the sequence's combined surface: the first step's
 * entries, the last step's exits/out. A step that emits nothing (a
 * degenerate empty structure; the analyzer never produces one) is
 * transparent — it neither breaks nor joins the chain.
 */
function flattenSeq(
  ctx: Ctx,
  steps: readonly Step[],
  fallback: number,
  stageMult: Multiplicity | null,
): Flat {
  const bands = resolveBands(ctx, steps, fallback);
  let first: Flat | undefined;
  let prev: Flat | undefined;
  for (let i = 0; i < steps.length; i++) {
    const flat = flattenStep(ctx, steps[i], bands[i], stageMult);
    if (flat.entries.length === 0) continue;
    if (prev !== undefined) connectInto(ctx, prev, flat.entries, "same-band");
    first ??= flat;
    prev = flat;
  }
  if (first === undefined || prev === undefined) return { entries: [], exits: [] };
  return { entries: first.entries, exits: prev.exits, out: prev.out };
}

function flattenStep(ctx: Ctx, step: Step, band: number, stageMult: Multiplicity | null): Flat {
  switch (step.kind) {
    case "agent": {
      const mult = toFlatMult(effectiveMult(step.multiplicity, stageMult), step.expandedLabels);
      const node = emitNode(ctx, band, "agent", step.label, {
        ...(step.model !== undefined ? { model: step.model } : {}),
        ...(mult !== undefined ? { mult } : {}),
      });
      return { entries: [node], exits: [node] };
    }
    case "workflow": {
      const mult = toFlatMult(effectiveMult(step.multiplicity, stageMult));
      const node = emitNode(ctx, band, "task", step.label, mult !== undefined ? { mult } : undefined);
      return { entries: [node], exits: [node] };
    }
    case "opaque": {
      // The honest blob: a plain task node, so the reader sees SOMETHING
      // happens here, labeled with the verbatim source slice.
      const node = emitNode(ctx, band, "task", step.label);
      return { entries: [node], exits: [node] };
    }
    case "parallel":
      return step.form === "branches"
        ? flattenBranches(ctx, step.branches, band, stageMult)
        : flattenFanout(ctx, step.multiplicity, step.body, band, stageMult);
    case "pipeline":
      return flattenPipeline(ctx, step, band);
    case "loop":
      return flattenLoop(ctx, step, band, stageMult);
    case "branch":
      return flattenBranch(ctx, step, band, stageMult);
  }
}

// --- parallel ----------------------------------------------------------------

/**
 * `parallel(xs.map(cb))` fan-out: the lane body flattens once (the analyzer
 * already threaded the fan-out multiplicity onto the agent steps inside),
 * then one barrier joins the lanes, fed by the body's terminal(s). An
 * unreadable fan-out (empty body) still draws the honest shape — a
 * placeholder "agents" node carrying the unresolved multiplicity, then the
 * barrier. The barrier sits in the band of the last contributing node.
 */
function flattenFanout(
  ctx: Ctx,
  multiplicity: Multiplicity,
  body: Step[],
  band: number,
  stageMult: Multiplicity | null,
): Flat {
  let inner = flattenSeq(ctx, body, band, stageMult);
  if (inner.entries.length === 0) {
    const placeholder = emitNode(ctx, band, "agent", "agents", {
      mult: toFlatMult(multiplicity) ?? { kind: "unknown" },
    });
    inner = { entries: [placeholder], exits: [placeholder] };
  }
  const barrier = emitNode(ctx, lastEmitted(ctx, sourcesOf(inner))?.band ?? band, "barrier", "");
  connectInto(ctx, inner, [barrier], "always");
  return { entries: inner.entries, exits: [barrier] };
}

/**
 * `parallel([thunk, thunk, …])` branches: k independent chains, every
 * chain's terminal fanning into one shared barrier — explicit edges, so they
 * cross bands freely (dual-lineage's two lanes live in different bands). The
 * barrier sits in the band of the last contributing node. A chain that emits
 * nothing (a thunk with no orchestration) contributes nothing; if no chain
 * emits, the barrier alone stands as the join (defensive — the analyzer puts
 * an opaque step in any unreadable branch).
 */
function flattenBranches(
  ctx: Ctx,
  branches: Step[][],
  band: number,
  stageMult: Multiplicity | null,
): Flat {
  const chains = branches
    .map((branch) => flattenSeq(ctx, branch, band, stageMult))
    .filter((chain) => chain.entries.length > 0);
  const sources = chains.flatMap(sourcesOf);
  const barrier = emitNode(ctx, lastEmitted(ctx, sources)?.band ?? band, "barrier", "");
  for (const chain of chains) connectInto(ctx, chain, [barrier], "always");
  return {
    entries: chains.length > 0 ? chains.flatMap((chain) => chain.entries) : [barrier],
    exits: [barrier],
  };
}

// --- pipeline ----------------------------------------------------------------

/**
 * `pipeline(items, ...stages)`: per-item chains. Every stage runs once per
 * item, so each stage's agent nodes take the `items` multiplicity — unless
 * an inner structure already threaded one onto them (a nested fan-out's
 * agents keep their own count: the per-lane truth). Stage agents' expanded
 * labels, when the analyzer computed them, become the named multiplicity's
 * names. Consecutive stages chain by an explicit edge from stage k's
 * terminal to stage k+1's head — NO barrier between stages (pipeline
 * semantics: lanes flow, they don't join) — crossing bands freely
 * (review-pr's review → verify chain).
 */
function flattenPipeline(ctx: Ctx, step: PipelineStep, band: number): Flat {
  let first: Flat | undefined;
  let prev: Flat | undefined;
  for (const stage of step.stages) {
    const flat = flattenSeq(ctx, stage, band, step.items);
    if (flat.entries.length === 0) continue;
    if (prev !== undefined) connectInto(ctx, prev, flat.entries, "always");
    first ??= flat;
    prev = flat;
  }
  if (first === undefined || prev === undefined) return { entries: [], exits: [] };
  return { entries: first.entries, exits: prev.exits, out: prev.out };
}

// --- loop ----------------------------------------------------------------------

/**
 * A loop flattens to its body chain followed by one synthesized decision
 * (label = the verbatim condition slice) banded with the last body node,
 * plus the back arc decision → first body node labeled "yes". The exit path
 * leaves the decision labeled "no" — drawn by `connectInto` when a successor
 * exists; a loop that ends its sequence just stops at the decision
 * (hunt-bugs). Nested loops nest naturally: an inner loop ending the body
 * hands the outer decision its own "no" exit edge (for-exhausted → while
 * re-tests), and the outer back arc targets the body's first node.
 */
function flattenLoop(ctx: Ctx, step: LoopStep, band: number, stageMult: Multiplicity | null): Flat {
  const before = ctx.nodes.length;
  const body = flattenSeq(ctx, step.body, band, stageMult);
  // Positional on purpose: the policy bands the decision at "the loop's last
  // body band" (the last node emitted), unlike barriers, which sit with their
  // last fan-in source. The two coincide for every traced shape.
  const lastBody = ctx.nodes.length > before ? ctx.nodes[ctx.nodes.length - 1] : undefined;
  const decision = emitNode(ctx, lastBody?.band ?? band, "decision", step.conditionLabel);
  if (body.entries.length > 0) {
    connectInto(ctx, body, [decision], "always");
    emitLink(ctx, "back", decision, body.entries[0], "yes");
  }
  return {
    entries: body.entries.length > 0 ? body.entries : [decision],
    exits: [],
    out: { kind: "loop", decision },
  };
}

// --- branch --------------------------------------------------------------------

/**
 * An if/ternary flattens to one decision node (label = the verbatim
 * condition slice). Non-empty arms hang off it — edge decision → arm head
 * labeled "yes"/"no" — and flatten recursively in their own band placement.
 * Rejoining is `connectInto`'s job when a successor exists: each arm's
 * terminal merges into it, and an empty arm becomes the labeled
 * decision → successor bypass. A branch that ends its sequence lets its arms
 * simply terminate (triage routes to a specialist and stops).
 */
function flattenBranch(ctx: Ctx, step: BranchStep, band: number, stageMult: Multiplicity | null): Flat {
  const decision = emitNode(ctx, band, "decision", step.conditionLabel);
  const arms: Flat[] = [];
  const bypassLabels: string[] = [];
  for (const [armSteps, label] of [
    [step.thenSteps, "yes"],
    [step.elseSteps, "no"],
  ] as const) {
    const arm = flattenSeq(ctx, armSteps, band, stageMult);
    if (arm.entries.length === 0) {
      bypassLabels.push(label);
      continue;
    }
    for (const head of arm.entries) emitLink(ctx, "forward", decision, head, label);
    arms.push(arm);
  }
  return { entries: [decision], exits: [], out: { kind: "branch", decision, arms, bypassLabels } };
}

// ---------------------------------------------------------------------------
// Multiplicity
// ---------------------------------------------------------------------------

/**
 * A pipeline-stage lane multiplicity applies only to steps the analyzer left
 * at `one` — anything already counted (a nested fan-out's threading) keeps
 * its own, more specific truth.
 */
function effectiveMult(mult: Multiplicity, stageMult: Multiplicity | null): Multiplicity {
  return stageMult !== null && mult.kind === "one" ? stageMult : mult;
}

/**
 * Tree multiplicity → flat: `one` disappears (absent = a single run);
 * `named` carries the agent's `expandedLabels` as its names when the
 * analyzer computed them (e.g. review:correctness/security/performance),
 * else the raw names. Counts stay literal-only — nothing is invented here.
 */
function toFlatMult(
  mult: Multiplicity,
  expandedLabels?: readonly string[],
): FlatMultiplicity | undefined {
  switch (mult.kind) {
    case "one":
      return undefined;
    case "exact":
      return { kind: "exact", n: mult.count };
    case "named":
      return { kind: "named", names: [...(expandedLabels ?? mult.names)] };
    case "unknown":
      return { kind: "unknown", ...(mult.hint !== undefined ? { hint: mult.hint } : {}) };
  }
}
