# 260623-0-version-the-claude-code-workflow-dialect — Version the Claude Code workflow dialect
## Goal

Version the Claude Code workflow dialect.
## Context

_Why-now and the context that motivated this plan._

## Decisions (locked, v1)

_Lock decisions here so units don't have to re-litigate them._

## Out of scope (v1)

_Items deferred or explicitly not addressed._

## Unit list

| # | Title | Blocked by | Reviews |
|---|---|---|---|
| 01 | Capture machinery and the D1 baseline snapshot | — | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 02 | Dialect epoch ledger and provenance headers | 01 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 03 | Lexicon as the single source of truth | 02 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 04 | Per-file feature-detection (caniuse-style) | 03 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
| 05 | Reconciliation drift gate and lexicon-consistency test | 04 | /code-review + codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.' |
## Cross-cutting constraints

_Conventions, invariants, etc._

## References

_Linked docs and external context._
