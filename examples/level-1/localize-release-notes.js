/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Map-Reduce Pipeline.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/localize-release-notes.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 *
 * (The only bundled sample to exercise `isolation: "worktree"` — each locale
 * writes its own file in parallel — and `workflow()`, here as the reduce step.)
 *
 * Grammar level: 1 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
 */
export const meta = {
  name: "Localize the release notes",
  description:
    "Map each target locale through its own translate-then-proofread pipeline — no barrier between the stages, so a fast locale ships while a slow one is still translating — then reduce the finished files into one pull request.",
  whenToUse:
    "For per-item work that fans wide and stages deep — translation, codemods, asset processing — where the slowest single item, not the slowest stage, should set the wall-clock.",
  phases: [
    {
      title: "Translate each locale",
      detail:
        "One translator per locale drafts the notes and writes its file in its own worktree, so the parallel writes never collide on disk.",
      model: "sonnet",
    },
    {
      title: "Proofread each translation",
      detail:
        "Back-translate to catch drift and lint each file as it lands; with no barrier between stages, a finished locale advances here while others are still translating.",
      model: "sonnet",
    },
    {
      title: "Reduce into one PR",
      detail:
        "Once every locale's file lands, a shared open-a-PR sub-workflow collates them into a single pull request with a per-locale summary of what changed.",
      model: "haiku",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. Each locale runs
// its own translate→proofread chain (no inter-stage barrier); a final reduce
// sub-workflow collects the per-locale files into one PR.
// ---------------------------------------------------------------------------

const LOCALES = ["de", "ja", "pt-BR", "fr"];

phase("Translate each locale");
const localized = await pipeline(
  LOCALES,
  (locale) =>
    agent(`Translate the release notes into ${locale}.`, {
      label: `translate:${locale}`,
      phase: "Translate each locale",
      isolation: "worktree",
    }),
  (draft) =>
    agent(`Back-translate to catch drift, then lint:\n${draft}`, {
      label: "proofread",
      phase: "Proofread each translation",
    }),
);

phase("Reduce into one PR");
// A saved sub-workflow does the reduce — collate every locale's file into one PR.
const pr = await workflow("open-localization-pr", { files: localized });
log(`Opened ${pr} from ${LOCALES.length} localized files`);
