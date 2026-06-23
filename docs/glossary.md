# Glossary

Two vocabularies meet in this project, and we keep them apart on purpose:

- **A — the workflow JS dialect:** the *input* language an author writes. We do
  not define it (Claude Code's dynamic-workflows runtime does); we only read a
  static subset of it.
- **B — claude-workflows-viz internals:** the names *we* use for the pipeline
  that turns that file into a diagram.

An author never needs our terms, and our code never invents theirs. The bridge
table in §C maps one to the other.

> **Source of truth.** The dialect (A) is defined by what `ts/extract-meta.ts`
> and `ts/analyze-body.ts` actually recognize — a static subset of the runtime's
> grammar, which Claude Code owns and does not formally version. What that subset
> is reconciled *against* — the pinned upstream baseline — lives in
> [`spec/upstream/`](../spec/upstream/), named with a dialect epoch in
> [`DIALECT-CHANGELOG.md`](./DIALECT-CHANGELOG.md) (currently **D1**, `cc-2.1.173`).
> The internals (B) are defined by `ts/topology.ts` (the tree IR) and
> `ts/topo-geometry.ts` (the geometry IR). When those files change, update this
> one. For the *shape* of a workflow file rather than per-term definitions, see
> [`workflow-js-structure.md`](./workflow-js-structure.md).

---

## A. The workflow JS dialect (input)

### The file
- **dynamic workflow** — a `.js` file that begins with `export const meta = {…}`
  and then orchestrates subagents in an imperative body. We render its *static*
  structure; **we never execute it.**
- **`meta` block** — the declarative head: a single pure-data object literal.
  The only thing the `phases` view draws, and the source of the swimlane's lane
  titles + model colors in the topology view.
- **body** — everything after `meta`: the imperative orchestration. The topology
  view is a static reading of this half.
- **phase marker** — a bare `phase("Title")` statement. Sets the *ambient
  phase* for every step after it (until the next marker). This is how the body
  declares which lane its steps belong to.

### `meta` fields
- **`name`** *(required)* — workflow title; the big header.
- **`description`** *(required)* — one-paragraph summary under the title.
- **`whenToUse`** *(optional)* — the italic "When to use —" line.
- **`phases`** *(optional, defaults to `[]`)* — ordered array of phase objects.
- **`phases[].title`** *(required)* — the phase/lane label.
- **`phases[].detail`** *(optional)* — phase blurb (drawn in the `phases` view).
- **`phases[].model`** *(optional)* — model name driving the phase's color
  swatch; omit it for a pure-control phase (renders with no badge).

### Body orchestration (the four calls we recognize)
- **`agent(prompt, opts?)`** — spawn one subagent. The atom of the graph.
- **`workflow(name, …)`** — invoke a named sub-workflow.
- **`parallel(arg)`** — run things concurrently with a join barrier. Two shapes:
  a **thunk array** (k distinct *branches*) or a `collection.map(…)` (a
  *fan-out* of one body repeated per item).
- **`pipeline(items, …stages)`** — run each item through every stage, no barrier
  between stages.
- **`log(…)`, `args`, budget reads, etc.** — recognized as *not* orchestration;
  they draw nothing.

### `agent()` options we read
- **`label`** — the node's caption (string or template literal). Wins over the
  prompt for the label.
- **`model`** — colors the agent circle (string literal only).
- **`agentType`** — recorded (string literal only).
- **`phase`** — overrides the ambient phase for this one agent (string literal
  only); also registers a new lane if unseen.
- **`schema`, etc.** — read but carry no visual meaning.

### Author conventions we lean on
- **module `const`** — a top-level `const` bound to a pure literal. We resolve
  these (order-independent) to count fan-outs. `let`/`var` are never trusted.
- **`.map` fan-out** — `parallel(XS.map(x => () => agent(…)))`; the fan width is
  `XS`'s multiplicity.
- **thunk / double-arrow** — `(item) => () => agent(…)`; the inner zero-arg arrow
  is the body. A single un-thunked arrow is tolerated.
- **`Array.from({ length: L })`** — resolves to an exact width when `L` is a
  literal or known const.
- **label template** — `` `draft:${p}` ``; when the lanes are *named* and every
  `${…}` is the bare fan-out/stage parameter, we expand it per name
  (`draft:simplest`, …). Anything fancier stays verbatim.

---

## B. claude-workflows-viz internals

### Pipeline stages (modules)
- **`extract-meta`** — source → validated `Meta` (reads the `meta` literal off
  the AST; never runs it).
- **`analyze-body`** — source AST → `Topology` (the tree IR). Total function.
- **`place-topology`** — `Topology` → `Layout` (positioned geometry). Total.
- **`render-topology`** — `Layout` → SVG string (the swimlane view).
- **`render-svg`** — `Meta` → SVG string (the v1 `phases` view; byte-frozen).
- **`svg-primitives`** — shared shapes, text measuring, truncation, page width.
- **`render-png`** — SVG → PNG via `@resvg/resvg-js` (no browser).
- **`emit-json`** — `Meta` + `Topology` → the `--format json` analysis dump (schema
  `claude-workflows-viz/analysis@1`): a faithful, deterministic facts-only emit
  (no paraphrase) that tooling — notably the `workflow-readability` skill — reads
  to improve the source's authored strings.

### Tree IR — `topology.ts` (what the body *says*)
- **`Topology`** — `{ steps, bands, notes, hasOrchestration }`.
- **`Step`** — a node in the source-faithful tree. Union of: `AgentStep`,
  `WorkflowStep`, `OpaqueStep`, `ParallelStep` (`fanout` | `branches`),
  `PipelineStep`, `LoopStep`, `BranchStep`.
- **`OpaqueStep`** — the honest blob: orchestration we couldn't read
  structurally, labeled with a verbatim source slice.
- **`Multiplicity`** — how many run: `one` | `exact{count}` | `named{names}` |
  `unknown{hint?}`. The honesty core — counts appear only when literal.
- **`BandRef`** — `{ title, inMeta }`: a lane, tagged by whether it came from
  `meta.phases` or only from a body `phase()`.
- **`AnalysisNote`** — a recorded degradation ("saw it, couldn't draw it fully").
- **`SourceSpan`** — `{ start, end }` byte offsets into the source.
- **`hasOrchestration`** — false ⇒ nothing real was recovered ⇒ fall back to v1.

### Geometry IR — `topo-geometry.ts` (where it goes)
- **`Layout`** — `{ width, height, lanes, nodes, edges, loops, notes }`. One flat
  coordinate space; `render-topology`'s sole input.
- **`GNode`** — a placed node. `kind` ∈ **agent** (circle) · **barrier** (coral
  bar) · **decision** (coral diamond) · **task** (box) · **hub** (small
  connector dot). Carries `x, y, r, label, model?, mult?, phase, labelBelow?`.
- **`GEdge`** — a placed connector. `kind` ∈ **seq** (ordinary flow, incl.
  cross-phase) · **fan** (hub↔member, member→barrier) · **stage** (pipeline
  stage→stage) · **merge** (arm rejoining a barrier/sink).
- **`GLoop`** — a `{ onNode, label }` "↻ repeat …" badge. A loop *summarized in
  place*, **never** a back-edge.
- **`GLane`** — a phase as a painted stripe: `{ phaseIndex, title, model?, yTop,
  yBot, empty }`.
- **`labelBelow`** — placement-authoritative flag: render this node's label
  centered below it (row/grid member) instead of to its right (spine node).

### Render & layout vocabulary
- **spine** — the vertical centerline (`SPINE_X`) the main flow runs down.
- **swimlane / stripe** — the faint rectangle painted behind a phase's nodes.
- **chip** — the numbered circle (`1`, `2`, …) at a lane's top-left.
- **model badge / tint** — the colored pill (and faint lane wash) keyed off a
  model name; opus/sonnet/haiku are matched even inside a full id like
  `claude-opus-4-8`; anything else is neutral.
- **control-only strip** — a slim empty lane (a phase with no orchestration),
  labeled *control only*, with no model badge.
- **loop badge** — the rendered `GLoop` (`↻ repeat while …`). Nested loops stack.
- **phase-as-overlay** — the core stance: a phase is *paint behind* the graph,
  not a *container* around it. With no walls, a cross-phase edge is just a short
  ordinary edge.
- **cross-card edge** — an edge routed out of one phase box and into another. The
  retired v2 banded engine had these (4 of 8 examples); the swimlane view has
  **0 by construction**, and the corpus test enforces it.
- **downward-edge invariant** — every `GEdge` flows down (`from.y ≤ to.y`); what
  makes "no back-edges" hold.
- **total function** — `analyze-body` and `place-topology` never throw on valid
  JS; the unreadable degrades to opaque/notes, never a crash.
- **v1 fallback** — `hasOrchestration === false` or any analysis error ⇒ render
  the plain `phases` page instead (CLI warns on stderr, exits 0).
- **resvg-safe** — the SVG 1.1 subset resvg rasterizes: plain shapes/paths,
  arrowheads as explicit filled polygons (no `<marker>`).
- **determinism** — same input ⇒ byte-identical SVG (no clock/RNG; arrays in
  emission order).

---

## C. The bridge (JS → tree IR → geometry → pixels)

| You write (A) | Tree IR `Step` | Placed as (B) |
| --- | --- | --- |
| `agent(p, opts)` | `AgentStep` | **agent circle** (+ model swatch, + `×N` badge if fanned) |
| `workflow(name)` | `WorkflowStep` | **task box** |
| *(unreadable orchestration)* | `OpaqueStep` | **task box**, label = source slice |
| `parallel([f, g, …])` | `ParallelStep` `branches` | **hub → arms → barrier bar** |
| `parallel(XS.map(…))` | `ParallelStep` `fanout` | **hub → agent members ×\|XS\| → barrier bar** |
| `pipeline(items, …stages)` | `PipelineStep` | **hub → stage-cell grid** (stage→stage edges) |
| `if (…) {…} else {…}` / ternary | `BranchStep` | **decision diamond → arms** |
| `while`/`for`/`for-of`/… | `LoopStep` | body placed **once** + **↻ loop badge** |
| `phase("Title")` | *(sets band)* | **swimlane stripe** + numbered chip + title |
| `meta.name/description/whenToUse` | *(not a step)* | the **header card** |
| `meta.phases[].title/model` | *(not a step)* | a lane's **title** + **model tint/badge** |
