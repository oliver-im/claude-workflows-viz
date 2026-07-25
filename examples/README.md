# Example gallery

The bundled workflows are the tool's **example corpus** — versioned by
[grammar level](../docs/GRAMMAR-CHANGELOG.md) under `level-N/`, each also
declaring its level in-file (a `Grammar level: N` header). The test
`ts/__tests__/examples.grammar.test.ts` enforces that the directory, the in-file
stamp, and what the file actually uses all agree, so a sample can't silently
drift past the recognizer; `npm run regen-examples` rebuilds the committed
SVG/PNG renders.

A sample lives at the level of the **newest construct it uses**, so the level-1
directory is not legacy — it is the set of workflows expressible in the baseline
vocabulary, and most workflows still are.

Across both levels the thirteen workflows cover all six patterns from Anthropic's
[*A harness for every task*](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)
post, and seven more.

## Level 2

Minted when `agent()` gained `opts.effort`.

| Workflow | Pattern | Render |
| --- | --- | --- |
| [`review-pr.js`](level-2/review-pr.js) | review pipeline — staged lanes, no inter-stage barrier; effort `medium` → `high` → `low`, with the mapping agent setting none and inheriting the session tier | [SVG](level-2/review-pr.svg) · [PNG](level-2/review-pr.png) |
| [`tier-the-effort.js`](level-2/tier-the-effort.js) | effort tiering — `opts.effort` per stage: skim `low`, root-cause `max`, cross-examine `high`, draft `low` | [SVG](level-2/tier-the-effort.svg) · [PNG](level-2/tier-the-effort.png) |

`review-pr.js` is also the README's annotated hero. **The hero always sits at the
newest level** — the front page should advertise the current vocabulary rather
than a subset of it — so minting a level means promoting it, not just adding a
sample beside it.

## Level 1

The eleven workflows expressible in the baseline vocabulary; each links to its
committed renders.

| Workflow | Pattern | Render |
| --- | --- | --- |
| [`triage-issue.js`](level-1/triage-issue.js) | classify-and-act — a decision routes to one of several specialists | [SVG](level-1/triage-issue.svg) · [PNG](level-1/triage-issue.png) |
| [`summarize-codebase.js`](level-1/summarize-codebase.js) | fanout-and-synthesize — ×N readers, barrier, one synthesizer | [SVG](level-1/summarize-codebase.svg) · [PNG](level-1/summarize-codebase.png) |
| [`verify-fix.js`](level-1/verify-fix.js) | adversarial verification — named skeptic lanes converge on a barrier | [SVG](level-1/verify-fix.svg) · [PNG](level-1/verify-fix.png) |
| [`name-the-feature.js`](level-1/name-the-feature.js) | generate-and-filter — diverse generators, one filter | [SVG](level-1/name-the-feature.svg) · [PNG](level-1/name-the-feature.png) |
| [`choose-approach.js`](level-1/choose-approach.js) | tournament — drafts, then a pairwise-judging loop until one stands | [SVG](level-1/choose-approach.svg) · [PNG](level-1/choose-approach.png) |
| [`hunt-bugs.js`](level-1/hunt-bugs.js) | loop-until-done — keep spawning finders until rounds come up dry | [SVG](level-1/hunt-bugs.svg) · [PNG](level-1/hunt-bugs.png) |
| [`find-call-sites.js`](level-1/find-call-sites.js) | multi-modal sweep — blind searchers fan out, then merge & dedupe | [SVG](level-1/find-call-sites.svg) · [PNG](level-1/find-call-sites.png) |
| [`draft-the-announcement.js`](level-1/draft-the-announcement.js) | judge panel — independent drafts, then a rubric panel scores in parallel | [SVG](level-1/draft-the-announcement.svg) · [PNG](level-1/draft-the-announcement.png) |
| [`compile-api-reference.js`](level-1/compile-api-reference.js) | completeness critic — a critic names the gaps; each round fills them | [SVG](level-1/compile-api-reference.svg) · [PNG](level-1/compile-api-reference.png) |
| [`localize-release-notes.js`](level-1/localize-release-notes.js) | map-reduce pipeline — a per-locale `pipeline()` with worktree isolation, reduced by a `workflow()` | [SVG](level-1/localize-release-notes.svg) · [PNG](level-1/localize-release-notes.png) |
| [`dual-lineage-review.js`](level-1/dual-lineage-review.js) | dual-lineage — two independent reviewer lineages, merged verdicts | [SVG](level-1/dual-lineage-review.svg) · [PNG](level-1/dual-lineage-review.png) |
