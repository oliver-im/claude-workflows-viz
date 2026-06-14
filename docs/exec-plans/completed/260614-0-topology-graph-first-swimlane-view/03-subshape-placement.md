# Unit 03 — Sub-shape placement in phase bands

## Goal
Place every analyzer vocabulary shape as a compact, self-contained sub-graph within its phase band. This is the core of the focused layout — per-shape templates, no general graph algorithm.

## Shapes (recurse over `Step`)
- **agent** → circle; `mult` rendered as `×N` / named badge.
- **workflow / opaque** → "task" node, verbatim label.
- **parallel fanout** (`form: "fanout"`) → source hub · row of N members · barrier · sink hub, centered; spread across content width; **collapse to a single `×N` member when the row would exceed the width cap** (log the collapse). Every member gets an onward edge to the barrier.
- **parallel branches** (`form: "branches"`) → k chains → shared barrier.
- **pipeline** → stage sub-graphs chained by `stage` edges (no barrier between stages); a stage's per-item multiplicity threads onto its agents (as today).
- **branch** → `decision` node + each non-empty arm placed side-by-side, edge labeled yes/no; empty arm = labeled stub. **All arms shown** (the router fan), contained in the band.
- **loop** → place the body sub-graph, then attach a `GLoop` badge ("repeat while/until `<conditionLabel>`", verbatim) to the body. **No back-edge, no decision diamond for the loop test.** Nested same-phase loops → stacked badges.

## Connection surface
Each placed shape exposes an entry node (visual head) and exit node(s) (tail) so sequential siblings and stages connect via `place-topology`'s connector logic (Unit 04). Derive these during placement — do not resurrect the old flattener's abstract `Flat` surface.

## Acceptance / tests (hand-built IR)
- Each shape → expected node/edge counts; fan-out members each have an onward edge (no dangling).
- Loop → produces a `GLoop` badge and **zero** edges whose target is above its source (no back-edges in `Layout.edges`).
- Wide fan-out (> cap) → single `×N` node, collapse logged.
- Branch → decision + all arms present.

## Notes
Honesty: counts only from literal multiplicity; condition labels passed through verbatim. Keep within fixed content width; height is free.
