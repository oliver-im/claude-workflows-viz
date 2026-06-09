export const meta = {
  name: "Risky body",
  description: "The body throws at runtime if ever executed",
};

// If this module were executed, the next lines throw: `agent` is undefined, and
// even if it resolved, `.x.y` walks a missing path. Extraction must never run
// the body — it should read `meta` above and stop.
const result = await agent("do work");
throw new Error("the body was executed: " + result.x.y);
