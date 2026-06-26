/**
 * Positioned geometry — the output of `place-topology` and the sole input of
 * `render-topology`. ONE global vertical graph in a flat coordinate space:
 * x ∈ [0, width], y growing downward from 0 at the top of the first lane (the
 * renderer offsets the whole graph below the header card it draws separately).
 *
 * Phases are an OVERLAY here, not a container. Every node carries the index of
 * the lane it landed in; each `GLane` is just a painted y-range derived from
 * where its nodes fell. So a cross-phase edge is an ordinary short edge in this
 * one coordinate space — never a routed crossing of a card wall, because there
 * are no walls. Loops are local `GLoop` badges, never back-edges; the layout
 * invariant is that every `GEdge` flows downward (`from.y ≤ to.y`).
 *
 * All strings are RAW source text (truncated, never paraphrased) — escaping
 * happens at render time. Determinism: every array is in emission order.
 */

/** The drawable node vocabulary the placement maps the analyzer shapes onto. */
export type GNodeKind = "agent" | "barrier" | "decision" | "task" | "control" | "hub";

export interface GNode {
  id: string;
  kind: GNodeKind;
  /** Center x. */
  x: number;
  /** Center y. */
  y: number;
  /** Circle radius (agent, hub) — also the half-extent edges clip to. */
  r: number;
  /** Box/bar width where it differs from 2·r (task box, barrier bar). */
  w?: number;
  /** Box/bar height where it differs from 2·r (task box, barrier bar). */
  h?: number;
  /** RAW label (escaped at render). */
  label: string;
  /** Agent nodes only: did the author write the label? When `false`, the label
   *  was sliced from the prompt and is redundant with the phase row, so the
   *  renderer paints a bare node. Absent (hubs/barriers/etc., or unset) ⇒ shown. */
  labelExplicit?: boolean;
  /** Agent model key for the color swatch (RAW); absent ⇒ neutral. */
  model?: string;
  /** Pre-rendered multiplicity badge, e.g. "×4" / "×N" (RAW); absent ⇒ one. */
  mult?: string;
  /** Row/grid member: render the label centered BELOW (a spine node defaults to
   *  a right-side label, where the vertical flow leaves room). */
  labelBelow?: boolean;
  /** Index into `Layout.lanes` — the lane this node landed in. */
  phase: number;
  /** Full text behind a truncation, surfaced as a `<title>` (RAW). */
  tooltip?: string;
  /** Abrupt JS flow represented by a control node. */
  flow?: "continue" | "break" | "return" | "throw" | "terminal";
  /** Decision nodes only: this branch is a loop-control GUARD (`if (…) continue;`
   *  / `break;` with no real work in the taken arm) — plumbing, not the loop's
   *  purpose. A loop headed by such a guard pins its repeat badge to the body's
   *  first work node instead of this diamond, so the badge reads as an
   *  annotation on the work (like an agent-headed loop), not a floating label. */
  isGuard?: boolean;
  /** Decision/guard nodes only (placement-internal): this guard's taken arm is an
   *  abrupt `continue` (later `break`) — drawn as a loop-back ARC on the diamond
   *  instead of a separate control box. `placeLoop` reads this to wire the arc to
   *  the loop's body entry (see `ControlArc`); `guardOutcome` is the condition
   *  outcome ("yes"/"no") that triggers it, drawn beside the arc. */
  guardFlow?: "continue" | "break";
  guardOutcome?: string;
}

/**
 * Edge roles: `seq` ordinary sequential flow (incl. cross-phase); `fan`
 * hub↔member / member→barrier inside a parallel; `stage` pipeline stage→stage;
 * `merge` a branch/parallel arm rejoining a barrier or sink.
 */
export type GEdgeKind = "seq" | "fan" | "stage" | "merge";

export interface GEdge {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  /** Polyline from the source's exit anchor to the target's entry anchor (≥ 2 points). */
  points: ReadonlyArray<{ x: number; y: number }>;
  /** RAW edge label (e.g. a branch arm's condition outcome). */
  label?: string;
  kind: GEdgeKind;
}

/**
 * A local "↻ repeat …" badge pinned to a node — the faithful summary of a loop
 * (body placed once, looping noted in place). NEVER a back-edge.
 */
export interface GLoop {
  /** Node id the badge attaches to. */
  onNode: string;
  /** RAW phrasing, e.g. "repeat while bracket.length > 1". */
  label: string;
  /** Full RAW phrasing for browser tooltips when the label is truncated. */
  tooltip?: string;
}

/**
 * A control-flow ARC drawn between two placed nodes — the faithful picture of an
 * abrupt jump the downward flow can't carry: `continue` loops BACK from a guard
 * diamond to the loop's body entry (a self-loop when the guard IS the entry).
 *
 * NOT a `GEdge`: it is exempt from the downward invariant by design, and routed
 * as a curved decoration computed from LIVE node positions at render time — so
 * every placement shift (badge rows, lane co-registration) carries it along for
 * free, the same way a `GLoop` badge rides its node. The standard control-flow-
 * graph back-edge, the compact form of the rejected "continue loop" box.
 */
export interface ControlArc {
  /** Source node id — the guard diamond the jump leaves from. */
  fromId: string;
  /** Target node id — the loop body entry it returns to (== `fromId` when the
   *  guard is itself the loop head). */
  toId: string;
  /** The abrupt flow this arc pictures. */
  flow: "continue" | "break";
  /** Condition outcome that triggers it ("yes"/"no"), drawn beside the source. */
  outcome: string;
}

/**
 * One arm of a collapsed parallel row: the sub-cell the left column draws for a
 * phase whose work runs concurrently with its siblings. Carries its own chip
 * number + title + model so each lineage stays legible side by side.
 */
export interface LaneMember {
  /** 1-based chip number — the arm's ORIGINAL phase position. */
  ordinal: number;
  /** RAW band title. */
  title: string;
  /** Phase model for the swatch dot (RAW); absent for control-only arms. */
  model?: string;
}

/** A phase as a painted swimlane stripe behind wherever its nodes landed. */
export interface GLane {
  /** Position in `Layout.lanes` — the index every node's `phase` points at. */
  phaseIndex: number;
  /** 1-based chip number shown for a single-phase lane (its ORIGINAL phase
   *  position — which can differ from `phaseIndex` once a parallel group
   *  collapses earlier phases into one row). */
  ordinal: number;
  /** RAW band title. */
  title: string;
  /** Phase model for the tint + chip (RAW); absent for control-only bands. */
  model?: string;
  /** When ≥2 concurrent phases collapsed into THIS one row, their per-arm
   *  sub-cells to draw side by side (each its own chip/title/model). Absent for
   *  an ordinary single-phase lane. */
  members?: LaneMember[];
  /** Top of the painted stripe. */
  yTop: number;
  /** Bottom of the painted stripe. */
  yBot: number;
  /** No agent/task node landed here → render a slim control strip. */
  empty: boolean;
}

export interface Layout {
  /** Fixed content width (== `svg-primitives` W). */
  width: number;
  /** Graph content height; the renderer adds the header card and margins. */
  height: number;
  lanes: GLane[];
  nodes: GNode[];
  edges: GEdge[];
  loops: GLoop[];
  /** Control-flow arcs (continue/break) drawn as curved decorations, NOT edges —
   *  so they never appear in `edges` and never violate the downward invariant. */
  controlArcs: ControlArc[];
  /**
   * Honest placement-time degradations the renderer needn't draw but the CLI
   * surfaces (e.g. a wide fan-out collapsed to ×N, a multi-phase loop body
   * kept local). Nothing is ever silently dropped.
   */
  notes: string[];
}
