# Unit 03 — Render the phase-flow SVG
**Blocked by:** 02-extract-and-validate-the-workflow-meta-block**Agents involved:** main only**Topology:** none
## Summary

Turn the typed `meta` model into a styled SVG string — a clean vertical phase flow — with no external layout engine.

### Tasks
- `ts/render-svg.ts`: `renderSvg(meta: Meta): string`. Layout: a header block (name + description, optional whenToUse), then a vertical stack of phase cards. Each card: an index chip (1, 2, …), the phase title, the detail text, and a model badge colored by model.
- Adapt the model→color palette and node conventions from planview's `ts/mermaid.ts` `emitClassDefs()` (haiku/sonnet/opus colors) — but emit raw SVG `<rect>`/`<text>`, **not** Mermaid.
- SVG-safe text escaping (adapt `htmlEscape` from `ts/html.ts`); basic wrapping/truncation so long titles/details don't overflow.
- Handle the no-phases case (render just the header card).
- `ts/__tests__/render-svg.test.ts`: feed models; assert SVG structure (well-formed root `<svg>`, one card group per phase, model-badge color present); snapshot a representative output; assert `<>&"` escaping in labels.

### Acceptance
- Valid, well-formed SVG for: multi-phase + models, no-detail phases, and no-phases; labels escaped; output opens cleanly in a browser/preview.

### Notes
- Deliberately linear layout — `ts/graph.ts` dependency-layering is NOT used (phases are pre-ordered). Real graph layout (elkjs/dagre) is a future, body-parsing concern.
- Not wired to CLI output yet — Unit 04 does that (intentional forward-reference).

## Review pipeline

- [ ] `/code-review` — built-in local-diff reviewer (Claude): correctness bugs + reuse/simplification/efficiency. (Not `/code-review:code-review`, the PR plugin.)
- [ ] codex cross-lineage 2nd opinion (GPT) over the same working-tree diff, before commit:
  ```sh
  codex exec -s read-only "Second opinion on the working-tree diff. Plan at plan/260607-0-build-claude-workflows-viz-workflow-meta-to-svg-and-png — read 03-render-the-phase-flow-svg.md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief."
  ```
---
See `progress.md` for the cursor and overall plan state.
