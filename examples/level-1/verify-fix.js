/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Adversarial Verification.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/verify-fix.js --open
 *
 * Only the `meta` block below is drawn; the orchestration body beneath it is
 * never executed — it's here just so this reads like a real workflow.
 *
 * Grammar level: 1 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
 */
export const meta = {
  name: "Adversarially verify a fix",
  description:
    "One worker proposes the smallest patch that makes a failing test pass; a panel of skeptics each tries to refute it, and it ships only if they can't.",
  whenToUse:
    "For a fix in a high-blast-radius area, where a plausible patch that merely silences the symptom is more dangerous than leaving the bug open.",
  phases: [
    {
      title: "Reproduce the failure",
      detail:
        "Confirm the bug reproduces from a clean checkout and capture the exact failing assertion as the ground truth every skeptic must respect.",
      model: "haiku",
    },
    {
      title: "Propose a minimal patch",
      detail:
        "Find the root cause and write the smallest patch (ideally < 20 lines) that turns the test green without weakening the assertion.",
      model: "sonnet",
    },
    {
      title: "Refute in parallel",
      detail:
        "Spawn skeptics on distinct lenses — correctness, security, regressions — each told to break the patch and to default to rejecting it.",
      model: "claude-opus-4-8",
    },
    {
      title: "Ship or bounce",
      detail:
        "Ship only if a majority of skeptics fail to refute; otherwise bounce the patch back with their strongest counter-example attached.",
      model: "sonnet",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. Independent
// skeptics attack one worker's patch; it survives only on a majority verdict.
// ---------------------------------------------------------------------------

const LENSES = ["correctness", "security", "regressions"];
const VERDICT = {
  type: "object",
  properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
};

phase("Reproduce the failure");
const failing = await agent("Reproduce the bug from a clean checkout; quote the failing assertion.");

phase("Propose a minimal patch");
const patch = await agent(`Write the smallest patch that fixes:\n${failing}`);

phase("Refute in parallel");
const verdicts = (
  await parallel(
    LENSES.map((lens) => () =>
      agent(`Through the ${lens} lens, try to refute this patch (default: refuted):\n${patch}`, {
        label: `refute:${lens}`,
        schema: VERDICT,
      }),
    ),
  )
).filter(Boolean);

phase("Ship or bounce");
const survived = verdicts.filter((v) => !v.refuted).length >= 2;
log(survived ? "Panel could not refute — shipping the patch." : "Refuted — bouncing it back.");
