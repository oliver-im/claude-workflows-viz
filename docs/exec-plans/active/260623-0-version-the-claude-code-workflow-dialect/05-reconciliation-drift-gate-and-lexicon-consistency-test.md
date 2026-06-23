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

- [ ] `/code-review`
- [ ] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
