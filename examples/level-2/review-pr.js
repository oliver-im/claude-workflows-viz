/**
 * Sample dynamic workflow for claude-workflows-viz.
 *
 * From a clone of this repo, render it with:
 *   claude-workflows-viz examples/level-2/review-pr.js --open
 *
 * The tool draws the `meta` block below AND the orchestration code beneath it,
 * and NEVER runs either — the body is recovered by static analysis alone.
 *
 * (This is the README's annotated hero, so it deliberately sits at the NEWEST
 * grammar level — the front page should advertise the current vocabulary, not a
 * subset of it. Hence the `opts.effort` tiers, drawn as a muted badge left of
 * each node, and `claude-fable-5` on the drafting phase. The first agent sets no
 * effort on purpose: omitted means "inherit the session tier", and the hero
 * should show that absence draws nothing rather than a placeholder.)
 *
 * Grammar level: 2 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
 */
export const meta = {
  name: "Review a pull request",
  description:
    "Review a branch's diff across independent dimensions, adversarially verify each finding, then synthesize a ranked report.",
  whenToUse:
    "Before merging a sizable or unfamiliar PR, when a single reviewer pass risks missing correctness, security, or performance regressions.",
  phases: [
    {
      title: "Map the diff",
      detail:
        "List changed files against the base branch and group them by subsystem so each reviewer gets a focused slice.",
      model: "haiku",
    },
    {
      title: "Review by dimension",
      detail:
        "One agent per dimension — correctness, security, performance — reviews its slice and reports findings with file:line.",
      model: "sonnet",
    },
    {
      title: "Adversarially verify",
      detail:
        "Spawn a panel of skeptics per finding, each prompted to refute it; drop anything the panel cannot defend.",
      model: "claude-opus-5",
    },
    {
      title: "Synthesize the report",
      detail:
        "Dedupe the survivors, rank them by severity, and write the review with reproducible citations.",
      model: "claude-fable-5",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body. claude-workflows-viz never executes any of this; it is
// included only to make the example a realistic dynamic workflow.
// ---------------------------------------------------------------------------

const DIMENSIONS = ["correctness", "security", "performance"];
const FINDINGS = { type: "object", properties: { findings: { type: "array" } } };
const VERDICT = { type: "object", properties: { real: { type: "boolean" } } };

// Effort is tiered the way the grammar advises: `low` for the mechanical passes,
// the higher tier reserved for the one genuinely adversarial step. The mapping
// agent sets none at all — `effort` is optional, and an omitted one inherits the
// session's tier and draws no badge.
phase("Map the diff");
const slices = await agent("List changed files vs main, grouped by subsystem.");

const reviewed = await pipeline(
  DIMENSIONS,
  (dim) =>
    agent(`Review these slices for ${dim} issues: ${JSON.stringify(slices)}`, {
      label: `review:${dim}`,
      phase: "Review by dimension",
      effort: "medium",
      schema: FINDINGS,
    }),
  (review) =>
    parallel(
      review.findings.map((f) => () =>
        agent(`Adversarially verify (default to refuted): ${f.title}`, {
          label: `verify:${f.title}`,
          phase: "Adversarially verify",
          effort: "high",
          schema: VERDICT,
        }).then((verdict) => ({ ...f, verdict })),
      ),
    ),
);

phase("Synthesize the report");
// `f?.` — a thunk that threw resolves to null in the parallel result, and a
// stage that threw drops its whole dimension to null; neither is a finding.
const confirmed = reviewed.flat().filter((f) => f?.verdict?.real);
log(`${confirmed.length} findings survived verification`);
const report = await agent(`Write a ranked review of: ${JSON.stringify(confirmed)}`, {
  effort: "low",
});
log(report);
