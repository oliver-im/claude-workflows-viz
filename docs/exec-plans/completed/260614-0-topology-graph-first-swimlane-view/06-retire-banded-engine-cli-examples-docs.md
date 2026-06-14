# Unit 06 — Retire banded engine, wire CLI, regen examples, update docs

## Goal
Delete the old banded path, make the graph-first swimlane render the `--view topology` output end-to-end, regenerate the corpus, and correct the docs.

## Changes
- **Delete:** `ts/flatten-topology.ts`, `ts/topology-ir.ts`, `ts/layout-topology.ts`, and their `__tests__` + snapshots.
- **Wire:** the `--view topology` entry (in `topology.ts` orchestration / `cli.ts`) now calls `analyze-body → place-topology → render-topology`. Preserve the total-function fallback: analysis failure or `hasOrchestration === false` ⇒ v1 phases page (stderr warning, exit 0).
- **Regenerate** all 8 `examples/*.svg` + `*.png` from the new renderer.
- **Docs:**
  - `README.md` — update the topology description (graph-first swimlane, vertical, faithful); refresh the gallery note.
  - `design-context.md` — correct **§8** (drop the "reads like the hand-designed catalog" claim; state the graph-first swimlane reality + that motif inference was rejected); record the **focused-hand-roll vs dagre** decision (dagre = documented fallback) under §7.
  - Move this plan `active → completed` per repo convention; update `progress.md`.

## Acceptance
- Corpus renders cleanly: **0 cross-card edges across all 8** (the `xband-edge` grep returns 0 everywhere), no empty numbered cards, loops are local badges, named-mult fans connect onward.
- `--view phases` **byte-identical** — the committed `render-svg` snapshot is unchanged (the permanent gate).
- `npm run build` + `npm test` green; CLI smoke (`node dist/cli.js examples/choose-approach.js`) emits valid SVG.

## Notes
The "0 cross-card edges" grep over `examples/*.svg` is the headline before/after proof (today: 4 of 8 have one).
