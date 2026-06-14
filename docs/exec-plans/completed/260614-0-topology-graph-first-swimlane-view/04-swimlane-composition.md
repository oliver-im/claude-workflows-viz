# Unit 04 — Swimlane composition

## Goal
Compose the placed per-phase sub-graphs into one vertical page: stacked lanes, painted stripes, slim empty strips, and clean cross-phase connectors — the step that removes card walls.

## Changes (in `place-topology.ts`)
- Stack phases top→down at fixed width; each lane's `yTop`/`yBot` = the y-range its sub-graph occupies (+ padding). Lane order = meta phases first, then body-only phases (first-appearance), matching today's band-title merge.
- **Empty / control-only phase** (no agent/task nodes placed) → `GLane.empty = true`, collapsed to a slim fixed-height strip; the graph flows past it.
- **Cross-phase sequential connector:** exit node(s) of phase k → entry node of phase k+1, as a short mostly-vertical `seq` edge in the single coordinate space (no gutter, no elbow detour). Pipeline `stage` edges likewise span lanes directly.
- **Multi-phase loop residual:** if a loop body spans phases, keep the badge on the body's first lane and DO NOT route a back-edge across lanes; emit an `AnalysisNote`-style log. (Corpus has none.)
- Compute final `Layout.height`.

## Acceptance / tests (hand-built IR for tournament / hunt-bugs / triage shapes)
- Tournament → 4 lanes, "Advance the bracket" lane `empty:true` (strip), loop badge on Judge lane, **no edge with a band-crossing back-route**, sequential connectors only.
- Triage → router fan contained in its lane; the classify→route→fix connectors are short verticals.
- Hunt-bugs → loop badge local; exit phase is a strip.
- Invariant assertion: **every `GEdge` has `from.y ≤ to.y`** (no upward edges — loops are badges, not edges).

## Notes
This is the unit that makes the "0 cross-card edges" invariant true by construction.
