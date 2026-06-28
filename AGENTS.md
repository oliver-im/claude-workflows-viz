# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`claude-workflows-viz` is a deterministic CLI that renders a Claude Code **dynamic workflow** `.js` file as an SVG/PNG diagram. The defining invariant: it **never executes the workflow**. The declarative `meta` block is read with a static AST literal-evaluator (not `vm`/`eval` — `vm` silently runs getters/methods, which is a correctness *and* safety hole), and the imperative body is statically analyzed off the same AST into a topology tree. No `eval`, no `import()`, no headless browser.

Two views:
- **topology** (default) — the body as a swimlane table: one continuous top-to-bottom agent graph in a right column, each `phase()` a co-registered row whose label cell sits to its left (phase-as-row, not phase-as-container). Fan-outs/barriers, pipeline stages, decision diamonds, and loops (`↻ repeat` badges) all become one graph.
- **phases** (`--view phases`) — the original meta-only phase cards, preserved byte-for-byte. Also the fallback when the body recovers nothing.

## Repository State

TypeScript source lives in `ts/`, bundled to `dist/cli.js` via esbuild (`scripts/build.mjs`). `dist/` is **gitignored** and built on demand — run `npm run build` after changing `ts/` (it is also rebuilt automatically on `pretest`, and on `prepack` so the npm tarball always carries a fresh bundle). `npm test` runs the vitest suite (`pretest` builds first); `npm run typecheck` runs `tsc --noEmit`. CI (`.github/workflows/ci.yml`) gates PRs on typecheck + test + build.

The render pipeline (`ts/cli.ts` is the commander entry):
1. **Parse** the file with acorn; locate top-level `export const meta`.
2. **`extract-meta.ts`** — static literal-eval of the `meta` object (rejects every executable construct), then validate with zod.
3. **`analyze-body.ts`** — walk the AST into a topology tree (`topology.ts`): `agent()`/`workflow()` calls, `parallel()` barriers, `pipeline()` stages, loops, branches. Counts come only from literals (unresolvable fan-out → `×N`); condition labels are verbatim source slices; unrecognized orchestration degrades to an honest opaque step.
4. **`place-topology.ts` / `topo-geometry.ts`** — hand-rolled, phase-driven placement into geometry (no dagre/elk dependency).
5. **`render-topology.ts` / `render-svg.ts` / `svg-primitives.ts`** — emit SVG; **`render-png.ts`** rasterizes via `@resvg/resvg-js` (native, no browser); **`html.ts`** for `--format html`; **`emit-json.ts`** dumps the full static analysis for `--format json`.

`model.ts` maps a phase/agent `model` to its color swatch (opus/sonnet/haiku, matched inside full ids like `claude-opus-4-8`).

## Grammar levels

The workflow grammar is owned by Claude Code and not formally versioned upstream. This tool pins the moving target under its own monotonic **grammar level** (`requiredLevel ≤ recognizerLevel`), reconciled against a captured baseline in `spec/upstream/<date>-cc-<ver>/` (the verbatim tool description + input schema + a `manifest.json` of sha256s — intentionally committed so the baseline is reproducible offline). `feature-detect.ts` + `grammar.ts` implement per-file detection; the ledger is `docs/GRAMMAR-CHANGELOG.md`. The drift check is `npm run check-grammar` — it **requires a local Claude Code install** to re-capture, so it is *not* run in CI.

## Examples corpus

Bundled workflows live under a per-level directory (`examples/level-1/` today); each declares its level in-file (a `Grammar level: N` header). `npm run regen-examples` rebuilds the committed SVG/PNG renders. `ts/__tests__/examples.grammar.test.ts` enforces that the directory, the in-file stamp, and what the file actually uses all agree, so a sample can't silently drift past the recognizer.

## When Implementing

- **Never execute the workflow** — this is the headline guarantee. Keep `meta` on the static literal-evaluator and the body on AST analysis. No `vm`, `eval`, `import()`, or browser.
- **Render what the body says, verbatim** — the renderer is deliberately literal; it never paraphrases or guesses what code "means." Prose generation belongs to the `workflow-readability` skill (`skills/workflow-readability/`), an authoring pass that rewrites the workflow's *own* strings; the binary stays a faithful renderer.
- **Degrade honestly** — unresolvable counts render `×N`, unknown orchestration becomes an opaque step, an empty recovery falls back to the meta-only phases page. Never invent structure you can't prove from literals.
- **Rebuild `dist/`** after touching `ts/`, and keep the corpus renders regenerated (`npm run regen-examples`) when output changes.
- **Runtime:** Node ≥ 20 (acorn + zod + commander + `@resvg/resvg-js`, bundled via esbuild).

## Project history

`docs/exec-plans/completed/` holds the jidoka-style plan dirs (`overview.md` + `progress.md` + per-unit files) for each major build phase; `docs/design-context.md` captures the original design decisions and rejected alternatives.
