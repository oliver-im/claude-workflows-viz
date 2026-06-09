export const meta = {
  name: "Find flaky tests",
  description: "Find flaky tests and propose fixes",
  whenToUse: "When CI is intermittently red",
  phases: [
    { title: "Scan", detail: "grep CI logs for retry markers", model: "haiku" },
    { title: "Triage", detail: "cluster failures by root cause", model: "sonnet" },
    { title: "Fix", detail: "one agent per flaky test", model: "opus" },
  ],
};

phase("Scan");
const flaky = await agent("grep CI logs for retry markers");
const fixes = await parallel(flaky.map((f) => () => agent(`fix ${f}`)));
log(`${fixes.length} fixes`);
