/**
 * Sample dynamic workflow for claude-workflows-viz — pattern: Effort Tiering.
 *
 * Render it (without ever running it):
 *   claude-workflows-viz examples/level-2/tier-the-effort.js --open
 *
 * Both halves below are drawn: the `meta` block, and the orchestration body
 * beneath it — which is recovered by static analysis and never executed.
 *
 * (The level-2 sample: every `agent()` sets `opts.effort`, which draws as a
 * muted badge to the LEFT of each node — the mirror of the ×N badge on the
 * right. The last phase names `claude-fable-5`, so it renders in the fable
 * swatch rather than the neutral fallback.)
 *
 * Grammar level: 2 — the grammar generation this is written against (see docs/GRAMMAR-CHANGELOG.md).
 */
export const meta = {
  name: "Tier the effort across a triage pipeline",
  description:
    "Spend reasoning where it changes the answer: skim every crash report at the lowest tier, root-cause each one at the highest, cross-examine the causes in between, and draft the digest cheaply.",
  whenToUse:
    "When the work is wide but the hard part is narrow — a flat effort setting either overpays on the skim or underpays on the adjudication.",
  phases: [
    {
      title: "Skim every report",
      detail:
        "A mechanical pass per report: pull the stack frame, the build id, and the first reproducing step. Cheap by construction, so it runs at the lowest tier.",
      model: "haiku",
    },
    {
      title: "Root-cause each crash",
      detail:
        "The one genuinely hard step, and the only one at the top tier — everything downstream is checking or restating its answer.",
      model: "claude-opus-5",
    },
    {
      title: "Cross-examine the causes",
      detail:
        "Three lenses try to break each root cause. Demanding, but bounded by the cause already in hand, so a tier below the adjudication is enough.",
      model: "claude-opus-5",
    },
    {
      title: "Write the digest",
      detail: "Restating settled findings — a drafting job, not a reasoning one.",
      model: "claude-fable-5",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. One pipeline per
// report: skim cheaply, then root-cause at full effort. No barrier between the
// stages, so a report that skims fast starts its adjudication while others are
// still on the first stage.
// ---------------------------------------------------------------------------

const reports = args?.reports ?? [];
const LENSES = ["timing", "memory", "config"];

// A stage that throws drops its report to `null` (and skips the rest of the
// chain), so filter before anything downstream reads a field off a cause.
const causes = (
  await pipeline(
    reports,
    (report) =>
      agent(`Extract the stack frame, build id, and first repro step from: ${report}`, {
        label: `skim:${report}`,
        phase: "Skim every report",
        effort: "low",
        model: "haiku",
        schema: { type: "object", properties: { frame: { type: "string" } } },
      }),
    (skim, report) =>
      agent(`Root-cause this crash. Frame: ${skim.frame}. Report: ${report}`, {
        label: `root-cause:${report}`,
        phase: "Root-cause each crash",
        effort: "max",
        model: "claude-opus-5",
        schema: { type: "object", properties: { cause: { type: "string" } } },
      }),
  )
).filter(Boolean);

// Every lens gets its own shot at every cause; a cause no lens can break stands.
phase("Cross-examine the causes");
const verdicts = await parallel(
  LENSES.map((lens) => () =>
    agent(`Try to break these root causes through the ${lens} lens: ${JSON.stringify(causes)}`, {
      label: `refute:${lens}`,
      effort: "high",
      model: "claude-opus-5",
      schema: { type: "object", properties: { broken: { type: "array" } } },
    }),
  ),
);

const standing = causes.filter((c) => !verdicts.some((v) => v?.broken?.includes(c.cause)));
log(`${standing.length} of ${causes.length} root causes survived cross-examination`);

phase("Write the digest");
await agent(`Write the triage digest for these root causes: ${JSON.stringify(standing)}`, {
  effort: "low",
  model: "claude-fable-5",
});
