export const meta = {
  name: "Uses an unknown primitive",
  description: "The body orchestrates through `race`, a primitive the recognizer does not know.",
  phases: [{ title: "Race the candidates" }],
};

phase("Race the candidates");
// `race` is not one of the recognized orchestration calls (agent / workflow /
// parallel / pipeline) — a stand-in for a primitive newer than the recognizer's
// dialect target. No orchestration is recovered (the topology view falls back to
// the phase cards), but feature-detection still flags the awaited unknown callee
// rather than silently ignoring it. Never executed — read off the AST as data.
const winner = await race([candidateA(), candidateB()]);
