/**
 * Sample dynamic workflow for claude-workflows-viz — a two-reviewer gate.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/dual-lineage-review.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 *
 * (The "External review" phase names a non-Claude model, so it renders with
 * the neutral fallback badge instead of an opus/sonnet/haiku color.)
 */
export const meta = {
  name: "Review a change with two lineages",
  description:
    "Review the same diff with two independent reviewers — one Claude, one external — and merge only what both lineages agree is real, killing single-model blind spots.",
  whenToUse:
    "Before merging a risky change, when one model's blind spots are the failure mode and a second, differently-trained reviewer is cheap insurance.",
  phases: [
    {
      title: "Scope the diff",
      detail:
        "Compute the cumulative diff against the base branch and split it into focus targets the reviewers can attack independently.",
      model: "haiku",
    },
    {
      title: "Claude review",
      detail:
        "A Claude reviewer reads the diff for correctness, security, and convention drift, reporting each finding with file:line and a confidence.",
      model: "claude-opus-4-8",
    },
    {
      title: "External review",
      detail:
        "A second, non-Claude reviewer audits the same diff from scratch — its different training surfaces issues the first lineage anchors past.",
      model: "gpt-5-codex",
    },
    {
      title: "Merge the verdicts",
      detail:
        "Keep findings both lineages raise, flag the disagreements for a human, and drop what neither can defend on a second pass.",
      model: "sonnet",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. Two reviewers
// of different lineage audit the same diff; only agreed findings survive.
// ---------------------------------------------------------------------------

phase("Scope the diff");
const targets = await agent("Compute the diff vs main and split it into focus targets.", {
  schema: { type: "object", properties: { targets: { type: "array" } } },
});

const [claudeFindings, externalFindings] = await parallel([
  () =>
    agent(`Review these targets for correctness, security, conventions:\n${JSON.stringify(targets.targets)}`, {
      label: "review:claude",
      phase: "Claude review",
    }),
  () =>
    // A workflow can hand the same diff to a non-Claude reviewer via agentType.
    agent(`Independently audit the same targets:\n${JSON.stringify(targets.targets)}`, {
      label: "review:external",
      phase: "External review",
      agentType: "codex",
    }),
]);

phase("Merge the verdicts");
const merged = await agent(
  `Keep what both reviews agree on, flag the disagreements:\n${claudeFindings}\n---\n${externalFindings}`,
);
log(merged);
