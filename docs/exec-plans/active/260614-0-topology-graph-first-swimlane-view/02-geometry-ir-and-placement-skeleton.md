# Unit 02 — Geometry IR + placement skeleton

## Goal
Establish the new seam: positioned-geometry types + a placement entry that consumes the analyzer TREE IR directly, correct for the trivial cases.

## Changes
- NEW `ts/topo-geometry.ts` — the positioned output the renderer consumes:
  - `GNode { id; x; y; r; kind: "agent"|"barrier"|"decision"|"task"|"hub"; label; model?; mult?; phase }`
  - `GEdge { from; to; points: {x,y}[]; label?; kind: "seq"|"fan"|"stage"|"merge" }`
  - `GLoop { onNode; label }` (the local repeat badge — NOT an edge)
  - `GLane { phaseIndex; title; model?; yTop; yBot; empty: boolean }`
  - `Layout { width; height; lanes: GLane[]; nodes: GNode[]; edges: GEdge[]; loops: GLoop[] }`
  - All strings RAW (escaped at render). No `band`/gutter concepts.
- NEW `ts/place-topology.ts` — `placeTopology(topology: Topology, meta: Meta): Layout`.
  - Skeleton: group consecutive top-level steps by `phase`; emit one `GLane` per phase in meta-then-body order (empty phases flagged); place a single `agent` step centered in its lane; advance a vertical cursor by lane height; fixed content width constant.
  - Complex shapes return a placeholder node for now (honest "task" node), filled in Unit 03.
- Centralize geometry constants (width, lane padding, node radius, gaps) in one block.

## Acceptance / tests (hand-built `Topology`, never source)
- Single `agent`, one phase → one lane, one centered node, no edges.
- Two phases, one agent each → two lanes stacked, one `seq` edge phase1→phase2 with mostly-vertical `points`.
- `placeTopology` total: a tree with an unknown step kind degrades to a placeholder node + lane, never throws.

## Notes
Consumes `topology.ts` directly — no flat IR import. Determinism: nodes/edges in emission order.
