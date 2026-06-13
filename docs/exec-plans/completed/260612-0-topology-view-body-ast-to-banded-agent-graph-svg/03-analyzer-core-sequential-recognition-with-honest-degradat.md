# Unit 03 — Analyzer core — sequential recognition with honest degradation
**Blocked by:** 02-foundations-shared-primitives-parse-refactor-and-both-ir**Agents involved:** main only**Topology:** none
## Summary

Land `ts/analyze-body.ts` with the full walking skeleton, phase/band attribution, `agent()`/`workflow()` recognition, multiplicity resolution, and the complete degradation ladder — but with the structural recognizers (parallel/pipeline/loop/branch) deliberately NOT yet implemented: those constructs degrade to `OpaqueStep` + note this unit (expected incompleteness; Unit 04 replaces the degradation with real recognition). In this state the analyzer is already total, honest, and shippable.

### Signature & behavior

`analyzeBody(program: acorn.Node, src: string, metaPhases: readonly string[]): Topology` — **total, never throws**; each top-level statement wrapped in try/catch (internal error → opaque/skip + note). Walk state: `ambientPhase`, `bands` (seeded from metaPhases, `inMeta:true`; body-only titles appended in first lexical occurrence order, `inMeta:false`), `notes`, `consts: Map<string, unknown>`, lexical `shadowed: Set<string>`.

**Pass 1 — module consts:** top-level (incl. inside `ExportNamedDeclaration`) `const` declarators with `Identifier` ids (skip `meta`): `tryEvalLiteral(init)` → store on success. Never `let`/`var` (reassignable). Order-independent lookup.

**Pass 2 — statement walk** (`walkStatements`), per type: `ImportDeclaration`/meta-decl → skip; `ExpressionStatement` of `phase("literal")` → set ambient + register band, emit nothing; `log`/`budget.*` without orchestration → nothing; `VariableDeclaration` → walk each `init` (binding pattern — Identifier/ObjectPattern/ArrayPattern — irrelevant); loops/ifs → THIS unit: if `containsOrchestration` → `OpaqueStep` + note (Unit 04 upgrades); `BlockStatement` → walk inner (same ambient); `TryStatement` → walk block inline, handler/finalizer with orchestration → walk + note "try/catch flattened"; `FunctionDeclaration` → never walked; if it contains orchestration → note "helper '<name>' contains agent calls; not traced"; catch-all → orchestration ? one `OpaqueStep{label: first source line truncated}` + note : nothing.

**`containsOrchestration(node)`:** recursive scan for `CallExpression` with bare `Identifier` callee ∈ {agent, parallel, pipeline, workflow}; descends into nested function bodies; used ONLY as the emit/skip gate.

**Expression recognizers (`walkExpression`):** normalize repeatedly — `AwaitExpression` → argument; this unit, a `CallExpression` on a `MemberExpression` whose object contains orchestration → walk the object and scan call arguments (orchestrating callback → opaque + note) [the `.filter(Boolean)`/`.then` unwrap rule — landing here because sequential `agent(...).then(...)` appears without structural recognizers]. Then dispatch: **`agent(prompt, opts?)`** → `AgentStep`: opts must be `ObjectExpression` to be read (else note); `label`/`model`/`agentType`/`phase` from string literals; label template → verbatim inner source slice; opts.phase template-with-expressions → ignored + note; label precedence opts.label > prompt literal/template-head (truncated, "…" if expressions follow) > "agent"; `promptPreview` at its cap; phase = opts.phase (registers band) else ambient; multiplicity from threaded fan-out context (default one — context threading lands in Unit 04, default-only here). **`workflow(nameOrRef)`** → `WorkflowStep` (string-literal label else source slice). **`phase(x)`** in expression position → note (only statement-level markers honored). Other calls/expressions → `[]` (statement gate decides opaqueness).

**`resolveMultiplicity(expr)`:** `ArrayExpression` (no holes/spread): all string literals → `named`, else `exact(length)`; holes/spread → unknown. `Identifier`: shadowed → unknown(hint); else `consts` lookup (string array → named, array → exact, else unknown). `Array.from({length: L})` with literal/const-resolved numeric L → `exact(L)`. Else → `unknown{hint: sliceSource(expr, HINT_MAX)}`.

**`hasOrchestration`:** recursive scan of produced steps for kind ∈ {agent, workflow, parallel, pipeline} (opaque-only ⇒ false ⇒ renderer falls back to v1 wholesale).

### Tests (`ts/__tests__/analyze-body.test.ts`, micro-fixtures: inline source → IR assertions)

Groups: Sequence & phases (order; markers; pre-marker `phase: null`; bands ordering + inMeta flags; lexical leak); Agent opts (label literal/template-slice; model/agentType; opts.phase override + band registration; template phase ignored + note; non-literal opts note); Label fallback (truncations, bare `agent()`, promptPreview cap); resolveMultiplicity (named/exact/unknown; const-after-use resolves; `let` doesn't; `Array.from`); Workflow & catch-all (workflow step; switch-with-agent → opaque+note; FunctionDeclaration note; bare `xs.map(x => agent(x))` → opaque+note); Totality & honesty (zero-orchestration → `hasOrchestration:false`; weird-valid-JS grab bag never throws; determinism). Interim integration: all 8 `examples/*.js` analyze without throwing; sequential agents recognized.

Review focus: the never-execute invariant (no evaluation beyond `tryEvalLiteral` on consts); totality; the degradation ladder (nothing silently dropped — every drop is a note or an opaque).

## Review pipeline

- [x] `/code-review` — done 2026-06-12, partially: 2 of 4 finder lanes user-stopped mid-fan-out; completed lanes: honesty red-team (10 adversarial hand-traces; confirmed never-execute invariant) + pitfalls (partial, acorn key handling confirmed; residual checks re-derived directly). Findings: (1) silent band drop — phase() markers inside dropped/opaque regions lost without a note → **fixed in-unit** (collectPhaseCalls + notePhaseMarkerDrops at every abandoned-subtree exit, +4 tests); (2) `agent(agent("inner"))` — inner agent degrades to the args-scan note, not a step → adjudicated within the honesty ladder (argument-flow modeling out of scope), accepted.
- [x] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: done 2026-06-12: 1 Low — nested expression-position `phase()` calls silently ignored (`const x = wrap(phase("A"))`) → **fixed in-unit** by the same drop-note mechanism; no other correctness or intent-drift findings; tsc independently verified ("expected opaque degradation … matches the unit plan").

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
