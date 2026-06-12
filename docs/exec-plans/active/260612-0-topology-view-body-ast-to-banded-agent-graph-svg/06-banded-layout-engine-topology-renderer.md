# Unit 06 — Banded layout engine + topology renderer
**Blocked by:** 05-flattener-tree-to-renderable-graph**Agents involved:** main only**Topology:** none
## Summary

Land the hand-rolled deterministic layout (`ts/layout-topology.ts`) and the SVG renderer (`ts/render-topology.ts`). Pure functions of `(meta, TopologyIR, bandTitles)`; NOT yet wired to the CLI (forward reference — Unit 07). Tests run on hand-built IR literals only.

### Layout (`layoutTopology(...) → TopoScene`)

Constants (single block, tunable): `GUTTER_W_BASE=34`, `GUTTER_LANE_STEP=9`; graph paddings `GRAPH_PAD_X=18, GRAPH_PAD_TOP=14, GRAPH_PAD_BOTTOM=14, CAPTION_H=17`; nodes `NODE_R=11, ROW_H=34, DIAMOND_HALF=14, BARRIER_W=6, BARRIER_OVERHANG=8, TASK_H=26`; `COL_GAP=34`; label widths `LABEL_BELOW_MAX_W=88, LABEL_RIGHT_MAX_W=104`; thresholds `NAMED_SHOW_MAX=4, EXACT_DRAW_MAX=4`; fonts 11/10.5/10/9.5/11.5; cross-band lane metrics `LANE_H=11, LANE_PAD=6`.

Per band: empty node set → **fallback band** (v1 `renderPhaseCard` byte-equal). Else: longest-path column layering over intra-band edges (relax in IR order; defensive: drop cycle-closing edges, out-of-range bands, dangling endpoints — silently, deterministically); multiplicity → rows (exact ≤4: n circles, shared right label; exact ≥5/unknown: echo circle + accent `×n`/`×N`; named ≤4: per-name right labels; named >4: 3 + dashed "+n more"); label below (≤2 wrapped lines) for single-row columns, right for stacks and for any cross-band departure source; column footprints → x prefix sums with COL_GAP, scale-to-fit if over graph width; rows centered on a flow midline; barrier spans its fan-in rows ± overhang. Page pass: gutter reserved iff loops or band-skipping forwards exist; bands stacked with `gapAfter = max(GAP, LANE_PAD*2 + LANE_H*laneCount)`; cross-band routes computed in page coords.

### Routing

Straight midline edges with triangle arrowheads; fan-out as per-row diagonals; fan-in horizontals into the barrier, single exit from bar midpoint; branch arms as diagonals with the "yes"/"no" label near the origin; adjacent-band forward edges exit bottom-center → gap lane → target top (arrowhead down); non-adjacent forwards via the gutter; **loops always via the left gutter** (bottom departure run → gutter lane up → top-approach run → arrowhead down into target top; corners as r=10 quarter-arcs via `roundedElbowPath`); loop label italic accent, on the bottom departure run. Collision avoidance by construction (the constrained vocabulary cannot overlap; the one accepted imperfection — a loop's top-approach passing above earlier columns' clear headroom — gets a code comment).

### Renderer (`renderTopologySvg(meta, ir, bandTitles): string`)

Page: bg, header card (x/w-parameterized), bands ascending, then a cross-band overlay group. Graph bands: v1 chrome (index chip, title, model badge) + one truncated caption line (11.5px `#64748b`) + full detail as an escaped `<title>` child (resvg ignores it — verified; browsers tooltip it). Palette: `ACCENT="#e8694a"` (barriers, loop arcs/labels/heads, decision strokes, ×N), `EDGE="#475569"`, `EDGE_UNTAKEN="#cbd5e1"` (+`stroke-dasharray="4 3"`), `LABEL="#334155"`, `LABEL_MUTED="#94a3b8"`, captions `#64748b`; node fills via existing `swatchFor` (model swatches; fallback otherwise); tasks use the fallback swatch. Countable classes for tests: `agent-node`, `barrier`, `decision`, `task-node`, `loop-path`, `xband-edge`, `arrowhead`, `xn-badge`; fallback bands keep `phase-card`. Everything escaped via `escapeSvgText`; coords through `round()`; deterministic.

### Tests

`layout-topology.test.ts`: 3-chain columns/midline; fanout-3 + barrier span; named-5 → 3+"+2 more"; 6-column scale-to-fit within card; gutter on/off → cardX shift (no-loop pages keep cardX=24, v1 parity); two forwards through one gap → distinct lanes + widened gap; kitchen-sink brute-force pairwise bounding-box disjointness; determinism; defensive drops. `render-topology.test.ts`: per-band glyph counts; model swatch fills on circles; escaping of hostile labels/names/hints/captions/`<title>`; fallback band byte-equal to `renderPhaseCard`; caption truncation + tooltip presence; one kitchen-sink snapshot (fanout + barrier + decision + cross-band edge + loop in one IR).

Review focus: determinism, scale-to-fit overflow safety, escaping completeness, fallback byte-equality. (resvg compat of dasharray/arc paths/`<title>` was pre-verified during design.)

## Review pipeline

- [ ] `/code-review`
- [ ] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
