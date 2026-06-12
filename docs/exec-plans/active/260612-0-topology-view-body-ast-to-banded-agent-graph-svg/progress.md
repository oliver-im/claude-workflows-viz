# 260612-0-topology-view-body-ast-to-banded-agent-graph-svg — Progress

**Cursor:** 06-banded-layout-engine-topology-renderer (not started).

## Pre-execution review

On the first session, before starting Unit 01, the **resuming agent** works through the step(s) below against the freshly materialized plan dir, then **stops** to wait for your go-ahead — it does not roll straight into Unit 01. Follow each step's routing: **auto-run** the agent-invocable ones (the default `/planview:pre-plan-review`, or an `exec` template) and surface their findings; for a `print` template or an operator-run slash command, **surface the command and stop** for you to run it:

- [x] `/planview:pre-plan-review` — done 2026-06-12: no HIGH; 2 MED (overview.md lost the plan preamble at materialization; Unit 05 expectation contradicted its no-implicit-cross-band-edge policy) + 2 LOW (Unit 01 acceptance grep scope; Unit 07 verification referenced the nonexistent review-pr.svg). All four fixed in the plan text before Unit 01.

## Git workflow

This plan is worked in its own git worktree, one branch per unit. Full steps: `docs/exec-plans/AGENTS.md` + `docs/CONVENTION.md`.

- **Worktree:** `worktrees/260612-0-topology-view-body-ast-to-banded-agent-graph-svg/` on branch `plan/260612-0-topology-view-body-ast-to-banded-agent-graph-svg` (off `main`); the plan's `active/` dir lives only inside it.
- **Per unit:** branch `unit/NN-slug` off the plan branch → work + review → `git merge --squash unit/NN-slug` into the plan branch as one `Unit NN: <title>` commit → `git branch -D unit/NN-slug` → advance the cursor.
- **At the end:** `git mv` the plan dir `active/ → completed/` (+ provenance stamp), commit, then `git checkout main && git merge --no-ff plan/260612-0-topology-view-body-ast-to-banded-agent-graph-svg`, `git worktree remove worktrees/260612-0-topology-view-body-ast-to-banded-agent-graph-svg`.

## Done

- **Unit 05** (2026-06-12, `26be6b2`) — `ts/flatten-topology.ts`: `flattenTopology(topology, meta) → {ir, bandTitles}`, the one-place policy layer. Bands meta-first + body-only appended (+ untitled sentinel for phase-less workflows, a lane-2 review fix); same-band-only implicit sequence edges; fanout→body+barrier (empty → "agents" placeholder); branches→chains+shared barrier in last contributor's band; pipeline per-stage chains, items mult applied to every stage's mult-one agents (expandedLabels become the named names), no inter-stage barriers; branch→decision+yes/no+labeled bypass+merge via the uniform connect engine; loop→synthesized decision at last body band + "yes" back arc + "no" exit, nested loops chain no-exits naturally. emitLink routes by direction to hold the frozen IR invariants (codex finding, accepted + documented). 40 tests (micros + all-8 exact graphs); 150/150, v1 snapshot byte-identical. Reviews: 2 /code-review lanes (1 fixed, 3 accepted w/ rationale) + codex (1 accepted w/ rationale).
- **Unit 04** (2026-06-12, `6d1a6e5`) — structural recognizers complete the analyzer: parallel branches/fanout (collection resolved before param shadowing, double-arrow unwrap, multiplicity threading), pipeline stages (expansion on the stage param; lane mult left to the flattener), all five loop kinds (do-while test steps follow the loop), if/ternary branches, expandedLabels by pure textual substitution. Corpus invariant lands: all 8 examples → fully-typed trees, ZERO opaques, ZERO notes (analyze-body.examples.test.ts). 109/109, v1 snapshot byte-identical. Reviews: 2 /code-review lanes + codex; fixed in-unit: do-while ordering, branch-arm phase leak → scoped-phase rule (conditional/per-lane regions restore ambient; sequential regions leak); accepted: expansion blind to rebound params, fan-out collections noted-not-walked.
- **Unit 03** (2026-06-12, `69289a3`) — `ts/analyze-body.ts`: total, never-execute static analyzer (pass-1 module consts via tryEvalLiteral; pass-2 walk: phase markers with lexical leak, agent/workflow recognition, chained-call unwrap, opaque+note ladder; structural constructs deliberately opaque until Unit 04); collectModuleConsts/resolveMultiplicity/containsOrchestration exported. 44 tests incl. all-8-examples interim integration; suite 80/80, v1 snapshot byte-identical. Reviews: /code-review partial (2 lanes user-stopped; honesty red-team + direct re-derivation) + codex (1 Low) — both real findings were the same hole, silent phase()-marker drops → fixed in-unit (drop notes at every abandoned-subtree exit); nested-agent-in-args note-only degradation accepted as within the ladder.
- **Unit 02** (2026-06-12, `9ab044a`) — `ts/svg-primitives.ts` (verbatim move + strokePath/polyline/roundedElbowPath/arrowHead), render-svg (x,w)-parameterization, extract-meta split (parseWorkflowSource/extractMetaFromProgram/readWorkflowSource/tryEvalLiteral), both IR contracts (`topology.ts` tree, `topology-ir.ts` flat with readonly arrays + frozen EMPTY_IR). 40/40 green, tsc clean. Reviews: /code-review 4 lanes clean — byte-identity PROVEN end-to-end (8 examples md5-identical HEAD vs HEAD^), contracts match Units 03–06 name-for-name, one accepted layering note; codex: no findings.
- **Unit 01** (2026-06-12, `32dd6a2`) — migrated `plan/260607-0-…` → `docs/exec-plans/completed/` (7 files, 100% renames, `--follow` continuous); de-staled the three live spots in `docs/design-context.md` (handoff path, resume note, build-state bullet — last one flagged by codex review); `.gitignore` `node_modules/`→`node_modules` so the worktree symlink stops sweeping into `git add -A`. Reviews: /code-review lanes clean; codex 2 findings → 1 fixed, 1 (gitignore revert suggestion) declined deliberately.

## Blockers

_None._

## Notes

- When resuming, read this file first to find the cursor unit, then read the cursor unit's md. Skip `overview.md` unless this is the first session on the plan.
- On the **first session**, run the Pre-execution review checklist above before starting the cursor unit. Surface findings and revise the plan if anything material lands.
- Work one unit at a time. After finishing the cursor unit, run its review steps, then update this file: move the unit into Done with a one-liner and advance the cursor to the next unit id.
- Stop after each unit. Surface a brief summary to the user and wait for explicit go-ahead before starting the next unit. If the unit is blocked, record it under Blockers and stop without advancing the cursor.

## Plan-level review

After the last unit's review lands and is committed, run the **`/planview:plan-review-prompt`** composer against the cumulative plan diff — don't run the vehicle(s) below directly. The composer aims a cross-unit focus and drives whatever is configured: it injects planview's own plan-level review prompt into a `{ run, mode }` template (then `print`/`exec` per its mode), or composes the focus into a slash command for you. Configured vehicle(s):

- [ ] `codex exec -s read-only "{focus}"` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
