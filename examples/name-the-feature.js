/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Generate-And-Filter.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/name-the-feature.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 *
 * (This one deliberately omits `whenToUse` to exercise the sparse header.)
 */
export const meta = {
  name: "Name a new feature",
  description:
    "Several generators each pitch a batch of candidate names; one filter scores them for clarity & memorability, dedupes near-collisions, and keeps the best.",
  phases: [
    {
      title: "Generate candidates",
      detail:
        "Run generators with different framings — literal, playful, metaphorical — so the pool is genuinely diverse, not variations on one idea.",
      model: "sonnet",
    },
    {
      title: "Filter by rubric and dedupe",
      detail:
        "Score every name on clarity, memorability, and availability, collapse near-duplicates, and discard everything below the bar.",
      model: "claude-opus-4-8",
    },
    {
      title: "Shortlist the best",
      detail:
        "Return the top handful with a one-line rationale each, plus the strongest candidate that was cut and why it lost.",
      model: "haiku",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. Many cheap
// ideas first, then one consistent bar applied across all of them at once.
// ---------------------------------------------------------------------------

const FRAMINGS = ["literal", "playful", "metaphorical"];

phase("Generate candidates");
const batches = (
  await parallel(
    FRAMINGS.map((framing) => () =>
      agent(`Pitch 8 ${framing} names for: ${args.brief}`, {
        label: `gen:${framing}`,
        schema: { type: "object", properties: { names: { type: "array" } } },
      }),
    ),
  )
).filter(Boolean);

const candidates = batches.flatMap((b) => b.names);
log(`${candidates.length} candidates before filtering`);

phase("Filter by rubric and dedupe");
const kept = await agent(
  `Score, dedupe, and filter these names by clarity & memorability:\n${JSON.stringify(candidates)}`,
  { schema: { type: "object", properties: { kept: { type: "array" } } } },
);

phase("Shortlist the best");
const shortlist = await agent(`Pick the top 5 with a rationale from:\n${JSON.stringify(kept.kept)}`);
log(shortlist);
