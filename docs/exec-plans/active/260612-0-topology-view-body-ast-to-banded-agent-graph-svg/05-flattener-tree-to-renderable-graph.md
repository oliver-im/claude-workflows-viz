# Unit 05 — Flattener — tree to renderable graph
**Blocked by:** 04-analyzer-structural-recognizers-parallel-pipeline-loops-b**Agents involved:** main only**Topology:** none
## Summary

Land `ts/flatten-topology.ts`: `flattenTopology(topology: Topology, meta: Meta): TopologyIR` — the policy layer that turns the analyzer's nested tree into the flat node/edge/loop graph the layout consumes. All graph-shape policy lives here, in one reviewable place.

### Policy (locked)

- **Band mapping:** `phase` strings → indices via `topology.bands` filtered to meta order first, body-only bands appended after (a body-only band still renders — the renderer treats band list = meta.phases + appended extras; flattener emits the merged band-title list alongside or the renderer derives it — concretely: flattener returns `{ir, bandTitles: string[]}` where the first `meta.phases.length` entries are meta's, extras appended; `TopoNode.band` indexes into that). `phase: null` steps → band of the nearest following step with a band, else band 0 (note-free defensive default; corpus never hits it).
- **Sequence:** consecutive steps in the SAME band → sequential edge. Implicit cross-band succession → **NO edge** (vertical stacking already says it — v1 semantics). Explicit structures crossing bands (pipeline stage chains, branch arms, loop arcs) DO get edges/loops.
- **`AgentStep`** → one `TopoNode{kind:"agent"}`; multiplicity mapping: `one` → `mult` absent; `exact`/`named`/`unknown` → `FlatMultiplicity` (named carries `expandedLabels` as the names when present, else the raw names). `WorkflowStep`/`OpaqueStep` → `TopoNode{kind:"task"}` (label as-is; opaque label reads as the honest blob).
- **`ParallelStep` fanout** → one agent node carrying `mult` + one `barrier` node, edges node→barrier; empty body (unresolvable arg) → placeholder agent node labeled "agents", `mult` unknown → barrier. **branches** → k chains (each branch flattened in its own band placement), every chain's terminal node → one shared `barrier`. The barrier sits in the band of the last contributing node.
- **`PipelineStep`** → per-stage chains: each stage's steps flattened with the stage's lane multiplicity applied to its agent nodes (stage 1 gets `items` multiplicity); consecutive stages chained by an edge from stage k's terminal to stage k+1's head — NO barrier between stages (pipeline semantics). Stages landing in different bands produce forward cross-band edges.
- **`BranchStep`** → one `decision` node (label = conditionLabel); non-empty then-arm: edge decision→arm-head labeled **"yes"**, elseSteps likewise labeled **"no"**; arm chains flatten recursively; if a next step follows the branch in its sequence, each arm's terminal → next (merge); an EMPTY arm with a following step → direct decision→next edge (the bypass); branch as last step → arms simply terminate.
- **`LoopStep`** → flatten body chain, then synthesize one `decision` node after it (label = conditionLabel, banded at the loop's last body band) + `TopoLoop{from: decision, to: first body node, label: "yes"}` + (if a next step exists) edge decision→next labeled "no". This reproduces the Loop-Until-Done panel exactly. Nested loops nest naturally (inner decision is part of the outer body chain).
- `untaken` never set (v2). Node ids `n0, n1, …` in emission order (determinism).

### Tests (`ts/__tests__/flatten-topology.test.ts`)

Tree-literal micros: same-band sequence edges; cross-band non-edges; fanout→barrier emission; branches→shared barrier; pipeline chaining without barriers + lane multiplicities; branch yes/no/bypass/merge; loop→synthesized decision + TopoLoop + no-exit-edge-when-last; band mapping with body-only bands; multiplicity mapping incl. expandedLabels-as-names; determinism. Integration: flatten all 8 example trees (via analyzeBody) and assert headline shapes — e.g. summarize-codebase = agent → agent(mult unknown) → barrier → agent with 3 edges 0 loops; hunt-bugs = …→ decision with TopoLoop back to the find node crossing bands; triage = decision with one "no"-labeled cross-band edge and no merge.

Review focus: this unit IS the semantics — reviewers should check each policy bullet against what a reader of the original JS would expect the diagram to say (honest, not over-claiming).

## Review pipeline

- [ ] `/code-review`
- [ ] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
