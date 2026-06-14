# Unit 01 — Branch hygiene: clean baseline from `main`

## Goal
Start the rework from a clean `main` baseline on a fresh branch; ditch `topology-card-redesign`.

## Why
`main` already holds everything we keep (analyzer, extract-meta, tree IR). The branch adds only `cb76aba` ("refine the band card") + uncommitted WIP — all on the band engine this plan deletes. No forward value; `cb76aba` is reflog-recoverable.

## Steps
1. Discard the tracked WIP (band-engine modifications + regenerated examples/snapshots): `git restore .` — the untracked plan dir under `docs/exec-plans/active/` survives (git leaves untracked files on switch).
2. `git switch main`.
3. `git switch -c topology-swimlane-view` (new branch; rename freely).
4. `git branch -D topology-card-redesign`.
5. `npm install && npm run build && npm test` — green on inherited `main` code.
6. `git add docs/exec-plans/active/260614-0-...` and commit the plan as the first commit on the new branch.

## Acceptance
- On a new branch off `main`; `topology-card-redesign` deleted.
- Working tree clean except the plan dir; build + test green.
- Decision recorded here: **no dagre** — zero new runtime deps for this plan.

## Notes
Destructive (`git restore`, `git branch -D`) — already authorized ("we can remove the uncommitted WIP", "ditch it"). Re-confirm before running.
