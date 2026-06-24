/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Classify-And-Act.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/triage-issue.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 *
 * Grammar level: 1 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
 */
export const meta = {
  name: "Triage an incoming issue",
  description:
    "Classify a new bug report by subsystem, then route it to the one matching specialist to draft a fix — three of the four branches never run.",
  whenToUse:
    "When reports arrive faster than one engineer can read them and almost every issue belongs to a small, predictable set of subsystems.",
  phases: [
    {
      title: "Classify the report",
      detail:
        "Read the title and body and label the issue as frontend, backend, infra, or docs, picking the single best-fit owner with a confidence score.",
      model: "haiku",
    },
    {
      title: "Route to a specialist",
      detail:
        "Dispatch only to the matching agent — frontend & backend, infra, or docs — so the three branches that don't apply are never spawned.",
      model: "sonnet",
    },
    {
      title: "Draft a fix",
      detail:
        "The chosen specialist reproduces the bug, isolates the root cause, and writes a step-by-step plan naming the files to change.",
      model: "sonnet",
    },
    {
      title: "Reply or escalate",
      detail:
        "Post the plan back on the issue with a severity label and an owner, or escalate to a human when the classifier's confidence was low.",
      model: "haiku",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. A classifier
// routes the task to exactly one specialist; the other branches never spawn.
// ---------------------------------------------------------------------------

const SPECIALISTS = ["frontend", "backend", "infra", "docs"];
const LABEL = {
  type: "object",
  properties: { area: { type: "string" }, confidence: { type: "number" } },
};

phase("Classify the report");
const { area, confidence } = await agent(
  `Classify this issue into one of ${SPECIALISTS.join(", ")}:\n${args.issueBody}`,
  { schema: LABEL },
);

phase("Route to a specialist");
const plan =
  confidence < 0.5
    ? null
    : await agent(`As the ${area} specialist, draft a fix plan for:\n${args.issueBody}`, {
        label: `fix:${area}`,
        phase: "Draft a fix",
      });

phase("Reply or escalate");
if (plan) {
  log(`Routed to ${area}; posting the fix plan.`);
} else {
  log("Low confidence — escalating to a human triager.");
}
