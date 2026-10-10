import type { CardSpec } from "./node-card.js";

/**
 * Positioned geometry — the output of `place-topology` and the sole input of
 * `render-topology`. ONE global vertical graph in a flat coordinate space:
 * x ∈ [0, width] (rows may overhang it; the renderer packs to real content),
 * y growing downward from 0 at the top of the first lane (the renderer offsets
 * the whole graph below the header card it draws separately).
 *
 * Phases are an OVERLAY here, not a container. Every node carries the index of
 * the lane it landed in; each `GLane` is just a painted y-range derived from
 * where its nodes fell. So a cross-phase edge is an ordinary short edge in this
 * one coordinate space — never a routed crossing of a card wall, because there
 * are no walls. A loop is a `GFrame` drawn around its body, never a back-edge;
 * the layout invariant is that every `GEdge` flows downward (`from.y ≤ to.y`).
 *
 * Every edge is ORTHOGONAL: its polyline alternates vertical and horizontal
 * segments, and the renderer rounds the corners. A fan-out is a rail with drops,
 * a join is a bar every lane drops onto, and a skip around a branch arm turns at
 * right angles — so no edge ever cuts diagonally through a card or its text.
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
  /** Half the node's layout height — the distance from center to the top/bottom
   *  anchor an edge attaches to (0 for a hub, which is a bare junction point). */
  r: number;
  /** Width / layout height where it differs from 2·r (cards, boxes, the join bar). */
  w?: number;
  h?: number;
  /** RAW label (escaped at render). */
  label: string;
  /** Agent nodes only: did the author write the label? When `false`, the label
   *  was sliced from the prompt and is redundant with the phase row, so the
   *  workflow view's card leaves it off. Absent (hubs/barriers/etc.) ⇒ n/a. */
  labelExplicit?: boolean;
  /** Agent model (RAW), from an explicit `opts.model`; absent ⇒ the agent
   *  inherits the session model — unless `unread` says it may be set in a way
   *  the analyzer couldn't read. */
  model?: string;
  /** Agent reasoning effort (RAW, e.g. "low" / "max"); absent ⇒ inherited. */
  effort?: string;
  /** Agent `opts.agentType` (RAW) — a custom agent type may pin its own model. */
  agentType?: string;
  /** Agent options that may be set but could not be read statically. */
  unread?: Array<"model" | "effort" | "agentType">;
  /** Pre-rendered multiplicity badge, e.g. "×4" / "×N" (RAW); absent ⇒ one. */
  mult?: string;
  /** Agent nodes: the laid-out card (label lines, model line, meter, stack). */
  card?: CardSpec;
  /** Task nodes: a `workflow()` sub-workflow call, or orchestration the analyzer
   *  could not read structurally (an honest opaque box). */
  task?: "workflow" | "opaque";
  /** Hub nodes: a FORK (the junction a fan-out rail leaves from) rather than a
   *  pass-through stub standing in for an empty branch arm. */
  fork?: boolean;
  /** Decision nodes: which side of the diamond its condition is set on — the
   *  side a branch arm's edge does not leave from. */
  labelSide?: "left" | "right";
  /** Index into `Layout.lanes` — the lane this node landed in. */
  phase: number;
  /** Full text behind a truncation, surfaced as a `<title>` (RAW). */
  tooltip?: string;
  /** Abrupt JS flow represented by a control node. */
  flow?: "continue" | "break" | "return" | "throw" | "terminal";
  /** Decision nodes only: this branch is a loop-control GUARD (`if (…) continue;`
   *  / `break;` with no real work in the taken arm) — plumbing, not the loop's
   *  purpose. */
  isGuard?: boolean;
  /** Decision/guard nodes only (placement-internal): this guard's taken arm is an
   *  abrupt `continue` / `break` — drawn as a control ARC from the diamond instead
   *  of a separate box (see `ControlArc`); `guardOutcome` is the condition outcome
   *  ("yes"/"no") that triggers it. */
  guardFlow?: "continue" | "break";
  guardOutcome?: string;
}

/**
 * Edge roles: `seq` ordinary sequential flow (incl. cross-phase); `fan` fork →
 * member inside a parallel or pipeline; `stage` pipeline stage→stage; `merge` a
 * member or arm dropping onto the join bar it waits at.
 */
export type GEdgeKind = "seq" | "fan" | "stage" | "merge";

export interface GEdge {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  /** Orthogonal polyline from the source's exit anchor to the target's entry
   *  anchor (≥ 2 points; consecutive points share an x or a y). */
  points: ReadonlyArray<{ x: number; y: number }>;
  /** RAW edge label (e.g. a branch arm's condition outcome). */
  label?: string;
  kind: GEdgeKind;
}

/**
 * A loop, drawn as a frame around the body it repeats: the faithful summary of a
 * loop (body placed once, the repetition shown as the enclosure itself, with the
 * verbatim condition on its header) — NEVER a back-edge. Nested loops nest frames.
 */
export interface GFrame {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Lanes holding the frame's top and bottom — so lane co-registration moves
   *  each edge of the frame with the lane it sits in. */
  topLane: number;
  botLane: number;
  /** The loop keyword drawn before the condition. */
  keyword: "while" | "for";
  /** RAW verbatim condition (or loop header) slice. */
  condition: string;
  /** Full condition when `condition` was truncated (RAW). */
  tooltip?: string;
  /** Literal iteration count, when the loop walks a literal collection. */
  iterations?: number;
  /** Where the header text starts: at the frame's left, unless an edge enters
   *  the body from above and the text would cross it — then just right of it. */
  headerX: number;
  /** The loop body's entry node. */
  entry: string;
  /** The frame of the loop directly around this one, if nested. */
  outer?: string;
}

/**
 * A control-flow ARC drawn between two placed nodes — the faithful picture of an
 * abrupt jump the downward flow can't carry: `continue` returns from a guard
 * diamond to the top of its loop's body (the guard itself, when it heads the
 * body); `break` leaves the loop for its successor.
 *
 * NOT a `GEdge`: it is exempt from the downward invariant by design, and routed
 * at render time from LIVE node positions — so every placement shift (lane
 * co-registration) carries it along for free. It runs in the lane `ARC_LANE`
 * reserves inside its loop's frame, left of the body.
 */
export interface ControlArc {
  /** Source node id — the guard diamond the jump leaves from. */
  fromId: string;
  /** Target node id — the loop body entry (continue) or successor (break). */
  toId: string;
  /** The abrupt flow this arc pictures. */
  flow: "continue" | "break";
  /** Condition outcome that triggers it ("yes"/"no"), drawn beside the source. */
  outcome: string;
  /** The frame whose left lane the arc runs in (the guard's own loop). */
  frame?: string;
  /** For an arc back to the top of a loop body: that loop's frame — the arc
   *  re-enters from above any loop nested at the top of the body. */
  into?: string;
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
  /** Phase model declared in `meta` (RAW); absent for control-only arms. */
  model?: string;
}

/** A phase as a row of the swimlane table, spanning wherever its nodes landed. */
export interface GLane {
  /** Position in `Layout.lanes` — the index every node's `phase` points at. */
  phaseIndex: number;
  /** 1-based chip number shown for a single-phase lane (its ORIGINAL phase
   *  position — which can differ from `phaseIndex` once a parallel group
   *  collapses earlier phases into one row). */
  ordinal: number;
  /** RAW band title. */
  title: string;
  /** Phase model declared in `meta` (RAW); absent for control-only bands. */
  model?: string;
  /** When ≥2 concurrent phases collapsed into THIS one row, their per-arm
   *  sub-cells to draw side by side (each its own chip/title/model). Absent for
   *  an ordinary single-phase lane. */
  members?: LaneMember[];
  /** Top of the row. */
  yTop: number;
  /** Bottom of the row. */
  yBot: number;
  /** No agent/task node landed here → render a slim control strip. */
  empty: boolean;
}

export interface Layout {
  /** The graph's coordinate frame width (== `svg-primitives` W). */
  width: number;
  /** Graph content height; the renderer adds the header card and margins. */
  height: number;
  lanes: GLane[];
  nodes: GNode[];
  edges: GEdge[];
  /** Loop frames, in placement order: a nested loop's frame comes before the
   *  frame of the loop around it (the renderer paints larger frames first). */
  frames: GFrame[];
  /** Control-flow arcs (continue/break) drawn as decorations, NOT edges —
   *  so they never appear in `edges` and never violate the downward invariant. */
  controlArcs: ControlArc[];
  /**
   * Honest placement-time degradations the renderer needn't draw but the CLI
   * surfaces (e.g. a wide fan-out collapsed to ×N). Nothing is ever silently
   * dropped.
   */
  notes: string[];
}
