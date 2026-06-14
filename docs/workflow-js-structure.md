# The structure of a workflow `.js` file

A stable reference for the **input** — the shape of a dynamic-workflow file and
exactly which parts `claude-workflows-viz` reads. The dialect will evolve; when
it does, diff against this doc and against the two files that *are* the
authority for it: `ts/extract-meta.ts` (the `meta` block) and
`ts/analyze-body.ts` (the body). Term definitions live in
[`glossary.md`](./glossary.md); this doc is the *shape and rules*.

> **Never executed.** Nothing here is run — not the body, not even the `meta`
> expression. The file is parsed once with acorn and read off the AST as static
> data. Every executable construct (calls, identifiers, getters, spreads,
> template expressions) in `meta` is *rejected*, not evaluated. This is the
> security spine of the whole tool.

---

## 1. Overall shape

```js
export const meta = {        // ── the declarative half (§2)
  name: "…",
  description: "…",
  phases: [ { title, detail?, model? }, … ],
};
                             // ── the imperative body (§3)
phase("First phase");
const XS = ["a", "b", "c"];
await parallel(XS.map((x) => () => agent(`do:${x}`)));
phase("Second phase");
while (cond) { await agent("step"); }
const out = await agent("write it up");
```

Two halves, two jobs:

| Half | Read by | Drives |
| --- | --- | --- |
| `meta` block | `extract-meta.ts` | the whole `phases` view; the topology view's **lane titles + model colors + header card** |
| body | `analyze-body.ts` | the topology view's **graph** (nodes, edges, fans, loops) |

The `phases` view (`--view phases`) uses **only** `meta`. The topology view
(default) uses **both**: `meta` for the swimlane chrome, the body for the graph
painted on top of it.

---

## 2. The `meta` block (declarative half)

### Allowed form

`export const meta = { … }` (or a bare `const meta = { … }`). It must be a pure
**data literal**. The reader accepts only:

- object & array literals,
- string / number / boolean / `null` literals,
- a template literal **with no `${…}`**,
- unary `+`/`-` on a numeric literal.

It **rejects** (throws → triggers fallback): any function/method/getter/setter,
any identifier reference or call, spreads, holes in arrays, computed keys,
regexes, and templates with expressions. (`__proto__` is read as an inert plain
key — the object is built with a null prototype so it can't pollute validation.)

### Fields (validated by zod)

| Field | Type | Required | Renders as |
| --- | --- | --- | --- |
| `name` | string | ✓ | header title |
| `description` | string | ✓ | paragraph under the title |
| `whenToUse` | string | — | italic "When to use —" line |
| `phases` | array | — (→ `[]`) | the lanes / phase cards |
| `phases[].title` | string | ✓ | lane label + numbered chip |
| `phases[].detail` | string | — | phase blurb (in `phases` view) |
| `phases[].model` | string | — | color swatch; omit ⇒ no badge |

Unknown keys are ignored. A missing `phases` normalizes to `[]`. `model` is
free-form: `opus`/`sonnet`/`haiku` are matched for color **even inside a full id**
(`claude-opus-4-8`); anything else gets a neutral badge.

---

## 3. The body (imperative half)

`analyze-body.ts` walks the statements and produces the tree IR (`Topology`). It
is a **total function**: every statement is walked in a try/catch, and anything
unreadable degrades to an `OpaqueStep` (a visible blob) and/or an `AnalysisNote`
— **never** a silent drop, never a throw.

### 3.1 What counts as orchestration

Exactly four bare calls: **`agent`**, **`workflow`**, **`parallel`**,
**`pipeline`** (`ORCHESTRATION_CALLEES`). A subtree containing any of them
"orchestrates." Everything else (`log`, budget reads, bookkeeping) draws nothing
— but is scanned so its `phase()` markers aren't lost.

If *no* orchestration is recovered anywhere, `hasOrchestration` is `false` and
the CLI falls back to the `phases` view wholesale.

### 3.2 Phases / banding

- A bare **`phase("Title")`** statement sets the *ambient phase* for everything
  after it. Sequential regions (blocks, loop bodies, `finally`) **leak** the
  ambient phase onward — exactly like the runtime. Conditional / per-lane
  regions (branch arms, `catch`, parallel lanes, pipeline stages) **restore** it
  on exit, so a marker in one arm can't band the others.
- An `agent({ phase: "X" })` option overrides the ambient phase for that one
  node and registers `X` as a lane if new.
- **Lane order** = `meta.phases` first (in declaration order), then any
  body-only titles in first-seen order.
- A `phase()` that isn't a plain statement (in an expression, or inside a region
  the walk abandoned) **does not** set a band — and that loss is recorded as a
  note.

### 3.3 The structural constructs

| Source | Becomes | Notes |
| --- | --- | --- |
| `agent(prompt, opts?)` | `AgentStep` | label = `opts.label` → prompt literal/template-head → `"agent"`. `model`/`agentType`/`phase` read from opts (literals only). |
| `workflow(name)` | `WorkflowStep` | label from string-literal name, else source slice. |
| `parallel([f, g])` | `ParallelStep` `branches` | each element must be an inline thunk; non-thunks → opaque. |
| `parallel(XS.map(cb))` | `ParallelStep` `fanout` | width = `XS`'s multiplicity (§3.4); `(x)=>()=>…` double-arrow unwraps. |
| `pipeline(items, …st)` | `PipelineStep` | `items`' multiplicity = lane count; each stage must be an inline function. |
| `if`/ternary | `BranchStep` | only when ≥1 arm orchestrates; a logs-only `if` is dropped. Condition = verbatim slice. |
| `while`/`do`/`for`/`for-of`/`for-in` | `LoopStep` | only when the **body** orchestrates. Condition = verbatim slice. |

Execution-order honesty: orchestration in a loop/branch **test** runs before the
body, so it's emitted as its own steps *before* the loop/branch (a `do-while`
emits its test steps *after*). If a loop's orchestration lived entirely in the
header, there's no `LoopStep` — just those pre-steps.

### 3.4 Multiplicity (how counts are decided)

`resolveMultiplicity` is the honesty core — a count appears **only** when it's
literally provable:

- array literal of all string literals → `named` (drives label expansion);
- any other array literal → `exact{count}`;
- an identifier → resolved through the module-`const` table **unless shadowed**;
- `Array.from({ length: L })` with literal/known `L` → `exact`;
- anything with a hole/spread, or otherwise unresolvable → `unknown`, carrying a
  truncated **source hint** (rendered `×N`).

**Const resolution & shadowing:** top-level `const`s bound to pure literals are
collected in a pre-pass (so a const declared below its use still resolves).
`let`/`var` are never trusted (reassignable). A fan-out/stage/loop **parameter
shadows** a module const for the body it binds — the one soundness rule here.

### 3.5 Labels & previews (verbatim, never paraphrased)

- A string-literal label/prompt is collapsed-whitespace + ellipsis-truncated.
- A **template** label is kept as its verbatim inner source (`` `match:${i/2}` ``
  stays exactly that) — *unless* the lanes are `named` and every `${…}` is the
  bare fan-out/stage parameter, in which case it's expanded per name
  (`draft:simplest`, `draft:most scalable`, …).
- Condition labels are verbatim truncated source slices of the test.

### 3.6 What is deliberately *not* traced

- **Helper functions** are never traced into — their call sites are opaque to a
  static read (noted if they contain agent calls).
- **Chained calls** on an orchestrating expression unwrap to the flow
  (`(await parallel(…)).filter(Boolean)`); an orchestrating *callback* the chain
  hides is degraded to its own opaque step.
- **No pattern/motif inference.** The analyzer never decides "this is a
  tournament" and picks a template. It draws what the body literally says.

---

## 4. Worked example: `examples/choose-approach.js`

Mapping the body to what gets drawn (render: `examples/choose-approach.png`):

| Body | Tree IR | Render |
| --- | --- | --- |
| `phase("Draft the contenders")` | sets band 0 | green lane "1 Draft the contenders", `sonnet` badge (from `meta`) |
| `parallel(PRIORITIES.map(p => () => agent(`draft:${p}`)))` | `parallel` `fanout`, `named` ×4 | hub → 4 agent circles `draft:simplest…fastest to ship` → coral **barrier** |
| `phase("Judge pairwise")` | sets band 1 | purple lane, `claude-opus-4-8` badge |
| `while (bracket.length > 1) { for (…) { agent("…", {label:"match:…"}) } }` | `loop`(while) ▷ `loop`(for) ▷ `AgentStep` | one `match:${i / 2}` node + **two stacked ↻ badges** (`for i < bracket.length`, `while bracket.length > 1`) |
| `log(…)` only; *no* `phase("Advance the bracket")` in the body | — (band 2 is `meta`-only, no orchestration) | **slim empty strip** "3 Advance the bracket", *control only*, no badge; the spine edge passes straight through it |
| `phase("Write up the winner")` + `agent("Document…")` | sets band 3 + `AgentStep` | blue lane, `haiku` badge, one `Document the winning approach:…` node |

The label stays raw `match:${i / 2}` (not expanded) because `i / 2` is not the
bare fan parameter — honest, per §3.5. The L1→L3 edge crossing the empty lane as
one short vertical is the phase-as-overlay payoff: no card wall to route around.

---

## 5. Maintenance: what a dialect change touches

When Claude Code's workflow dialect changes, the likely edit sites:

- **A new orchestration call** (say `race(…)`): add it to
  `ORCHESTRATION_CALLEES` *and* give it a recognizer in `walkExpression`
  (→ a new `Step` kind in `topology.ts`, a `place*` in `place-topology.ts`, a
  `render*` in `render-topology.ts`). Update §3.1/§3.3 and the glossary bridge.
- **A new `meta` field**: extend `metaSchema` in `model.ts`; decide whether it
  draws (header/lane) and update §2.
- **A new fan-out idiom** (a new way to express width): extend
  `resolveMultiplicity`; update §3.4.
- **A new agent option**: handle it in `agentStep`; update §3.3/glossary.

Regression guardrails that should stay green through any such change:
`--view phases` byte-identical (snapshot), **0 cross-card edges** across
`examples/*.svg` (corpus test), and the v1 fallback path (analysis failure or
`hasOrchestration === false` ⇒ phases page, exit 0).
