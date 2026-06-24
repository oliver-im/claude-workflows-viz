/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Judge Panel.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/draft-the-announcement.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 *
 * (Two fan-outs in a row — drafts, then judges — distinguish a parallel-scored
 * panel from the single-elimination bracket in choose-approach.js.)
 *
 * Grammar level: 1 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
 */
export const meta = {
  name: "Draft a launch announcement",
  description:
    "Draft the same announcement from several independent angles, score every draft against a panel of judges each applying one rubric lens, then synthesize the winner and graft in the best lines from the runners-up.",
  whenToUse:
    "When the solution space is wide and one draft iterated rarely beats several independent attempts judged in parallel — and the best version borrows a line or two from the ones it beat.",
  phases: [
    {
      title: "Draft from each angle",
      detail:
        "Spin up one writer per angle — MVP-first, risk-first, user-first — each producing a full self-contained draft, not a variation on a single shared outline.",
      model: "sonnet",
    },
    {
      title: "Score on the panel",
      detail:
        "A panel of judges scores all drafts at once, each judge ranking them on one rubric lens — clarity, credibility, memorability — so no single taste decides the winner.",
      model: "claude-opus-4-8",
    },
    {
      title: "Synthesize the winner",
      detail:
        "Take the panel's top-ranked draft and graft in the strongest lines from the runners-up, producing one version better than any single attempt.",
      model: "sonnet",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. Independent
// drafts fan out; a panel of judges scores them; the winner is synthesized.
// ---------------------------------------------------------------------------

const ANGLES = ["MVP-first", "risk-first", "user-first"];
const RUBRIC = ["clarity", "credibility", "memorability"];

phase("Draft from each angle");
const drafts = (
  await parallel(
    ANGLES.map((angle) => () =>
      agent(`Draft the announcement, ${angle}: ${args.brief}`, { label: `draft:${angle}` }),
    ),
  )
).filter(Boolean);

phase("Score on the panel");
const ballots = (
  await parallel(
    RUBRIC.map((lens) => () =>
      agent(`Rank every draft by ${lens}:\n${JSON.stringify(drafts)}`, {
        label: `judge:${lens}`,
        schema: { type: "object", properties: { ranking: { type: "array" } } },
      }),
    ),
  )
).filter(Boolean);

phase("Synthesize the winner");
const announcement = await agent(
  `Take the panel's top draft and graft in the best lines from the runners-up:\n${JSON.stringify(ballots)}`,
);
log(announcement);
