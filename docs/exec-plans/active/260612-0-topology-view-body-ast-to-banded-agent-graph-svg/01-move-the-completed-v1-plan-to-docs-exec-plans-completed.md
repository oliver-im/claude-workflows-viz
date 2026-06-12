# Unit 01 — Move the completed v1 plan to docs/exec-plans/completed
**Blocked by:** none**Agents involved:** main only**Topology:** none
## Summary

Migrate the previous plan directory from this repo's ad-hoc `plan/` root to the planview-default layout, so the repo has one plan home: `git mv plan/260607-0-build-claude-workflows-viz-workflow-meta-to-svg-and-png docs/exec-plans/completed/260607-0-build-claude-workflows-viz-workflow-meta-to-svg-and-png`, remove the now-empty `plan/`, and update every in-repo reference to the old path.

### Steps

1. `mkdir -p docs/exec-plans/completed` and `git mv` the plan dir as above.
2. Update LIVE references only — both are in `docs/design-context.md`: line 3 (the handoff line referencing `plan/260607-0-…/`) and line 65 (the resume note, which is also stale — it still says "Cursor is at Unit 03"; rewrite it to point at the completed dir and note the plan finished). `README.md` has no plan-path references (verified at pre-review). Do **NOT** edit the migrated plan dir's own contents — its internal `plan/260607-…` self-references (progress.md git-workflow block, per-unit codex commands) are the faithful historical record of what ran.
3. Commit as a `chore(plan):`-style move commit.

### Acceptance

- `plan/` no longer exists; `git log --follow docs/exec-plans/completed/260607-0-…/overview.md` shows continuous history.
- No live references to the old path: `grep -rn "plan/260607"` is clean **outside `docs/exec-plans/completed/`** (the migrated dir's historical self-references are expected and stay).
- Full test suite still green (nothing code-touching, but run it anyway).

Review focus: pure mechanical move — reviewers should check reference completeness, nothing else.

## Review pipeline

- [ ] `/code-review`
- [ ] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
