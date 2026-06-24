/**
 * Sample dynamic workflow for claude-workflows-viz.
 *
 * From a clone of this repo, render it with:
 *   claude-workflows-viz examples/review-pr.js --open
 *
 * The tool draws the `meta` block below and NEVER runs the orchestration code
 * beneath it — the body is here only so this reads like a real workflow.
 *
 * Grammar level: 1 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
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
      model: "claude-opus-4-8",
    },
    {
      title: "Synthesize the report",
      detail:
        "Dedupe the survivors, rank them by severity, and write the review with reproducible citations.",
      model: "sonnet",
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

phase("Map the diff");
const slices = await agent("List changed files vs main, grouped by subsystem.");

const reviewed = await pipeline(
  DIMENSIONS,
  (dim) =>
    agent(`Review these slices for ${dim} issues: ${JSON.stringify(slices)}`, {
      label: `review:${dim}`,
      phase: "Review by dimension",
      schema: FINDINGS,
    }),
  (review) =>
    parallel(
      review.findings.map((f) => () =>
        agent(`Adversarially verify (default to refuted): ${f.title}`, {
          label: `verify:${f.title}`,
          phase: "Adversarially verify",
          schema: VERDICT,
        }).then((verdict) => ({ ...f, verdict })),
      ),
    ),
);

phase("Synthesize the report");
const confirmed = reviewed.flat().filter((f) => f.verdict?.real);
log(`${confirmed.length} findings survived verification`);
const report = await agent(`Write a ranked review of: ${JSON.stringify(confirmed)}`);
log(report);
