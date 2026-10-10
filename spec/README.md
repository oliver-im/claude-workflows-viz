# The workflow language

An unofficial reference for the language of a Claude Code **dynamic workflow** —
the `.js` file the Workflow tool runs. Anthropic publishes no formal spec for it,
so this page is built from the next best thing: the Workflow tool description
that ships inside Claude Code, captured here release by release. It reorders that
text by topic, and for each rule it quotes rather than paraphrases. `npm test`
checks every passage in curly quotes below against the newest capture, so a rule
that changes upstream fails the suite instead of going stale here.

The quotes come from **cc-2.1.296**, captured on 2026-10-10, at grammar
**level 2** (this repo's own version number for the language; see
[the ledger](../docs/GRAMMAR-CHANGELOG.md)). Every hook, option, and `meta` field
below was already in the first capture, cc-2.1.173, except `opts.effort`, which
arrived in cc-2.1.219. Some rules came later — the schema-root rule, for one, in
cc-2.1.267 — and [the captures](#captures) show each one arriving.

- [The tool description as captured](workflow-tool-description.md), made readable
- [Every capture and what changed in it](#captures)

## At a glance

| Part | What it is |
| --- | --- |
| [`meta`](#meta) | A pure literal at the top of the file: name, description, phases |
| [`agent()`](#agent) | Spawns one subagent and returns its answer |
| [`pipeline()`](#pipeline) | Runs each item through a chain of stages, with no barrier between stages |
| [`parallel()`](#parallel) | Runs thunks concurrently and waits for all of them |
| [`workflow()`](#workflow) | Runs another workflow inline |
| [`phase()`](#phase-and-log) | Starts a progress group |
| [`log()`](#phase-and-log) | Prints a progress line |
| [`args`](#args) | The value passed to the tool's `args` input |
| [`budget`](#budget) | The turn's token target |

`claude-workflows-viz` draws `meta`, `agent()`, `pipeline()`, `parallel()`,
`workflow()`, and `phase()`, plus the loops and branches around them. `log()`,
`args`, and `budget` draw nothing of their own; a condition that reads `budget`
is shown verbatim on the loop or branch it guards. What each construct becomes
in a diagram is in [`docs/workflow-js-structure.md`](../docs/workflow-js-structure.md).

## The file

One script, in this order: the `meta` literal, then the body.

- **Self-contained.** “Self-contained workflow script. Must begin with
  `export const meta = { name, description, phases }` (pure literal, no computed
  values) followed by the script body using agent()/parallel()/pipeline()/phase().”
- **Plain JavaScript.** “Scripts are plain JavaScript, NOT TypeScript — type
  annotations (`: string[]`), interfaces, and generics fail to parse.”
- **Top-level await.** “The script body runs in an async context — use await
  directly.”
- **No clock and no randomness.** “Standard JS built-ins (JSON, Math, Array,
  etc.) are available — EXCEPT `Date.now()`/`Math.random()`/argless `new Date()`,
  which throw (they would break resume)”
- **No filesystem.** “No filesystem or Node.js API access.”

The canonical example ends with a top-level `return { confirmed }`; a workflow run
from another one hands that value back (see [`workflow()`](#workflow)).

## `meta`

“The `meta` object must be a PURE LITERAL — no variables, function calls,
spreads, or template interpolation.” “Required fields: `name`, `description`.
Optional: `whenToUse` (shown in the workflow list), `phases`.”

| Field | Required | What the description says |
| --- | --- | --- |
| `name` | yes | “the workflow's `name`” |
| `description` | yes | “a one-line `description` (shown in the permission dialog)” |
| `whenToUse` | no | “(shown in the workflow list)” |
| `phases` | no | “one `{ title, detail? }` per phase() call, titles matched exactly” |
| `phases[].model` | no | “Add `model` to a phase entry when that phase uses a specific model override.” |

“Use the SAME phase titles in meta.phases as in phase() calls — titles are
matched exactly; a phase() call with no matching meta entry just gets its own
progress group.”

Since cc-2.1.267 the binary prints its three `model` sentences — this one, the
`model?: string` slot in `agent()`'s signature, and the `opts.model` paragraph —
only when no subagent model is pinned; the readable capture marks them
`«if !e» … «/if»`. The capture holds the text, not the condition. Read from the
installed cc-2.1.296 binary, `e` is set when `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is
set or `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` names a model other than `inherit`.

## Hooks

The body calls these globals. The signatures as the description writes them
(`${…}` is a value Claude Code fills in at runtime):

```ts quote
agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object, model?: string, effort?: string, isolation?: ${…}, agentType?: string}): Promise<any>
pipeline(items, stage1, stage2, ...): Promise<any[]>
parallel(thunks: Array<() => Promise<any>>): Promise<any[]>
log(message: string): void
phase(title: string): void
args: any
budget: {total: number|null, spent(): number, remaining(): number}
workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any>
```

### `agent()`

“spawn a subagent. Without schema, returns its final text as a string. With
schema (a JSON Schema), the subagent is forced to call a StructuredOutput tool
and agent() returns the validated object — no parsing needed.” “Returns null if
the user skips the agent mid-run or the subagent dies on a terminal API error
after retries (filter with .filter(Boolean)).”

| Option | Takes | Level | What the description says |
| --- | --- | --- | --- |
| `label` | string | 1 | “opts.label overrides the display label.” |
| `phase` | string | 1 | “opts.phase explicitly assigns this agent to a progress group” |
| `schema` | JSON Schema | 1 | See [structured output](#structured-output) |
| `model` | string | 1 | “opts.model overrides the model for this agent call.” |
| `effort` | `'low'` … `'max'` | **2** | “opts.effort overrides the reasoning effort for this agent call” |
| `isolation` | `'worktree'` | 1 | “runs the agent in a fresh git worktree” |
| `agentType` | string | 1 | “opts.agentType uses a custom subagent type” |

The longer guidance on each option:

- **`phase`** — “use this inside pipeline()/parallel() stages to avoid races on the
  global phase() state — same phase string → same group box”
- **`model`** — “Default to omitting it — the agent inherits the main-loop model
  (the resolved session model), which is almost always correct. Only set it when
  you're highly confident a different tier fits the task; when unsure, omit.”
- **`effort`** — “('low' | 'medium' | 'high' | 'xhigh' | 'max') — omit to inherit
  the session effort; use 'low' for cheap mechanical stages and higher tiers only
  for the hardest verify/judge stages.”
- **`isolation`** — “EXPENSIVE (\~200-500ms setup + disk per agent), use ONLY when
  agents mutate files in parallel and would otherwise conflict; the worktree is
  auto-removed if unchanged.”
- **`agentType`** — “instead of the default workflow subagent — resolved from the
  same registry as the Agent tool; composes with schema (the custom agent's system
  prompt gets a StructuredOutput instruction appended).”

`claude-workflows-viz` reads all seven options; it takes `model`, `effort`, and
`agentType` only as string literals, verbatim.

### `pipeline()`

“run each item through all stages independently, NO barrier between stages. Item
A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for
multi-stage work.”

- “Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage.”
- “Every stage callback receives (prevResult, originalItem, index)”
- “A stage that throws drops that item to `null` and skips its remaining stages.”

### `parallel()`

“run tasks concurrently. This is a BARRIER: awaits all thunks before returning.”

- “A thunk that throws (or whose agent errors) resolves to `null` in the result
  array — the call itself never rejects, so `.filter(Boolean)` before using the
  results.”
- “Use ONLY when you genuinely need all results together.”

### Choosing between them

“DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when
you genuinely need ALL prior-stage results together.”

“A barrier is correct ONLY when stage N needs cross-item context from all of
stage N-1:”

- “Dedup/merge across the full result set before expensive downstream work”
- “Early-exit if the total count is zero ("0 bugs found → skip verification
  entirely")”
- “Stage N's prompt references "the other findings" for comparison”

### `workflow()`

“run another workflow inline as a sub-step and return whatever it returns.”

- “Pass a name to invoke a saved workflow (same registry as {name: "..."}), or
  {scriptPath} to run a script file you Wrote earlier.”
- “The child shares this run's concurrency cap, agent counter, abort signal, and
  token budget”
- “The args param becomes the child's `args` global.”
- “Nesting is one level only: workflow() inside a child throws.”
- “Throws on unknown name / unreadable scriptPath / child syntax error; catch to
  handle gracefully.”

### `phase()` and `log()`

- **`phase(title)`** — “start a new phase; subsequent agent() calls are grouped
  under this title in the progress display”
- **`log(message)`** — “emit a progress message to the user (shown as a narrator
  line above the progress tree)”

### `args`

“the value passed as Workflow's `args` input, verbatim (undefined if not
provided).” “Pass arrays/objects as actual JSON values in the tool call, NOT as a
JSON-encoded string”

### `budget`

“the turn's token target from the user's "+500k"-style directive.”

- “`budget.total` is null if no target was set.”
- “`budget.spent()` returns output tokens spent this turn across the main loop and
  all workflows — the pool is shared, not per-workflow.”
- “`budget.remaining()` returns `max(0, total - spent())`, or `Infinity` if no
  target.”
- “The target is a HARD ceiling, not advisory: once `spent()` reaches `total`,
  further `agent()` calls throw.”

## Structured output

- “Subagents are told their final text IS the return value (not a human-facing
  message), so they return raw data.”
- “For structured output, use the schema option — validation happens at the
  tool-call layer so the model retries on mismatch.”
- “Schemas need {type: 'object', properties: {...}} at root and required ⊆
  properties; unsatisfiable ones throw at agent().”

## Limits

| Limit | Value |
| --- | --- |
| Concurrent `agent()` calls per workflow | min(16, available CPUs − 2) |
| `agent()` calls over a workflow's lifetime | 1000 |
| Items in one `parallel()` or `pipeline()` call | A runtime value; the description said 4096 through cc-2.1.220 |

- “Concurrent agent() calls are capped at min(16, available CPUs - 2) per workflow
  — excess calls queue and run as slots free up.”
- “Total agent count across a workflow's lifetime is capped at 1000 — a
  runaway-loop backstop set far above any real workflow.”
- “A single parallel()/pipeline() call accepts at most `${…}` items; passing more
  is an explicit error, not a silent truncation.”

## Subagents

- “Workflow agents can reach all session-connected MCP tools via ToolSearch —
  schemas load on demand per agent.” “Caveat: interactively-authenticated MCP
  servers (e.g. claude.ai) may be absent in headless/cron runs.”
- “Subagents get the same CLAUDE.md files injected at start that you did (except
  built-in agent types that omit them, such as Explore and Plan)”

## Running a workflow

The Workflow tool's input, from the shipped
[`workflow-input-schema.d.ts`](upstream/2026-10-10-cc-2.1.296/workflow-input-schema.d.ts):

| Input | What the schema says |
| --- | --- |
| `script` | “Self-contained workflow script.” |
| `name` | “Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script.” |
| `scriptPath` | “Path to a workflow script file on disk.” “Takes precedence over `script` and `name`.” |
| `args` | “Optional input value exposed to the script as the global `args`, verbatim.” |
| `resumeFromRunId` | “Run ID of a prior Workflow invocation to resume from.” |
| `description` | “Ignored — set the workflow description in the script's `meta` block.” |
| `title` | “Ignored — set the workflow title in the script's `meta` block.” |

- “Workflows run in the background — this tool returns immediately with a task
  ID, and a &lt;task-notification> arrives when the workflow completes.”
- “Every Workflow invocation persists its script under the session directory and
  returns the path in the tool result.”

## Resume

- “To resume after a pause, kill, or script edit, relaunch with
  Workflow({scriptPath, resumeFromRunId}) — the longest unchanged prefix of
  agent() calls returns cached results instantly; the first edited/new call and
  everything after it runs live.”
- “Same script + same args → 100% cache hit.”
- “Same-session only. Stop the prior run first (TaskStop) before resuming.”
- “Before diagnosing why a completed workflow returned an empty or unexpected
  result, Read &lt;transcriptDir>/journal.jsonl — it records each agent's actual
  return value; do not assume cached results are non-empty.”

## Guidance, not grammar

Much of the description tells Claude *when* and *how* to use workflows rather
than what a file may contain. That guidance shapes behavior, not the language,
so this page only points to it in
[the readable capture](workflow-tool-description.md):

- the opt-in rule — when Claude may call the tool at all — and **Ultracode**, a
  standing opt-in;
- the patterns: the canonical review pipeline, loop-until-count,
  loop-until-budget, exhaustive review, adversarial verify, perspective-diverse
  verify, judge panel, loop-until-dry, multi-modal sweep, completeness critic, and
  no silent caps;
- how far to scale a workflow to the request.

## Captures

Each capture is a dated snapshot of the two upstream artifacts —
`workflow-tool-description.txt` and `workflow-input-schema.d.ts` — taken from an
installed Claude Code with `npm run capture-grammar`. The raw files are the
authority, and their hashes are what `npm run check-grammar` compares. Next to
each one, `npm run spec` writes a readable page and — from the second capture on —
a change page that sets the minifier's runtime-value renames aside. Newest first:

<!-- captures:start -->
| Capture | Captured | Level | Change from the capture before |
| --- | --- | --- | --- |
| [cc-2.1.296](upstream/2026-10-10-cc-2.1.296/workflow-tool-description.md) | 2026-10-10 | 2 | [Runtime-value renames only](upstream/2026-10-10-cc-2.1.296/CHANGES.md) |
| [cc-2.1.280](upstream/2026-09-22-cc-2.1.280/workflow-tool-description.md) | 2026-09-22 | 2 | [Runtime-value renames only](upstream/2026-09-22-cc-2.1.280/CHANGES.md) |
| [cc-2.1.267](upstream/2026-09-10-cc-2.1.267/workflow-tool-description.md) | 2026-09-10 | 2 | [12 passages, +336 / −173 words](upstream/2026-09-10-cc-2.1.267/CHANGES.md) |
| [cc-2.1.245](upstream/2026-08-25-cc-2.1.245/workflow-tool-description.md) | 2026-08-25 | 2 | [2 passages, +3 / −3 words](upstream/2026-08-25-cc-2.1.245/CHANGES.md) |
| [cc-2.1.220](upstream/2026-07-25-cc-2.1.220/workflow-tool-description.md) | 2026-07-25 | 2 | [Runtime-value renames only](upstream/2026-07-25-cc-2.1.220/CHANGES.md) |
| [cc-2.1.219](upstream/2026-07-24-cc-2.1.219/workflow-tool-description.md) | 2026-07-24 | **2** · minted | [5 passages, +75 / −2 words](upstream/2026-07-24-cc-2.1.219/CHANGES.md) |
| [cc-2.1.173](upstream/2026-06-23-cc-2.1.173/workflow-tool-description.md) | 2026-06-23 | **1** · first capture | — |
<!-- captures:end -->

How a capture becomes a grammar level, and how to reconcile when upstream
drifts, is in [`docs/GRAMMAR-CHANGELOG.md`](../docs/GRAMMAR-CHANGELOG.md).
