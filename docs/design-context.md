# claude-workflows-viz — Design Context & Decisions

> Handoff from the design conversation that produced the build plan (`docs/exec-plans/completed/260607-0-build-claude-workflows-viz-workflow-meta-to-svg-and-png/`). The plan covers *what to build*; this captures *why* — decisions, rejected alternatives, prior art, and future direction — so a later session can continue with full context. Written 2026-06-07.

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

- ~~Parse the imperative **body via AST** → agent graph (the richer visualization). Mark dynamic parts honestly ("loop of N"); never fake counts.~~ **Landed (v2, plan `260612-0`):** `analyze-body` (total, never-execute static analyzer) → tree IR. **Superseded (v2.1, plan `260614-0`):** the banded "card-as-container" engine (`flatten-topology` + `topology-ir` + `layout-topology`) was **retired** and replaced by `place-topology` (tree IR → positioned swimlane geometry) → `render-topology` (geometry → SVG). `analyze-body` and the tree IR (`topology.ts`) carried over unchanged; `--view phases` stays byte-identical. Honesty held: literal-only counts (`×N` otherwise), verbatim condition slices, opaque steps + v1 fallback for anything unrecovered. See §8.
- **Layout engine** (dagre/elkjs, or **D2** — Go-native SVG + resvg) for agent graphs — **the documented fallback, deliberately NOT adopted.** Both v2 and the v2.1 swimlane redesign went **focused hand-rolled, zero new deps.** The hard parts of general DAG layout (cycle-break, network-simplex ranking, NP-hard crossing-minimisation, Brandes–Köpf coordinates) exist to solve *generality*; workflows are phase-structured + small + a known sub-shape vocabulary, so placement is driven by phase order + per-shape templates, sidestepping all of it (loops local, cross-phase edges short verticals, phase = stripe). dagre/elk/D2 is the upgrade path *only* if graphs ever become genuinely general (dense intra-phase DAGs, non-sequential cross-phase edges). The earlier 46KB banded engine failed precisely by hand-rolling a *general edge router* (gutters/channels/hubs/headroom); v2.1 removed the need for one.
- **Per-pattern templates** for the six named patterns → ~~reproduce the art-directed "Six Patterns" look~~ **REJECTED (v2.1):** motif/pattern inference (recognizing a tournament/router/etc. and picking an art-directed template, or reading a `meta.pattern`) would have to *guess* the author's intent; a wrong guess is worse than an honest literal render. The renderer draws what the body literally says, never what it might be an instance of.
- **Trace mode:** render the *actual* run from `agent-*.jsonl` journals (accurate, retrospective) — strictly better than simulating a run.
- Optional `--format html` self-contained preview reusing planview's chrome (hybrid: HTML card chrome + inner graph).
- (planview-side idea) **topology → workflow codegen**: compile a planview topology into a runnable workflow script — would make "topology is advisory" optionally *executable*.

## 8. Rendering-quality expectation

The v1 page (linear `meta.phases`) is a clean phase-flow **"spec card,"** not a call graph; it survives as `--view phases`, the permanent byte-identical regression gate.

**As of the v2.1 redesign (plan `260614-0`) the topology view is a graph-first swimlane render:** the body is laid out as ONE continuous vertical agent graph, and each phase is painted as a faint stripe *behind* wherever its nodes land — **phase-as-overlay, not phase-as-container.** This retired the v2 banded "card-as-container" engine (plan `260612-0`), whose diagnosis drove the rework: because a phase card was a layout *container*, every cross-phase edge had to exit one card, cross the gap, and re-enter the next — measured at **4 of 8 examples with routed cross-card edges**, plus loops drawn as gutter back-edges, control-only phases as empty numbered cards, and a named-fan bug where only the last member connected onward. With no walls, a cross-phase edge is a short ordinary edge (0 of 8 now), loops are local "↻ repeat" badges, control-only phases are slim strips, and every fan member connects onward.

**v2.2 turned the overlay into a swimlane *table* (left/right, not top/bottom).** The v2.1 page stacked the phase cards (chip + title + detail + model badge) *above* the graph, then repeated chip + title + badge *again* as in-graph stripe chrome — the same labels drawn twice, in a tall portrait page. v2.2 moves the phase labels into a **left column** and the graph into a **right column**, co-registered as one model-tinted row per phase: the label cell (chip, title, model badge under the title, wrapped detail) on the left, the graph slice on the right. The in-graph chrome is removed entirely (the graph cell is now pure topology), the duplication is gone, and the page is landscape. Mechanics, all chosen to bound risk: the graph keeps its exact internal frame (`W = 760`, spine, fan-out thresholds **unchanged** — placement is byte-identical), the landscape page comes from the renderer translating the graph into the right column by `GRAPH_X`, and rows are sized by two renderer-side post-passes: `reserveLaneHeights` (inflate a band to its label cell's height, slide everything below down — the same rigid shift as `reserveBadgeRow`, keeping every edge flowing down) then `closeLaneGaps` (snap each interior boundary to the midpoint of the small gap the flow left, so rows touch and the page reads as one seamless table — no margins between phases). `--view phases` stays the byte-identical v1 gate; `place-topology`'s output and tests are unchanged.

**This does NOT "read like the hand-designed Six-Patterns catalog" — the earlier claim that v2 did is withdrawn.** Motif/pattern inference was explicitly rejected (see §7): the renderer never recognizes a pattern or reads a `meta.pattern` to pick an art-directed template, because that means guessing. What it guarantees instead is **faithfulness**: literal-only counts (`×N`), verbatim condition slices, a loop *summarized* (body placed once + a repeat badge) rather than inferred, nothing silently dropped, and a byte-identical v1 fallback for any body it can't recover. The look is honest and uniform, not art-directed.

## 9. Process notes / how to continue

- **Continue in a Claude session rooted in THIS repo** (`claude-workflows-viz`). The built-in `/code-review` and git target the *session's* project dir; running them from the planview session mis-fires (this is why the plan was moved here and reviews used a subagent-by-path).
- **Resume:** the v1 build plan is **finished**; it is archived at `docs/exec-plans/completed/260607-0-…/` (its `progress.md` holds the Done log). Active plans live under `docs/exec-plans/active/`.
- **Per-unit review:** from a repo-rooted session you can likely use `/code-review` directly once there's a baseline commit. Otherwise gate each unit with an independent `feature-dev:code-reviewer` subagent pointed at the repo by path. (Greenfield caveat: working-tree diffs miss *untracked* files — stage/commit, or review by path.)
- **Build state:** v2.1 shipped — the graph-first swimlane topology view (plan `260614-0`, six units) retired the v2 banded engine (plan `260612-0`); the pipeline is now `analyze-body` → `place-topology` → `render-topology`. Topology is the CLI default, `--view phases` preserves v1 byte-identically; 0 of 8 examples have cross-card edges (was 4 of 8); `npm test` green; `npm run build` works.
- **planview lesson (worth recording back in planview):** its review pipeline assumes plan + code share one repo; cross-repo plans mis-aim the per-unit gate. We co-located the plan into this repo to compensate — and this whole exercise is real evidence that planview's renderer half and methodology half are cleanly separable.
