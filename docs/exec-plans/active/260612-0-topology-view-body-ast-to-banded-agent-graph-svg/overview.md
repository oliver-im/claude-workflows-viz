# 260612-0-topology-view-body-ast-to-banded-agent-graph-svg — Topology view: body AST to banded agent-graph SVG
## Goal

Topology view: body AST to banded agent-graph SVG.
## Context

v1 renders only the static `meta` block — a linear stack of phase cards. The agent topology (fan-outs, barriers, pipelines, loops, branches — the "Six Workflow Patterns" shapes) lives in the workflow's imperative body, which v1 deliberately never reads. planview (the ancestor repo) rendered topology because its input *declared* the graph (`agents[].blocked_by` JSON); workflow files declare nothing, so the graph must be **statically inferred** from the body's AST. This plan executes the roadmap item recorded in `docs/design-context.md` §7: "Parse the imperative body via AST → agent graph. Mark dynamic parts honestly ('loop of N'); never fake counts."

**Architecture (3 stages, one parse):** `parseWorkflowSource` (acorn, shared with meta extraction) → **analyzer** (`ts/analyze-body.ts`: AST → tree IR, source-faithful nesting) → **flattener** (`ts/flatten-topology.ts`: tree + meta → flat node/edge/loop graph + band titles) → **banded layout + renderer** (`ts/layout-topology.ts` + `ts/render-topology.ts`: hand-rolled deterministic layout, v1 page skeleton with per-band mini-graphs).

## Decisions (locked, v2)

- **Never-execute extends to the analyzer**: static AST reading only; the only value-level reasoning is literal-resolution of module-level `const`s (`tryEvalLiteral`). No eval/vm/Function/import(), no symbolic evaluation.
- **Honesty rules**: counts only from literals (else "×N"); condition labels are verbatim truncated source slices; `expandedLabels` only by pure textual substitution; every degradation emits a note or an opaque step — nothing silently dropped.
- **Topology is the DEFAULT view** (user decision); `--view phases` is the v1 escape hatch. No `auto` mode: degradation is per-band (a band with nothing recovered renders exactly like a v1 card), so empty analysis ≙ v1 output. CLI wraps analysis in try/catch → stderr warning + v1 fallback, exit 0.
- **Zero new runtime deps**: hand-rolled banded layout (dagre/elkjs/D2 stay the future upgrade path). W=760; resvg-safe SVG 1.1 subset; arrowheads as explicit filled triangles (no `<marker>`); coral control-flow accent `#e8694a`; no legend; graph bands show one truncated caption + full detail in an escaped `<title>`.
- **IR seam**: analyzer emits a structured TREE (`ts/topology.ts`); the flattener (`ts/flatten-topology.ts`) produces the flat node/edge/loop graph (`ts/topology-ir.ts`) + `bandTitles`. IR strings are raw — escaping happens at render. No zod for IR (internally produced).
- **v1 output stays byte-identical** under `--view phases`; the committed `render-svg` snapshot is the permanent regression gate (never regenerate it).
- Plans live under `docs/exec-plans/` from now on (user decision); Unit 01 migrates the completed v1 plan there.

## Out of scope (v2)

- Trace mode from `agent-*.jsonl` journals (render the *actual* run).
- Per-pattern art-directed templates.
- Meta-declared topology hints (no schema extension).
- `untaken`-arm inference — the IR field exists for future trace mode; the analyzer never sets it.
- `switch`/`&&`/`||` as branches (degrade to opaque + note).
- dagre/elkjs/D2 layout engines.

## Unit list

| # | Title | Blocked by | Reviews |
|---|---|---|---|
| 01 | Move the completed v1 plan to docs/exec-plans/completed | — | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 02 | Foundations — shared primitives, parse refactor, and both IR contracts | 01 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 03 | Analyzer core — sequential recognition with honest degradation | 02 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 04 | Analyzer structural recognizers — parallel, pipeline, loops, branches | 03 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 05 | Flattener — tree to renderable graph | 04 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 06 | Banded layout engine + topology renderer | 05 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 07 | CLI default flip, end-to-end smoke, example regen, and docs | 06 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
## Cross-cutting constraints

- NodeNext ESM (`.js` import specifiers for local `.ts`); strict TS with `noUnusedLocals`/`noUnusedParameters` (NO `noUncheckedIndexedAccess`); match the repo's comment density and doc-comment style.
- acorn walk style precedent: plain recursive functions over `any`-typed nodes (no acorn-walk dependency).
- The analyzer is a **total function** — never throws on weird-but-valid JS; per-statement try/catch degrades locally.
- Determinism everywhere: same input ⇒ same SVG string (no Date/random; IR array order is canonical).
- Test fixtures: the 8 `examples/*.js` are the integration corpus; corpus-wide invariant after Unit 04 = zero opaques, zero notes. Layout/render tests consume hand-built IR literals, never workflow source.

## References

- `docs/design-context.md` — v1 decisions, rejected alternatives (vm/eval, mermaid backend, execute-with-stubs), §7 roadmap this plan executes, §8 rendering-quality expectation.
- `docs/exec-plans/completed/260607-0-build-claude-workflows-viz-workflow-meta-to-svg-and-png/` (after Unit 01) — the v1 build plan.
- planview prior art: `../planview/ts/mermaid.ts` (model→color classDefs, adapted as `MODEL_SWATCHES`), `../planview/ts/types.ts` (the declared-topology input this tool's inference replaces).
- The "Six Workflow Patterns" figure — the visual vocabulary target (circles/diamonds/barrier bars/loop arcs).
