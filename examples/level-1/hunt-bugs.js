/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Loop Until Done.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/hunt-bugs.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 *
 * (The final phase deliberately has a title but no `detail`.)
 *
 * Grammar level: 1 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
 */
export const meta = {
  name: "Hunt bugs until the search goes dry",
  description:
    "Repeatedly spawn finders that surface fresh bugs; keep looping while new ones appear and stop only after two rounds in a row turn up nothing new.",
  whenToUse:
    "For unknown-size discovery, where a fixed pass count either stops early and misses the tail or burns budget long after the well has run dry.",
  phases: [
    {
      title: "Find a round of bugs",
      detail:
        "Each round runs finders across the codebase and dedupes their hits against everything already seen, so only genuinely new bugs count.",
      model: "sonnet",
    },
    {
      title: "Verify and bank the survivors",
      detail:
        "Confirm each fresh bug actually reproduces, drop the false positives, and add what's left to the running ledger.",
      model: "claude-opus-4-8",
    },
    {
      title: "Stop when the well runs dry",
      model: "haiku",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. Keep finding
// until two consecutive rounds turn up nothing new (or the budget runs out).
// ---------------------------------------------------------------------------

const seen = new Set();
const ledger = [];
let dryRounds = 0;

phase("Find a round of bugs");
while (dryRounds < 2 && (!budget.total || budget.remaining() > 50_000)) {
  const found = await agent("Find bugs in the codebase.", {
    schema: { type: "object", properties: { bugs: { type: "array" } } },
  });
  const fresh = found.bugs.filter((b) => !seen.has(b.id));
  if (fresh.length === 0) {
    dryRounds += 1;
    continue;
  }
  dryRounds = 0;
  fresh.forEach((b) => seen.add(b.id));

  phase("Verify and bank the survivors");
  const real = (
    await parallel(
      fresh.map((b) => () =>
        agent(`Does this bug actually reproduce? ${b.title}`, {
          label: `verify:${b.id}`,
          schema: { type: "object", properties: { real: { type: "boolean" } } },
        }).then((v) => (v?.real ? b : null)),
      ),
    )
  ).filter(Boolean);
  ledger.push(...real);
  log(`Banked ${real.length}; ledger now holds ${ledger.length}`);
}

phase("Stop when the well runs dry");
log(`Search complete — ${ledger.length} confirmed bugs.`);
