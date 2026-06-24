/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Completeness Critic.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/compile-api-reference.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 *
 * (The loop is driven by a critic agent at its head — what it says is missing
 * becomes the next round of work — not by a fixed pass count.)
 *
 * Grammar level: 1 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
 */
export const meta = {
  name: "Compile an API reference",
  description:
    "Draft the reference from every source at once, then let a completeness critic name what's still missing — endpoints, params, error cases — and fill those gaps round after round until the critic signs off.",
  whenToUse:
    "When the cost of an incomplete reference is silent — a missing error code or undocumented param that nobody notices until it breaks — so explicit gap-finding beats hoping the first pass was thorough.",
  phases: [
    {
      title: "Draft from every source",
      detail:
        "Readers fan out across the docs, the handler code, and the changelog at once, each drafting the sections it can see so the first pass is broad, not deep.",
      model: "sonnet",
    },
    {
      title: "Critique and fill the gaps",
      detail:
        "A critic names what's missing — an undocumented param, an unlisted error, a stale example — and a writer fills each gap; repeat until the critic finds nothing left.",
      model: "claude-opus-4-8",
    },
    {
      title: "Assemble the reference",
      detail:
        "Stitch the drafted and back-filled sections into one ordered reference with a consistent voice and a working table of contents.",
      model: "haiku",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. A first pass is
// repeatedly critiqued for omissions; each round fills the gaps it names.
// ---------------------------------------------------------------------------

const SOURCES = ["the public docs", "the handler code", "the changelog"];

phase("Draft from every source");
const sections = (
  await parallel(
    SOURCES.map((src) => () =>
      agent(`Draft reference sections for ${args.pkg} from ${src}.`, { label: `draft:${src}` }),
    ),
  )
).filter(Boolean);

phase("Critique and fill the gaps");
let rounds = 0;
while (rounds < 3) {
  const audit = await agent(
    `What's missing from this reference — endpoints, params, error cases, examples?\n${JSON.stringify(sections)}`,
    { label: "critic: what's missing?", schema: { type: "object", properties: { gaps: { type: "array" } } } },
  );
  if (audit.gaps.length === 0) break;
  rounds += 1;
  const filled = (
    await parallel(
      audit.gaps.map((gap) => () => agent(`Write the missing section: ${gap}`, { label: `fill:${gap}` })),
    )
  ).filter(Boolean);
  sections.push(...filled);
  log(`Round ${rounds}: critic named ${audit.gaps.length} gaps, filled ${filled.length}`);
}

phase("Assemble the reference");
const reference = await agent(`Assemble the final ordered reference from:\n${JSON.stringify(sections)}`);
log(reference);
