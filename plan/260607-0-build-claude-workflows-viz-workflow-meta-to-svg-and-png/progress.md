# 260607-0-build-claude-workflows-viz-workflow-meta-to-svg-and-png — Progress

**Cursor:** 03-render-the-phase-flow-svg (not started).

**Review approach:** each unit lands on its own branch (`unit-NN-<slug>`) merged into `main` with `--no-ff`, so every unit has a real git diff to review. Gate each unit with `/code-review` (this session is rooted at this repo); if it ever mis-roots to planview, fall back to an independent `feature-dev:code-reviewer` subagent pointed here by path. Per planview v0.3.0, each unit also gets a **codex cross-lineage 2nd opinion** (`codex exec -s read-only` over the same working-tree diff, before commit) — a different model family to catch shared blind spots. codex CLI 0.136.0, logged in. Exact command per unit is in each unit md's Review pipeline.

## Pre-execution review

Before starting the first unit, run these against the freshly materialized plan dir:

- [~] `/planview:pre-plan-review` — waived this session: the design was adversarially stress-tested during planning (SVG-vs-Mermaid, single-binary-vs-deps, scope, prior-art, naming). Run on request.

## Done

- **01-scaffold-the-claude-workflows-viz-project** — new sibling repo `../claude-workflows-viz` scaffolded (TS + esbuild + commander + vitest + zod + acorn + `@resvg/resvg-js`). `npm run build` → `dist/cli.js`; `--version`/`--help` work; `tsc --noEmit` clean; smoke tests pass. CLI action is an intentional stub until Unit 04. **Reviewed:** scaffold clean (esbuild config, shebang/banner, `external`, smoke tests all correct). **Committed:** merge `f92a3a6`.
- **02-extract-and-validate-the-workflow-meta-block** — `ts/extract-meta.ts` (acorn parse → locate `meta` init → **static AST literal evaluator**, no execution) + `ts/model.ts` (zod) + 5 fixtures. `tsc --noEmit` clean; 9 tests pass (incl. a regression test proving a getter in `meta` is rejected, not executed). **Reviewed** by independent subagent; 2 findings, both fixed: (1) `node:vm` `runInNewContext` *executed* getters/methods → replaced with the static evaluator to uphold "never execute"; (2) value `import { z }` used only as type → `import type { ZodError }`. **Committed:** merge `facb322`.

## Blockers

_None._

## Notes

- **Git workflow:** genesis commit holds `plan/` + `docs/`. Each unit = a branch `unit-NN-<slug>` → `git merge --no-ff` into `main` (one merge commit per unit); verify `tsc --noEmit` + tests green before committing; delete the branch after merge.
- **Design context & rationale** (why SVG-not-Mermaid, TS-not-Rust, scope, prior art, naming, future roadmap): read `../../docs/design-context.md` — captures the decisions behind this plan from the design conversation.
- When resuming, read this file first to find the cursor unit, then read the cursor unit's md. Skip `overview.md` unless this is the first session on the plan.
- On the **first session**, run the Pre-execution review checklist above before starting the cursor unit. Surface findings and revise the plan if anything material lands.
- Work one unit at a time. After finishing the cursor unit, run its review steps, then update this file: move the unit into Done with a one-liner and advance the cursor to the next unit id.
- Stop after each unit. Surface a brief summary to the user and wait for explicit go-ahead before starting the next unit. If the unit is blocked, record it under Blockers and stop without advancing the cursor.

## Plan-level review

After the last unit's review lands and is committed, run these against the cumulative plan diff:

- [ ] `/planview:plan-review-prompt`
