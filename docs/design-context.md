# claude-workflows-viz — Design Context & Decisions

> Handoff from the design conversation that produced the build plan (`plan/260607-0-build-claude-workflows-viz-workflow-meta-to-svg-and-png/`). The plan covers *what to build*; this captures *why* — decisions, rejected alternatives, prior art, and future direction — so a later session can continue with full context. Written 2026-06-07.

## 1. Why this project exists

- It started by asking whether Claude Code's **dynamic workflows** ([docs](https://code.claude.com/docs/en/workflows); "Introducing dynamic workflows" blog) affect **planview** (the sibling repo `../planview`).
- planview is really two fused things: **(a)** a plan-decomposition *methodology* (units, reviewable slices, review pipeline) and **(b)** an *orphaned* topology → Mermaid → HTML renderer that was the project's **original** purpose. planview began as a Rust topology renderer (commit `cfa5e20`); the May pivot (`e4d0757`) demoted topology to an optional per-unit fence. Its own docs now say "multi-agent diagrams aren't the headline anymore."
- **claude-workflows-viz repoints that orphaned renderer at a fresh, real input: dynamic-workflow files.** It is the renderer half, split out from planview's methodology half. (This split — planview = "a guideline for how I want to split a plan"; renderer = a separate diagram tool — was a key realization.)

## 2. The input domain (dynamic workflows)

- A workflow is a JS file: `export const meta = {…}` then an imperative body using `agent()`, `pipeline()` (no barrier), `parallel()` (barrier), `phase()`, `log()`.
- `meta` is a **pure literal** by contract: `{ name, description, whenToUse?, phases?: [{ title, detail?, model? }] }`. Required: `name`, `description`.
- The **body is dynamic** — loops (`while budget…`), classify-and-branch, fan-out whose width depends on runtime values and agent outputs. The real execution graph is *emergent* and frequently undecidable statically. **This is the crux of every scoping decision below.**
- The **six patterns**: classify-and-act, fanout-and-synthesize, adversarial-verification, generate-and-filter, tournament, loop-until-done. The "Six Workflow Patterns" figure is a *hand-designed catalog*, not auto-layout output.
- Ecosystem context: `/workflows` (live runtime monitor), `~/.claude/workflows` + `.claude/workflows` (saved), `/deep-research` (a built-in workflow), runtime journals `agent-*.jsonl`.

## 3. Core decisions (with rationale)

| Decision | Rationale |
|---|---|
| **v1 renders `meta` only** | `meta` is static and guaranteed-parseable; the body needs JS AST analysis and its dynamic parts are undecidable. Keep v1 simple and honest. |
| **Never execute the workflow** | Bodies have top-level `await agent(…)` against undefined globals. Even the `meta` expression is read with a **static AST literal-evaluator**, NOT `vm`/eval — a review caught that `vm` silently runs getters/methods (see §9). |
| **Emit SVG directly, not Mermaid** | Image output (SVG + PNG) is a hard requirement; Mermaid needs headless Chromium to rasterize, which breaks easy install. For linear `meta.phases`, layout is trivial (vertical card stack) — no layout engine needed. |
| **Rasterize PNG with `@resvg/resvg-js`** | Prebuilt native npm binding, no browser. |
| **Stack: TypeScript (npm/npx), not Rust** | The single-static-binary requirement was relaxed to "easy install, deps OK" → reuse planview's TS scaffold. Perf is irrelevant (not a hot path), so the usual "Rust for tools" argument doesn't apply. |
| **Name: `claude-workflows-viz`** | Intuitive; personal use; `-viz` names the output artifact. Accepts a crowded `claude-*workflow*` namespace. |

## 4. Rejected alternatives

- **Mermaid as the backend** — can't produce an image without a browser. (Keep at most as an optional HTML preview.)
- **`node:vm` to eval `meta`** — executes getters/methods/function-values; not a security boundary. Replaced by static AST eval.
- **Execute-the-script-with-stubs** to recover the real graph — fabricates the runtime-dependent fan-out/branches (they depend on agent outputs), needs a sandbox, and a *real run already journals the true graph*. If you ever want the actual graph, read the journal — don't simulate.
- **Rust** — viable (native binary + `resvg` crate + crib the original Rust from `cfa5e20`) but justified only by the single-binary requirement, which was dropped.
- **Names:** `flowviz` (taken — an active AI "FlowViz" that integrates Claude, flowviz.io), `workflowviz` (generic; several exist), `flowgen`/`flowmaid` (`-gen` reads as generating the *workflow*, which authoring tools already own; `-maid` locks output to Mermaid).

## 5. Prior art (the niche looks open)

- **`/workflows`** — runtime monitor, not a static file renderer.
- **Workflow Studio** (VS Code `breaking-brake.cc-wf-studio`) — an authoring canvas; opposite direction (build → export).
- **comfyui-mcp `/comfy:viz`** — closest concept: ComfyUI workflow **JSON** → Mermaid flowchart, nodes grouped in `subgraph`s by category, with typed edge labels. But it's *declarative-JSON* input (the easy case) and ComfyUI-specific. **Cribbable idioms:** group nodes into subgraphs (→ group by *phase*), the shape vocab + typed edge labels. **Do NOT copy** its `mermaid_to_workflow` round-trip — imperative JS can't be reconstructed from a diagram. It validates the "declarative workflow → diagram" approach for the easy case, which is exactly where v1 (meta-only) lives.

## 6. Reuse map (from `../planview`)

- **Crib:** `scripts/build.mjs` (esbuild single-file bundle), `ts/cli.ts` (commander), `ts/output.ts` (`writeTempHtml` / `openBrowser`), `ts/html.ts` (HTML chrome + XSS escaping), `ts/mermaid.ts` (`emitClassDefs` model→color palette — adapt to SVG `<rect>`/`<text>`), `tsconfig.json`, `vitest.config.ts`.
- **Ignore:** `parse-markdown`, `validate`, `materialize`, `hook`, `config` — all planview-specific input handling, useless here.

## 7. Future roadmap (beyond v1)

- Parse the imperative **body via AST** → agent graph (the richer visualization). Mark dynamic parts honestly ("loop of N"); never fake counts.
- **Layout engine** (elkjs/dagre) for agent graphs — or adopt **D2** (Go-native SVG, prettier auto-layout than Mermaid; pairs with resvg for PNG).
- **Per-pattern templates** for the six named patterns → reproduce the art-directed "Six Patterns" look (only works for recognized/declared patterns).
- **Trace mode:** render the *actual* run from `agent-*.jsonl` journals (accurate, retrospective) — strictly better than simulating a run.
- Optional `--format html` self-contained preview reusing planview's chrome (hybrid: HTML card chrome + inner graph).
- (planview-side idea) **topology → workflow codegen**: compile a planview topology into a runnable workflow script — would make "topology is advisory" optionally *executable*.

## 8. Rendering-quality expectation

The MVP (linear `meta.phases`) is a clean phase-flow **"spec card,"** not a call graph. The pretty "Six Patterns" aesthetic is *body-level* (intra-phase fan-out) and art-directed — that's future work (per-pattern templates, or custom SVG + a layout engine). v1 will not look like that figure, and that's by design. Mermaid wouldn't reproduce it either; D2 is prettier but still auto-layout.

## 9. Process notes / how to continue

- **Continue in a Claude session rooted in THIS repo** (`claude-workflows-viz`). The built-in `/code-review` and git target the *session's* project dir; running them from the planview session mis-fires (this is why the plan was moved here and reviews used a subagent-by-path).
- **Resume:** read `plan/260607-0-…/progress.md` first (cursor + resume protocol), then the cursor unit's md. **Cursor is at Unit 03** (the phase-flow SVG renderer).
- **Per-unit review:** from a repo-rooted session you can likely use `/code-review` directly once there's a baseline commit. Otherwise gate each unit with an independent `feature-dev:code-reviewer` subagent pointed at the repo by path. (Greenfield caveat: working-tree diffs miss *untracked* files — stage/commit, or review by path.)
- **Build state:** Units 01–02 done & reviewed; `npm test` → 9 passing; `npm run build` works; **nothing committed yet** (per-unit commits were deferred — make them when ready so review runs against real diffs).
- **planview lesson (worth recording back in planview):** its review pipeline assumes plan + code share one repo; cross-repo plans mis-aim the per-unit gate. We co-located the plan into this repo to compensate — and this whole exercise is real evidence that planview's renderer half and methodology half are cleanly separable.
