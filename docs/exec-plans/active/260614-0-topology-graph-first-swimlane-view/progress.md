# Progress — 260614-0 topology graph-first swimlane view

Status: **active**, not yet started. Branch: `topology-swimlane-view` (created in Unit 01).

## Units
- [x] 01 — Branch hygiene: clean baseline from `main`, ditch `topology-card-redesign`
- [x] 02 — Geometry IR + placement skeleton
- [x] 03 — Sub-shape placement (agent / fanout / pipeline / branch / loop)
- [ ] 04 — Swimlane composition (stack, stripes, empty→strip, connectors)
- [ ] 05 — Renderer: geometry → SVG
- [ ] 06 — Retire banded engine, wire CLI, regen examples, update docs

## Headline metric
Cross-card edges across `examples/*.svg`: **start = 4 of 8** (review-pr, dual-lineage-review, triage-issue, choose-approach) → **target = 0 of 8**.

## Done log
- **01** (93cda8c) — Discarded band-engine WIP via `git restore .`; branched `topology-swimlane-view` off `main` (498ec7d); deleted `topology-card-redesign` (was cb76aba, reflog-recoverable). `npm install && build && test` green on inherited main: 197 tests / 10 files. Plan dir committed as first commit. Decision held: **no dagre** (zero new runtime deps).
- **02** — NEW `ts/topo-geometry.ts` (GNode/GEdge/GLoop/GLane/Layout — phase-as-overlay types, RAW strings, downward-edge invariant documented) + `ts/place-topology.ts` (`placeTopology(topology, meta)`: lanes from `topology.bands`, agent/workflow/opaque leaves placed, structured shapes → honest task placeholder for Unit 03, empty bands → slim strips incl. middle + trailing, seq connectors, total function, deterministic ids). Geometry constants centralized + exported. 8 tests in `place-topology.test.ts` (trivial cases, strip wedging, totality on bogus kind, determinism). Full suite green: 205 tests / 11 files. Banded engine untouched (retired in Unit 06).
- **03** (0bb3b33→) — Per-shape templates in `place-topology.ts`: **fanout** (fork·row·barrier·sink, every member→barrier so no dangling; unknown/over-cap/over-wide collapse to ×N + `notes`), **branches** (fork→arms in their own lanes→shared barrier; concurrency via edges not columns), **pipeline** (item columns × stage rows, `stage` edges span lanes, every last cell→sink — fixes review-pr dangling fan), **branch** (quiet decision diamond, both arms shown, empty arm = labeled stub, yes/no), **loop** (body placed once + local `GLoop` repeat badge, NO back-edge; nested same-lane loops stack badges; multi-phase body → note). Added `cellBand` so a fan-out tagged on its inner agent lands in the right lane (review-pr "Adversarially verify"). `Layout.notes` added. 9 new shape tests (17 in file). **Corpus probe (throwaway): all 8 examples place with 0 upward edges**, strips correct (choose middle, triage/hunt/verify trailing), loops counted (choose=2, hunt=1), review-pr all-graph after the cellBand fix. Full suite green: 214 tests / 11 files.
