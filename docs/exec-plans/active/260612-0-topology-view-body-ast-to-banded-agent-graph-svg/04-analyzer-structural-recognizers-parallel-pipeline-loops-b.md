# Unit 04 — Analyzer structural recognizers — parallel, pipeline, loops, branches
**Blocked by:** 03-analyzer-core-sequential-recognition-with-honest-degradat**Agents involved:** main only**Topology:** none
## Summary

Replace Unit 03's degradations with real recognition of the structured idioms, completing the analyzer. After this unit, all 8 examples produce fully-typed trees with zero opaques and zero notes — that corpus-wide invariant is the acceptance bar and pins recognizer completeness.

### Recognizers

- **`parallel(arg)`** → `ArrayExpression` of 0-param function thunks → `form:"branches"` (per-element `walkThunk`: expression body via walkExpression; block body via statement walk incl. `ReturnStatement` arguments; non-function element → `[OpaqueStep]` branch + note). `CallExpression` `<obj>.map(cb)` → `form:"fanout"`: multiplicity = `resolveMultiplicity(obj)`; cb's first param → `shadowed` + recorded as fan-out parameter; unwrap the double arrow (`item => () => agent(...)`), tolerate un-thunked single arrow; body steps get the fan-out multiplicity threaded onto produced `AgentStep`s. Anything else → `form:"fanout"`, unknown+hint, empty body, + note.
- **`pipeline(items, ...stages)`** → `PipelineStep{items: resolveMultiplicity(items), stages}`: each function stage walked (params → shadowed; first param = stage parameter); non-function stage → `[OpaqueStep]` + note; a stage returning `parallel(...)` nests naturally (review-pr).
- **Loops** — `While/DoWhile/For/ForOf/ForIn` with orchestrating bodies → `LoopStep{loopKind, conditionLabel: sliceSource(test) (for-of/in: left-through-right slice; for without test: header slice), body: walkStatements(...)}`; for-of over named/exact-resolvable collection → `iterations`; loop variable joins `shadowed`; orchestration in `test` → prepended steps; `phase()` markers inside bodies mutate ambient (hunt-bugs spans bands).
- **Branches** — `IfStatement`/`ConditionalExpression` with orchestration in ≥1 arm → `BranchStep{conditionLabel: sliceSource(test), thenSteps, elseSteps}`; statement arms wrapped as 1-element lists; `null`/non-orchestrating arm → `[]` (triage's empty then-arm); if with only logs → omitted; orchestration in test → prepended.
- **`expandedLabels`** — only when multiplicity is `named` AND the label is a template whose every expression is the bare fan-out/stage parameter → pure textual substitution of each name into the cooked quasis (e.g. `` `refute:${lens}` `` → refute:correctness/security/regressions).

### Tests

Remaining micro groups (Parallel both forms + shadowing + `Array.from`; expandedLabels positive/negative; unwrapping `.filter`/`.flat`/`.then` incl. orchestrating-callback opaque; Pipeline incl. per-stage opts.phase + non-function stage; Loops incl. nesting, do-while, for-of iterations, COND_MAX truncation; Branches incl. test-prepend) PLUS **`analyze-body.examples.test.ts`**: per-example structural assertions —

1. review-pr: agent → pipeline{items named[correctness,security,performance]; stage1 agent expanded review:\*, phase "Review by dimension"; stage2 parallel fanout unknown("review.findings") wrapping verify agent, phase "Adversarially verify"} → agent.
2. triage-issue: agent → branch{cond "confidence < 0.5", then [], else [agent fix:${area}, phase "Draft a fix"]}; "Reply or escalate" step-less.
3. summarize-codebase: agent → parallel fanout unknown("modules.modules") → agent.
4. verify-fix: agent → agent → parallel fanout named[correctness,security,regressions] expanded refute:\*; "Ship or bounce" step-less.
5. name-the-feature: parallel fanout named[literal,playful,metaphorical] expanded gen:\* → agent → agent.
6. choose-approach: parallel fanout named ×4 expanded draft:\* → loop while "bracket.length > 1" containing loop for "i < bracket.length" containing agent match (phase "Judge pairwise") → agent.
7. hunt-bugs: loop while "dryRounds < 2 && …" whose body holds agent (band "Find a round of bugs") and parallel fanout unknown("fresh") (band "Verify and bank the survivors") — spans bands.
8. dual-lineage-review: agent → parallel branches[ [agent review:claude, phase "Claude review"], [agent review:external, agentType codex, phase "External review"] ] → agent.

Corpus-wide invariant: every example → `hasOrchestration:true`, **zero `OpaqueStep`s, zero notes**.

Review focus: shadowing correctness (the one soundness hazard in const resolution); unwrap rule not double-counting; template-substitution staying purely textual.

## Review pipeline

- [ ] `/code-review`
- [ ] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
