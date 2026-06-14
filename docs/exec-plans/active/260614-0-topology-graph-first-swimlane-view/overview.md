# 260614-0 — Topology view: graph-first swimlane render (retire the banded card engine)

## Goal

Re-render `--view topology` as a **single continuous agent graph with phases as a faint swimlane overlay**, vertical flow — retiring the per-phase "card-as-container" banded engine. Faithful static analysis only (no inference): loops become local "repeat" badges, empty phases become slim strips, named-multiplicity fans connect onward properly, and **no edge is ever routed across a card wall** because there are no card walls.

## Context — why (the diagnosis this plan acts on)

Today `--view topology` is the v1 phase-card page with a mini-graph drawn *inside each card* (`design-context.md §8`: "each phase card carries its mini-graph"). **The phase card is a layout *container*.** Therefore any edge between two phases must exit one card, cross the gap, and enter the next — which produces, on inspection of the committed renders:

- loop back-edges routed through a global left gutter, crossing unrelated cards (choose-approach, hunt-bugs);
- control-only phases rendered as full empty numbered cards ("Advance the bracket");
- loud verbatim condition diamonds for `while`/`for`/`if`;
- cross-card forward edges with awkward multi-elbow routes — **and** named-multiplicity fans where only the last circle connects onward, so the others dangle (verified in `review-pr.svg`: one `xband-edge` from `review:performance`→verify; `correctness`/`security` have no outgoing edge).

Measured: **4 of 8 examples have cross-card edges** (review-pr, dual-lineage-review, triage-issue, choose-approach). The 3 genuinely-clean ones (summarize-codebase, name-the-feature, verify-fix) are clean *only because their whole graph fits inside one card* — they never exercise a card wall.

**Root cause: phase-as-container. Fix: phase-as-overlay.** Lay out ONE graph as a whole; paint phase-colored stripes behind wherever the nodes land. Same vertical, phase-ordered picture — opposite construction. With no walls, a cross-phase edge is just a short ordinary edge.

```
 CONTAINER (today)                 OVERLAY (this plan)
 ┌ Phase 1 ─────────┐              ░ Phase 1 ░░░░░░░░░
 │  ●──●──▮          │                 ●──●──▮
 └────────┬──────────┘                       │   one graph,
 ┌ Phase 2 ┴─────────┐  ← edge      ▒ Phase 2 ▒▒▒▒▒▒▒   no wall,
 │  ▶ ●  ↺           │    crosses       ▶ ●  ↺          phase = tint
 └───────────────────┘    the wall
```

### Target (vertical; durable copy of the mock)

```
░░ Draft the contenders ░░░░░░░░░░░░░░░░░  [sonnet]
        ●──●──●──●  ─▮ barrier
                    │
▒▒ Judge pairwise ▒▒│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  [opus]
                  ▶ ◉ judge  ↻ repeat while bracket.length > 1
                    │
·· Advance the bracket · control only ·· (slim strip, no card)
                    │
▓▓ Write up the winner ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  [haiku]
                  ▶ ◉ Document the winner
```

Width fixed (~760, README/mobile-safe); height grows downward and scrolls. Phase count is the long axis → vertical. Fan-out width is the bounded axis → spreads across width, collapses to `×N` when wide (analyzer already does this).

## Locked decisions (settled across the design conversation)

1. **Two separate views.** `--view phases` = the v1 spec cards, **byte-identical, untouched** (the `render-svg` snapshot stays the permanent gate). `--view topology` = the new graph-first swimlane render.
2. **Phase = overlay (paint), not container.** One global vertical layout; stripes painted from each phase's node y-range.
3. **Faithful, no inference.** No motif/pattern recognition, no `meta.pattern`, no art-directed templates. Counts literal-only (`×N` otherwise); condition labels verbatim truncated source slices. A loop is *aggregated* into body-nodes + a repeat badge — that is faithful summarisation, not pattern inference.
4. **Loops as local badges.** "↻ repeat while/until `<verbatim condition>`" attached to the loop body; never a routed back-edge. The multi-phase-loop body is a known residual — handled minimally (contained in its owning band + note), not via gutter routing.
5. **Empty / control-only phase** (zero agent nodes) → slim labeled strip, not a numbered card.
6. **Named-multiplicity fans connect onward from every member** — fixes the `review-pr` dangling-fan bug.
7. **Focused hand-rolled layout, zero new deps.** The hard parts of general DAG layout (cycle-break, network-simplex ranking, NP-hard crossing-minimisation, Brandes–Köpf coordinates) exist to solve *generality*; workflows are phase-structured + small + a known sub-shape vocabulary, so placement is driven by phase order + per-shape templates, sidestepping all of it. **dagre is documented as the fallback** if graphs ever become genuinely general (dense intra-phase DAGs, non-sequential cross-phase edges). The current 46KB engine failed by hand-rolling a *general edge router* (gutters/channels/hubs/headroom) — this design removes the need for one: loops local, cross-phase edges short verticals, phase = band placement.
8. **Layout consumes the analyzer TREE IR (`topology.ts`) directly.** Delete the flat banded IR + flattener + banded layout.
9. **Total function / fallback preserved.** Analysis failure or an unrecoverable body still falls back to the v1 phases page (CLI try/catch → stderr warning, exit 0).

## Architecture (modules)

- **KEEP unchanged:** `cli.ts`, `extract-meta.ts`, `model.ts`, `analyze-body.ts`, `topology.ts`, `svg-primitives.ts`, `render-svg.ts` (phases view), `output.ts`, `html.ts`, `render-png.ts`.
- **DELETE:** `flatten-topology.ts`, `topology-ir.ts` (flat banded IR), `layout-topology.ts`, and their tests/snapshots.
- **NEW:** `topo-geometry.ts` (positioned-geometry types) + `place-topology.ts` (Topology tree + meta → positioned `Layout`: the focused swimlane placement).
- **REWRITE:** `render-topology.ts` (positioned `Layout` → SVG).

Pipeline: `analyze-body` (tree) → **`place-topology`** (geometry) → **`render-topology`** (SVG).

## Unit list

| # | Title | Blocked by |
|---|---|---|
| 01 | Branch hygiene — clean baseline from `main`, ditch `topology-card-redesign` | — |
| 02 | Geometry IR + placement skeleton (seam, trivial cases) | 01 |
| 03 | Sub-shape placement (agent / fanout / pipeline / branch / loop) in phase bands | 02 |
| 04 | Swimlane composition — stack bands, paint stripes, empty→strip, cross-phase connectors | 03 |
| 05 | Renderer — positioned geometry → SVG | 04 |
| 06 | Retire banded engine, wire CLI, regen 8 examples, update docs, verify phases byte-identical | 05 |

## Out of scope

- Motif / pattern inference, `meta.pattern`, art-directed templates.
- dagre / elk adoption (documented fallback only — **not** added).
- Full multi-phase-loop routing (minimal containment + note).
- Horizontal orientation.
- Trace mode from `agent-*.jsonl`.

## Cross-cutting constraints

- Determinism: same input ⇒ same SVG (no `Date`/random; geometry array order canonical).
- `place-topology` is a **total function** — never throws on weird-but-valid trees; degrades to an honest placeholder/strip.
- NodeNext ESM (`.js` import specifiers); strict TS; match repo comment density + doc-comment style.
- Honesty held: literal-only counts (`×N`), verbatim condition slices, nothing silently dropped.
- All paint (palette) and geometry/typography constants stay in named single-place constants — restyle = constant swap + example/snapshot regen, never logic surgery.
- `--view phases` output stays **byte-identical** (its committed `render-svg` snapshot is the regression gate; never regenerate it).

## References

- `docs/design-context.md` — §2 (the body is "emergent and frequently undecidable statically"), §7 roadmap, **§8 rendering-quality claim to correct** (it overstates that v2 reads like the hand-designed catalog).
- `docs/exec-plans/completed/260612-0-topology-view-…/` — the banded engine this plan retires.
- `examples/*.svg` — the integration corpus; cross-card-edge count is the before/after measure.
