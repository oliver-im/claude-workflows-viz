/**
 * The renderer's FLAT IR: the banded node/edge/loop graph the layout engine
 * consumes. Produced only by the flattener (`flatten-topology.ts`) — all
 * graph-shape policy lives there; this module is the frozen contract. No zod:
 * the IR is internally produced, never user input. Strings are RAW — escaping
 * happens at render time.
 */

export type NodeKind = "agent" | "barrier" | "decision" | "task" | "hub";

/** Absent on a node = a single run. */
export type FlatMultiplicity =
  | { kind: "exact"; n: number }
  | { kind: "named"; names: string[] }
  | { kind: "unknown"; hint?: string };

export interface TopoNode {
  id: string;
  /** Index into the renderer's merged band-title list. */
  band: number;
  kind: NodeKind;
  label: string;
  model?: string;
  mult?: FlatMultiplicity;
  /** Reserved for future trace mode; the v2 analyzer never sets it. */
  untaken?: boolean;
}

/** Forward edge — invariant: band(from) ≤ band(to). */
export interface TopoEdge {
  from: string;
  to: string;
  label?: string;
  untaken?: boolean;
}

/** Back arc (loop) — invariant: band(from) ≥ band(to). Routed via the gutter. */
export interface TopoLoop {
  from: string;
  to: string;
  label?: string;
}

/**
 * Node array order is canonical (emission order) — determinism contract. The
 * arrays are `readonly` because everything downstream of the flattener only
 * reads the IR; the flattener builds plain mutable arrays and returns them.
 */
export interface TopologyIR {
  nodes: readonly TopoNode[];
  edges: readonly TopoEdge[];
  loops: readonly TopoLoop[];
}

/** The no-analysis graph: renders exactly as the v1 phase cards. */
export const EMPTY_IR: TopologyIR = Object.freeze({
  nodes: [],
  edges: [],
  loops: [],
});
