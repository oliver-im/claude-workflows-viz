# Unit 02 — Foundations — shared primitives, parse refactor, and both IR contracts
**Blocked by:** 01-move-the-completed-v1-plan-to-docs-exec-plans-completed**Agents involved:** main only**Topology:** none
## Summary

Extract the v1 SVG primitives into a shared module, refactor `extract-meta.ts` so the acorn parse is reusable, and land BOTH frozen contracts (tree IR for the analyzer, flat IR for the renderer) so every later unit codes against fixed types. v1 output must remain **byte-identical** — the committed `render-svg` snapshot is the regression gate and must not be regenerated.

### Deliverables

1. **`ts/svg-primitives.ts` (new)** — moved verbatim from `render-svg.ts`: `text`, `roundRect`, `round`, `escapeSvgText`, `fitChars`, `truncatePlain`, `truncateToWidth`, `wrapToWidth`, `Swatch`, `MODEL_SWATCHES`, `MODEL_FALLBACK`, `swatchFor`, plus shared `W=760`, `MARGIN=24`, `GAP=16`, `interface Block`. New generic path helpers (used by Unit 06; trivial enough to land with the module): `strokePath(d, stroke, opts?)`, `polyline(pts, stroke, opts?)`, `roundedElbowPath(pts, r, stroke, width?)` (axis-aligned elbows, quarter-arc corners), `arrowHead(tipX, tipY, angle, fill)` (filled triangle, length 7, half-width 3.5).
2. **`ts/render-svg.ts` (modified)** — imports primitives; `renderHeader(meta, x, w)` and `renderPhaseCard(phase, index, x, w)` become exported and (x, w)-parameterized (topology bands shift cards right when a loop gutter exists); `renderSvg(meta)` keeps its exact signature and output.
3. **`ts/extract-meta.ts` (modified)** — split without breaking API: `parseWorkflowSource(src): acorn.Node` (the existing parse + error wrapping), `extractMetaFromProgram(program): Meta`, `readWorkflowSource(path): string` (the existing readFileSync + `cannot read '<path>': …` message), `tryEvalLiteral(node): {ok:true; value:unknown} | {ok:false}` (lenient sibling of `evalLiteralNode`, same supported node set, no throw). `extractMetaFromSource` and `extractMeta` become compositions; all existing tests pass untouched.
4. **`ts/topology.ts` (new)** — the analyzer's tree IR:
   - `SourceSpan {start, end}`; `Multiplicity = {kind:"one"} | {kind:"exact"; count} | {kind:"named"; names: string[]} | {kind:"unknown"; hint?: string}`.
   - `StepBase {phase: string | null; span}` — phase = band title in lexical effect (raw text).
   - `AgentStep {kind:"agent"; label; expandedLabels?; multiplicity; model?; agentType?; promptPreview?}`; `WorkflowStep {kind:"workflow"; label; multiplicity}`; `OpaqueStep {kind:"opaque"; label}`.
   - `ParallelStep = {kind:"parallel"} & ({form:"branches"; branches: Step[][]} | {form:"fanout"; multiplicity; body: Step[]})`.
   - `PipelineStep {kind:"pipeline"; items: Multiplicity; stages: Step[][]}`; `LoopStep {kind:"loop"; loopKind; conditionLabel; iterations?; body: Step[]}`; `BranchStep {kind:"branch"; conditionLabel; thenSteps; elseSteps}`.
   - `Step` union; `BandRef {title; inMeta}`; `AnalysisNote {message; span?; snippet?}`; `Topology {steps; bands; notes; hasOrchestration}`.
   - Truncation constants `COND_MAX=48, LABEL_MAX=40, PROMPT_PREVIEW_MAX=80, HINT_MAX=24, OPAQUE_LABEL_MAX=40`; helper `sliceSource(src, span, max)` (slice → collapse whitespace → ellipsis-truncate).
5. **`ts/topology-ir.ts` (new)** — the renderer's flat IR: `NodeKind = "agent" | "barrier" | "decision" | "task"`; `FlatMultiplicity = {kind:"exact"; n} | {kind:"named"; names} | {kind:"unknown"; hint?}` (absent = single); `TopoNode {id; band: number; kind; label; model?; mult?; untaken?}`; `TopoEdge {from; to; label?; untaken?}` (invariant: band(from) ≤ band(to)); `TopoLoop {from; to; label?}` (band(from) ≥ band(to)); `TopologyIR {nodes; edges; loops}` (node array order is canonical for determinism); `EMPTY_IR`.

### Tests

- `extract-meta.test.ts` additions: `parseWorkflowSource`+`extractMetaFromProgram` composes identically to `extractMetaFromSource`; `tryEvalLiteral` returns `{ok:false}` (no throw) on a call expression.
- Full suite green AND `ts/__tests__/__snapshots__/render-svg.test.ts.snap` **unchanged on disk** (assert via `git diff --exit-code` on that path before commit).

Review focus: byte-identity of v1 output; the refactor must not weaken `extract-meta`'s security posture (same error paths, no new evaluation). The two IR files are contracts consumed by Units 03–06 (expected to be unused-by-runtime until then — not dead code, forward references).

## Review pipeline

- [x] `/code-review` — done 2026-06-12: 4 lanes (line-by-line+pitfalls, move fidelity, cross-file+byte-identity, cleanup). Move fidelity perfect; byte-identity proven end-to-end (all 8 examples md5-identical at HEAD vs HEAD^); contracts conform to Units 03–06 name-for-name; one non-blocking layering note accepted (topology.ts ← truncatePlain from svg-primitives: single source of truth).
- [x] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: done 2026-06-12: no correctness or intent-drift findings; tsc + snapshot-unchanged independently confirmed.

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
