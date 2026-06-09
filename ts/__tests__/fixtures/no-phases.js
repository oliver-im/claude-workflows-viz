export const meta = {
  name: "Quick summary",
  description: "Summarize a single document in one pass ...",
};

const summary = await agent("summarize the doc");
log(summary);
