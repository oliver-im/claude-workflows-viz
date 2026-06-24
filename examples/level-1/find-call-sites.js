/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Multi-Modal Sweep.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/find-call-sites.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 *
 * Grammar level: 1 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
 */
export const meta = {
  name: "Find every call site of a deprecated API",
  description:
    "Sweep the repo four different ways at once — each search blind to the others — then merge the hits and drop the same site found two ways, so no call site slips through one method's blind spot.",
  whenToUse:
    "Before removing a widely-used API, when any single search (plain grep, the type checker, the test suite) reliably misses a class of call sites the others catch.",
  phases: [
    {
      title: "Sweep every way at once",
      detail:
        "Four searchers run concurrently — by name, by call graph, by test references, by dynamic dispatch — each blind to the rest so no one method's blind spot decides coverage.",
      model: "sonnet",
    },
    {
      title: "Merge and dedupe the hits",
      detail:
        "Union every searcher's hits and collapse the same call site surfaced two different ways into one, so a site found by both grep and the type checker counts once.",
      model: "haiku",
    },
    {
      title: "Write the migration checklist",
      detail:
        "Turn the distinct call sites into an ordered checklist — file:line, the calling context, and the safe replacement — that a follow-up pass can work through.",
      model: "sonnet",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. Several blind
// searchers fan out (a barrier); their union is deduped into one site list.
// ---------------------------------------------------------------------------

const MODES = ["by name", "by call graph", "by test references", "by dynamic dispatch"];
const SITES = { type: "object", properties: { sites: { type: "array" } } };

phase("Sweep every way at once");
const sweeps = (
  await parallel(
    MODES.map((mode) => () =>
      agent(`Find call sites of ${args.api} ${mode}.`, {
        label: `sweep:${mode}`,
        schema: SITES,
      }),
    ),
  )
).filter(Boolean);

phase("Merge and dedupe the hits");
const union = sweeps.flatMap((s) => s.sites);
const distinct = await agent(
  `Merge these hits and drop the same call site found two ways:\n${JSON.stringify(union)}`,
  { schema: SITES },
);
log(`${distinct.sites.length} distinct call sites across ${MODES.length} searches`);

phase("Write the migration checklist");
const checklist = await agent(`Write an ordered migration checklist for:\n${JSON.stringify(distinct.sites)}`);
log(checklist);
