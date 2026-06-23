# Unit 04 — Per-file feature-detection (caniuse-style)
**Blocked by:** 03-lexicon-as-the-single-source-of-truth**Agents involved:** main only
## Summary

Compute a per-file *required-minimum dialect epoch* from the lexicon tokens a file actually uses, expose it in the JSON emit, and warn on stderr when it exceeds the recognizer's target.

**Tasks**
- Compute the per-file minimum **once, inside `analyzeBody`**, and attach `requiredDialect`
  + `recognizerTarget` to the `Topology` IR (`ts/topology.ts`). Compute it as
  `max sinceEpoch over the **wired** lexicon tokens the file uses` (default `D1`;
  descriptive/native-JS constructs are always-present and never raise it — Unit 03's wired
  boundary). Both call sites already produce a `Topology`, so attaching here means *one*
  computation feeds both consumers below — **not** a separate pass wired into two emitters.
  Honesty rule: known wired tokens raise the minimum; additionally flag bare calls that are
  orchestration-*shaped* but **not** in the lexicon as "possibly newer than D1" (a distinct,
  softer signal) rather than silently ignoring them.
- JSON path gets it for free: `ts/emit-json.ts` already emits the `topology` block (it calls
  `analyzeBody` itself via `cli.ts:118`), so `requiredDialect`/`recognizerTarget` ride along
  (bump the `schema` tag if appropriate).
- Surface the warning in `run()` (`cli.ts:103`), reading `topology.requiredDialect`
  **before/independent of** the `!hasOrchestration` early return in `renderTopologyView`
  (`cli.ts:92`). This matters: a file using a construct newer than the recognizer tends to
  go opaque and may recover *no* orchestration — a warning placed after that early return
  would stay silent for its own motivating case. One line when
  `requiredEpoch > recognizerTarget` ("file uses constructs from dialect ≥ Dk; recognizer
  targets D1 — newer constructs may render opaque"). Render output is otherwise unchanged.

**Acceptance**
- A fixture using only D1 constructs: no warning, JSON `requiredDialect: "D1"`.
- A synthetic fixture exercising a token the lexicon tags at a hypothetical `D2`: stderr
  warning fires and JSON reflects `requiredDialect: "D2"`. (Add the `D2` token as a
  test-only lexicon entry, or assert via a unit test on the min-computation.)
- A fixture whose newer/unknown construct recovers **no** orchestration
  (`hasOrchestration === false`) still emits the warning — proving it is independent of the
  `cli.ts:92` early return.
- Existing example outputs unchanged when nothing is newer than the target.

**Notes / files**
- Depends on Unit 03's lexicon. New fixtures under `ts/__tests__/fixtures/`; unit test for
  the epoch-max computation. Reviewable end-to-end via the two fixtures.

## Review pipeline

- [ ] `/code-review`
- [ ] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
