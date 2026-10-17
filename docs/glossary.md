# Glossary

Two vocabularies meet in this project, and we keep them apart on purpose:

- **A — the workflow JS grammar:** the *input* language an author writes. We do
  not define it (Claude Code's dynamic-workflows runtime does); we only read a
  static subset of it.
- **B — claude-workflows-viz internals:** the names *we* use for the pipeline
  that turns that file into a diagram.

An author never needs our terms, and our code never invents theirs. The bridge
table in §C maps one to the other.

> **Source of truth.** The grammar (A) is defined by what `ts/extract-meta.ts`
> and `ts/analyze-body.ts` actually recognize — a static subset of the runtime's
> grammar, which Claude Code owns and does not formally version. What that subset
> is reconciled *against* — the pinned upstream baseline — lives in
> [`spec/upstream/`](../spec/upstream/), named with a grammar level in
> [`GRAMMAR-CHANGELOG.md`](./GRAMMAR-CHANGELOG.md) (currently **level 2**, `cc-2.1.296`).
> The internals (B) are defined by `ts/topology.ts` (the tree IR) and
> `ts/topo-geometry.ts` (the geometry IR). When those files change, update this
> one. For the *shape* of a workflow file rather than per-term definitions, see
> [`workflow-js-structure.md`](./workflow-js-structure.md).

---

## A. The workflow JS grammar (input)

The terms below are the ones this tool reads. The whole language — `log()`,
`args`, `budget`, limits, resume — is quoted from the upstream capture in
[`spec/README.md`](../spec/README.md).

### The file
- **dynamic workflow** — a `.js` file that begins with `export const meta = {…}`
  and then orchestrates subagents in an imperative body. We render its *static*
  structure; **we never execute it.**
- **`meta` block** — the declarative head: a single pure-data object literal.
  The only thing the `phases` view draws, and the source of the swimlane's lane
  titles + model colors in the workflow view.
- **body** — everything after `meta`: the imperative orchestration. The topology
  and workflow views are static readings of this half.
- **phase marker** — a bare `phase("Title")` statement. Sets the *ambient
  phase* for every step after it (until the next marker). This is how the body
  declares which lane its steps belong to. A **phase** is the author's narrative
  band and spans the whole graph; it is orthogonal to a **stage** (a step inside
  one `pipeline`) — a single pipeline's two stages can even sit in two different
  phases via each stage's `phase:` option.

### `meta` fields
- **`name`** *(required)* — workflow title; the big header.
- **`description`** *(required)* — one-paragraph summary under the title.
- **`whenToUse`** *(optional)* — the italic "When to use —" line.
- **`phases`** *(optional, defaults to `[]`)* — ordered array of phase objects.
- **`phases[].title`** *(required)* — the phase/lane label.
- **`phases[].detail`** *(optional)* — phase blurb (drawn in the `phases` view).
- **`phases[].model`** *(optional)* — the model the phase declares, shown on its
  row as a swatch dot and the id. Marked **declared only** when no `agent()` call in
  the phase sets it (and none names a custom `agentType`). Omit it for a phase with
  no agent of its own (its row then shows no model line).

### Body orchestration (the four calls we recognize)
- **`agent(prompt, opts?)`** — spawn one subagent. The atom of the graph.
- **`workflow(name, …)`** — invoke a named sub-workflow.
- **`parallel(arg)`** — run things concurrently with a join barrier. Two shapes:
  a **thunk array** (k distinct *branches*) or a `collection.map(…)` (a
  *fan-out* of one body repeated per item).
- **`pipeline(items, …stages)`** — run each item through every stage, no barrier
  between stages.
  - **stage** — one positional step of a `pipeline` (`stage1`, `stage2`, …). A
    structural fact of that one call, *not* a narrative grouping — contrast
    **phase**, which is an author-declared band the graph is painted *behind*.
    A stage is drawn as a horizontal row of nodes; the two axes are orthogonal,
    though in a simple pipeline each stage can happen to line up 1:1 with a phase.
- **`log(…)`, `args`, budget reads, etc.** — recognized as *not* orchestration;
  they draw nothing.

### `agent()` options we read
- **`label`** — the node's caption (string or template literal). Wins over the
  prompt for the label.
- **`model`** — fills the agent card with the model's color and names it on the
  card (string literal only). Omitted ⇒ the card says *session model*: the agent
  inherits the main loop's model. Set in a way the analyzer can't read (a
  variable, a spread) ⇒ the card says *model unread* and claims nothing.
- **`effort`** — named on the card's model line, with a five-step meter for the
  documented tiers (string literal only). Grammar level 2; taken verbatim, so an
  undocumented tier still shows, just without a meter.
- **`agentType`** — named on the card (`codex agent`) when no `model` is set, since
  a custom agent type may pin its own model (string literal only).
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
- **`feature-detect`** — AST → the file's required-minimum grammar level
  (caniuse-style) + any awaited-but-unrecognized callees. Read-only; feeds
  `Topology.requiredLevel` and the CLI's one-line grammar warning.
- **`place-topology`** — `Topology` → `Layout` (positioned geometry). Total.
- **`render-topology`** — `Layout` → SVG string (the workflow swimlane view or
  the graph-only topology view).
- **`render-svg`** — `Meta` → SVG string (the v1 `phases` view; byte-frozen).
- **`svg-primitives`** — shared shapes, text measuring, truncation, page width.
- **`render-png`** — SVG → PNG via `@resvg/resvg-js`, then optimized with
  `@napi-rs/image` (palette-quantize + lossless oxipng repack) — visually
  lossless, deterministic/byte-stable, still no browser or network.
- **`emit-json`** — `Meta` + `Topology` → the `--format json` analysis dump (schema
  `claude-workflows-viz/analysis@1`): a faithful, deterministic facts-only emit
  (no paraphrase) that tooling — notably the readable-diagrams authoring pass
  (`docs/readable-diagrams.md`) — reads to improve the source's authored strings.

### Tree IR — `topology.ts` (what the body *says*)
- **`Topology`** — `{ steps, bands, notes, hasOrchestration, requiredLevel,
  recognizerLevel }`.
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
- **`requiredLevel` / `recognizerLevel`** — the file's required-minimum grammar
  level (`feature-detect`) vs the level the recognizer supports (`RECOGNIZER_LEVEL`);
  a caniuse-style pair carried for the JSON emit and the CLI grammar warning.

### Geometry IR — `topo-geometry.ts` (where it goes)
- **`Layout`** — `{ width, height, lanes, nodes, edges, frames, controlArcs, notes }`.
  One flat coordinate space; `render-topology`'s sole input.
- **`GNode`** — a placed node. `kind` ∈ **agent** (card) · **barrier** (join bar)
  · **decision** (diamond) · **task** (sub-workflow card or opaque box) ·
  **control** (final node ◉, or a pill naming a jump) · **hub** (a bare junction —
  a **fork** a rail leaves from, or a stub for an empty arm; not drawn, except a
  fork that starts the workflow). Carries `x, y, r, w, h, label, model?, effort?,
  agentType?, unread?, mult?, card?, phase`.
- **`CardSpec`** (`node-card.ts`) — an agent card laid out once and shared by
  placement and rendering: width, height, label lines, model line, meter, stack,
  caption.
- **`GEdge`** — a placed connector, always **orthogonal** (each segment vertical
  or horizontal). `kind` ∈ **seq** (ordinary flow, incl. cross-phase) · **fan**
  (fork → member) · **stage** (pipeline stage→stage) · **merge** (member or arm
  dropping onto its join).
- **`GFrame`** — a loop, drawn as a frame around its body with the verbatim
  condition on its header. Nested loops nest frames. **Never** a back-edge.
- **`ControlArc`** — a `continue` (back to the top of the loop body) or `break`
  (out to the loop's successor), drawn as an accent arc from a guard diamond. A
  `break` that escapes a nested loop ending its enclosing body returns to the top
  of THAT body (`into`) — the next outer iteration — never past both loops; one
  with nowhere left to go exits to a final node.
- **`GLane`** — a phase as a row of the table: `{ phaseIndex, title, model?, yTop,
  yBot, empty }`.

### Render & layout vocabulary
- **shape (sub-shape)** — the general form an orchestration construct takes on the
  graph: **fan-out**, **branches**, **join**, **pipeline stages**, **decision
  diamond**, **loop frame**. `place-topology` owns a per-shape template vocabulary; an
  unrecognized construct degrades to a **task** blob. The umbrella above shapes is
  **orchestration**; a **node** is the atom *inside* a shape.
- **spine** — the vertical centerline (`SPINE_X`) the main flow runs down.
- **swimlane / row** — one row of the table: a phase's label cell beside its slice
  of the graph.
- **chip** — the numbered circle (`1`, `2`, …) at a row's top-left.
- **agent card** — the node for one `agent()` call: the authored label in mono
  (verbatim source), then the **model line** (`sonnet · medium`). The workflow view
  leaves prompt-sliced labels off; the topology view shows them, muted.
- **model color** — the card fill keyed off a model name; opus/sonnet/haiku/fable
  are matched even inside a full id like `claude-opus-5`. Another explicit model,
  a custom agent type, or a model the analyzer couldn't read (*model unread*) is
  neutral slate; no model at all is the white **session model** card. The phase row repeats the declared model as a swatch dot.
- **effort meter** — five steps (`low` … `max`) beside the effort word on a card.
- **stack** — the `×N` card: cards behind a card, a count badge on the corner, and
  a caption `N from <expr>` naming the source of the count.
- **join** — the neutral bar a `parallel()` or `await pipeline()` waits at; the
  flow leaves from it. A pipeline has no join *between* its stages.
- **loop frame** — the rendered `GFrame`.
- **control-only strip** — a slim empty row (a phase with no orchestration),
  labeled *control only*, with no model line.
- **declared only** — the note on a phase row whose declared model no `agent()`
  call in the phase sets.
- **legend** — the strip under the table naming exactly the glyphs the diagram uses.
- **counts strip** — the header chips (`4 phases`, `4 agent() calls`, `fan-out ×N`),
  counted from literals: call sites, not spawned agents.
- **two voices** — sans for prose the author wrote in `meta`, mono for anything
  quoted from the code (labels, conditions, count sources).
- **theme** — the token set every color comes from (`theme.ts`): `light`
  (default) or `dark`, via `--theme`. The phases view keeps its fixed palette.
- **phase-as-row** (once *phase-as-overlay*) — the core stance: a phase is a row
  the graph runs through, not a *container* around it. With no walls, a
  cross-phase edge is just a short ordinary edge.
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
| `agent(p, opts)` | `AgentStep` | **agent card** (model color + model line, **effort meter** if `opts.effort`, a **stack** if fanned) |
| `workflow(name)` | `WorkflowStep` | **sub-workflow card** (doubled left rule) |
| *(unreadable orchestration)* | `OpaqueStep` | **dashed box**, label = source slice |
| `parallel([f, g, …])` | `ParallelStep` `branches` | **fork rail → arms → join** |
| `parallel(XS.map(…))` | `ParallelStep` `fanout` | **fork rail → member cards ×\|XS\| → join** (or one stack + join) |
| `pipeline(items, …stages)` | `PipelineStep` | **fork rail → stage-cell grid → join** (no join between stages) |
| `if (…) {…} else {…}` / ternary | `BranchStep` | **decision diamond → arms** (`continue`/`break` guards → arcs) |
| `while`/`for`/`for-of`/… | `LoopStep` | body placed **once**, inside a **loop frame** |
| `return` / end of body | `ControlStep` / *(trailing phase)* | **final node** ◉ |
| `phase("Title")` | *(sets band)* | a **row**: numbered chip + title |
| `meta.name/description/whenToUse` | *(not a step)* | the **header card** (+ counts strip) |
| `meta.phases[].title/model` | *(not a step)* | a row's **title** + declared **model line** |

---

## D. Diagram anatomy (the annotated hero)

`scripts/annotate-anatomy.mjs` overlays keyed coral pins on the committed
`examples/level-2/review-pr` render to label the parts of a diagram. Every pin
resolves to a term defined above — the legend *is* this glossary, not free prose.
The hero shows all pins under one **Anatomy** legend; the terms still fall in two
families (mirroring §A vs the graph it produces), listed separately here:

**Meta anatomy — the header + phase table (pins A–G, all from §A `meta` fields)**

| Pin | Term |
| --- | --- |
| A | `name` |
| B | `description` |
| C | `whenToUse` |
| D | `phases[].title` |
| E | `phases[].detail` |
| F | `phases[].model` |
| G | `phases` (the array) |

**Topology anatomy — the body graph (pins H–L)**

| Pin | Term | Points at | Defined in |
| --- | --- | --- | --- |
| H | node | one `agent()` card — here the mapping agent's | §A `agent`, §B **agent card** |
| I | shape | the fork rail and its lanes — here a **fan-out** | §A "two shapes", §B **shape** |
| J | label | a card's label line — here `verify:${f.title}`, verbatim | §A `agent()` options → `label` |
| K | multiplicity | a stack's `×N` badge — count unknown until runtime | §B `Multiplicity` `unknown` |
| L | effort | the effort word and meter on a card — here `low` | §A `agent()` options → `effort` |

The five pins are the graph's whole vocabulary at one altitude: **node** (the
atom), **shape** (how nodes compose — fan-out here, else branches / join / loop /
…), **label** (the card's verbatim caption), **multiplicity** (the `×N` badge here
— count unknown until runtime), **effort** (the reasoning tier). The **mapping
agent sets neither `model` nor `effort`** — omitted means "inherit the session's",
so its card reads *session model* with no meter, and its row declares no model;
that is why F sits on phase 2. The diagram's own legend explains the remaining
glyphs (the join, the stack), so they carry no pin.
**stage** (§A) is
deliberately *not* pinned — in `review-pr` each pipeline stage lines up 1:1 with a
**phase**, so the phase bands already name it; a stage pin earns its place only
where stages and phases diverge.

Deliberately *absent* here — `review-pr` has none, and pointing a pin at empty
canvas would break the degrade-honestly contract: **decision diamond**
(`BranchStep`), **loop frame** (`GFrame`), **control arcs**, **sub-workflow card**
and **opaque box** (`workflow`/`OpaqueStep`). Annotate those on an example that
actually exercises them.
