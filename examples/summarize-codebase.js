/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Fanout-And-Synthesize.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/summarize-codebase.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 */
export const meta = {
  name: "Summarize an unfamiliar codebase",
  description:
    "Fan out one reader per top-level module, each summarizing its slice in isolation, then synthesize the slices into a single architecture overview.",
  whenToUse:
    "On first contact with a large repo no single context can hold, when each module still fits comfortably on its own for a focused reader.",
  phases: [
    {
      title: "List the modules",
      detail:
        "Walk the top-level directories and package manifests to build the work-list — one reader per module, nothing read in depth yet.",
      model: "haiku",
    },
    {
      title: "Read every module in parallel",
      detail:
        "Each reader summarizes its module's purpose, public surface, and key dependencies, blind to the others so they all run at once.",
      model: "sonnet",
    },
    {
      title: "Synthesize the overview",
      detail:
        "Merge the per-module summaries into one architecture doc: a dependency sketch, the real entry points, and where a newcomer should start.",
      model: "claude-opus-4-8",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. Readers fan out
// concurrently (a barrier), then a single agent synthesizes the results.
// ---------------------------------------------------------------------------

phase("List the modules");
const modules = await agent("List top-level modules with a one-line guess at each one's job.", {
  schema: { type: "object", properties: { modules: { type: "array" } } },
});

phase("Read every module in parallel");
const summaries = (
  await parallel(
    modules.modules.map((m) => () =>
      agent(`Summarize the ${m} module: purpose, public API, key dependencies.`, {
        label: `read:${m}`,
      }),
    ),
  )
).filter(Boolean);

phase("Synthesize the overview");
const overview = await agent(
  `Write one architecture overview from these module summaries:\n${JSON.stringify(summaries)}`,
);
log(overview);
