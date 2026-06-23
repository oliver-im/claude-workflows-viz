# Unit 05 — Reconciliation drift gate and lexicon-consistency test
**Blocked by:** 04-per-file-feature-detection-caniuse-style**Agents involved:** main only
## Summary

Add the upstream-drift ritual (`check-dialect`) and a CI-runnable consistency test, drawing the honest line between what needs the installed binary and what does not.

**Tasks**
- Add a `--check` mode to `scripts/capture-dialect.mjs` and a
  `"check-dialect": "node scripts/capture-dialect.mjs --check"` script: re-capture from the
  installed CC, compare prose/schema sha256 to the latest committed `spec/upstream/` baseline,
  print a concise diff summary and exit non-zero on any mismatch (the "CC changed → reconcile"
  signal); fail loud if no CC install or anchors moved.
- Document in `DIALECT-CHANGELOG.md` that `check-dialect` runs **where Claude Code is
  installed** (a dev machine or a scheduled local agent), **not** generic GitHub CI, which
  has no `claude` binary. This closes Unit 02's forward-reference.
- Add `ts/__tests__/dialect.test.ts`: assert lexicon ↔ recognizer consistency with **no CC
  dependency**, scoped to the **wired** entries (Unit 03) — every `orchestration-call` token
  in `ts/dialect.ts` is in the recognizer's derived `ORCHESTRATION_CALLEES` and vice-versa;
  every `agent-option` token is one the `agentStep` switch reads. Descriptive entries
  (`marker`/`width-idiom`/`host-construct`) have no identifier-set to round-trip and are
  deliberately out of this test's scope. This is the part that runs in normal `vitest` CI.

**Acceptance**
- `npm run check-dialect` exits 0 against the current install (matches D1 baseline).
- Simulated drift (hand-edit a committed snapshot byte) → `check-dialect` exits non-zero with
  a clear message.
- `npm test` includes and passes the lexicon-consistency test.

**Notes / files**
- Depends on Unit 01 (capture core) and Unit 03 (lexicon). Reviewable by running the gate in
  both matched and drifted states and confirming the new test is green.

## Review pipeline

- [x] `/code-review` — 5 finder agents (script `--check` correctness; test validity; docs↔code; cleanup; refactor behavior-preservation). Behavior-preservation + cleanup came back clean; the default capture path is byte-identical (only `manifest.json`'s `capturedAt` provenance changes, by design). **Four fixes applied:** (1) `latestBaselineName` now sorts with numeric collation so `cc-2.1.9` < `cc-2.1.100` (plain lexicographic picked the wrong same-day baseline); (2) a malformed `manifest.json` degrades provenance to `cc-?` instead of crashing the gate; (3) the `schema` option probe's comments were overclaiming "proves dispatch" — `case schema: break` is behaviorally inert, so the comments now concede it's a smoke check and schema's real coverage is the round-trip (the other 8 probes have genuine dispatch teeth, incl. the verified parallel/pipeline→opaque degradation trace); (4) flipped the stale "planned lexicon-consistency test" forward-references in `workflow-js-structure.md` and `ts/dialect.ts` to present tense.
- [x] `codex exec -s read-only` — one HIGH intent-fidelity finding: the docs said "latest **committed** snapshot" but the gate reads the **working-tree** files. Resolved as a **wording fix, not a behavior change** — working-tree semantics is what the acceptance requires (a hand-edited snapshot byte must be caught, which a git-blob read would miss) and what makes the reconcile loop's re-capture-then-re-check work; the script comments + changelog now say "the checked-in baseline, read from disk." No correctness defects.

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
