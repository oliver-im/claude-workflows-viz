# Unit 03 — Lexicon as the single source of truth
**Blocked by:** 02-dialect-epoch-ledger-and-provenance-headers**Agents involved:** main only
## Summary

Replace the scattered hard-coded vocabulary with one machine-usable lexicon, each token tagged with the epoch that introduced it (all `D1` at baseline), and have the recognizer consume it so the table and the analyzer cannot drift.

**Tasks**
- New `ts/dialect.ts` exporting a typed lexicon: each entry
  `{ token, kind, wired, sinceEpoch }`. The `wired` flag makes the boundary explicit —
  it is the contract Units 04/05 scope to:
  - **wired** (`true`) — string-identifier tokens the recognizer keys on *by name*, so
    they round-trip to a recognizer set: `orchestration-call`
    (`agent`/`workflow`/`parallel`/`pipeline`, `analyze-body.ts:269`) and `agent-option`
    (`label`/`model`/`agentType`/`phase`/`schema`, the `agentStep` switch
    `analyze-body.ts:~955-1014`).
  - **descriptive** (`false`) — recognized by **AST node shape, not a callee name**, so
    there is *no* identifier-set to round-trip: `marker` (`phase`), `width-idiom`
    (`.map` / `Array.from({length})`, `resolveMultiplicity` `analyze-body.ts:1136`),
    `host-construct` (loops, `if`/ternary, dispatched on `node.type` in `walkStatement`
    `analyze-body.ts:~442-451`). Carried for documentation + the feature-detection floor
    only.
  - Every entry `sinceEpoch: "D1"` at baseline.
- Refactor `analyze-body.ts` to derive `ORCHESTRATION_CALLEES` and the agent-option key set
  *from the **wired** entries of* `ts/dialect.ts` (single source of truth). Behavior must be
  byte-identical. Native-JS recognizers (loops/branches/`.map`) keep reading the AST as
  today — the lexicon only *documents* them, it does not drive their recognition.
- Add `docs/` cross-link: note in `workflow-js-structure.md` that `ts/dialect.ts` is the
  enumerated lexicon (the prose §3 stays the semantics; the table is the data), and that
  only **wired** entries are machine-consumed (Units 04/05).

**Acceptance**
- `ts/dialect.ts` lists every currently-recognized token; the recognizer imports the
  call/option sets from its **wired** entries; descriptive entries are present but not
  round-tripped into a recognizer set.
- Full suite unchanged: `npm test` green, `--view phases` snapshots byte-identical
  (`render-svg.test.ts.snap`), zero-opaque examples corpus
  (`analyze-body.examples.test.ts`) still passes.

**Notes / files**
- Pure refactor + new data module; reviewable by "is the table complete/correct vs the
  recognizers, and are all tests still green."

## Review pipeline

- [ ] `/code-review`
- [ ] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
