# Unit 05 — Renderer: positioned geometry → SVG

## Goal
Rewrite `render-topology.ts` to draw a `Layout`: the header card, swimlane stripes, model-colored nodes, control glyphs, and local loop badges — reusing existing primitives.

## Changes
- `renderTopology(layout, meta) -> string`:
  - Header card (title / description / when-to-use) — reuse existing helper.
  - **Swimlane stripes:** faint tint behind each lane (tint derived from the phase `model`, neutral otherwise), phase number + title + model chip at the lane's top-left. Empty lanes → slim strip styling.
  - **Nodes:** agent circles model-colored (reuse `MODEL_SWATCHES`); `×N` / named-mult badges; barriers (coral bars); decision diamonds (quiet — small, condition in caption/`<title>`); task/opaque nodes.
  - **Edges:** draw from `GEdge.points`; arrowheads as explicit filled triangles (resvg-safe, no `<marker>`).
  - **Loop badges:** local "↻ repeat while/until `<cond>`" arc + label on the badge's node — never a routed path.
  - **Fans:** every member connects to its barrier/next (no dangling).
- Keep ALL paint in named palette constants; coral control accent `#e8694a`; W = fixed content width.
- `render-svg.ts` (phases view) untouched.

## Acceptance / tests
- Snapshot SVGs for the corpus shapes (built from hand IR through place+render).
- Assertions: no `xband`/gutter classes; no path that routes upward; named-mult fan shows N onward edges; empty phase renders as a strip not a numbered card.
- Determinism: identical bytes across runs.

## Notes
resvg-safe SVG 1.1 subset (the project rasterizes with `@resvg/resvg-js`). Escape all raw IR strings here.
