/**
 * workflow-readability demo — BEFORE.
 *
 * A verbatim copy of examples/choose-approach.js: a faithful, honest diagram
 * whose node labels read like code (`draft:${p}`, `match:${i / 2}`) and whose
 * bye-branch reads `!b`. Render it, then compare with the `.after.js` sibling:
 *
 *   claude-workflows-viz choose-approach.before.js -o before.svg
 */
export const meta = {
  name: "Choose an implementation approach",
  description:
    "Draft several independent approaches to the same problem, then run a single-elimination bracket of pairwise judges until one approach is left standing.",
  whenToUse:
    "When the design space is wide and quality is easier to judge head-to-head than to score in the abstract — pairwise comparison beats absolute scoring.",
  phases: [
    {
      title: "Draft the contenders",
      detail:
        "Generate several approaches from different priorities — simplest, most scalable, least risky — each a self-contained design brief.",
      model: "sonnet",
    },
    {
      title: "Judge pairwise",
      detail:
        "Every match pits two approaches on the same rubric; the judge picks the stronger and names the single deciding factor.",
      model: "claude-opus-4-8",
    },
    {
      title: "Advance the bracket",
      detail:
        "Winners re-pair each round and losers drop out, repeating until one approach survives the final match.",
    },
    {
      title: "Write up the winner",
      detail:
        "Document the winning approach and graft in the best ideas from the contenders it beat on the way to the final.",
      model: "haiku",
    },
  ],
};

// ---------------------------------------------------------------------------
// Orchestration body — never executed by claude-workflows-viz. A bracket of
// pairwise judges collapses many contenders down to one winner.
// ---------------------------------------------------------------------------

phase("Draft the contenders");
const PRIORITIES = ["simplest", "most scalable", "least risky", "fastest to ship"];
let bracket = (
  await parallel(
    PRIORITIES.map((p) => () =>
      agent(`Design the ${p} approach to: ${args.problem}`, { label: `draft:${p}` }),
    ),
  )
).filter(Boolean);

phase("Judge pairwise");
while (bracket.length > 1) {
  const next = [];
  for (let i = 0; i < bracket.length; i += 2) {
    const a = bracket[i];
    const b = bracket[i + 1];
    if (!b) {
      next.push(a);
      continue;
    }
    const match = await agent(`Pick the stronger approach and say why:\nA: ${a}\nB: ${b}`, {
      label: `match:${i / 2}`,
      phase: "Judge pairwise",
      schema: { type: "object", properties: { winner: { type: "string" } } },
    });
    next.push(match.winner);
  }
  log(`Round done — ${next.length} left`); // "Advance the bracket"
  bracket = next;
}

phase("Write up the winner");
const writeup = await agent(`Document the winning approach: ${bracket[0]}`);
log(writeup);
