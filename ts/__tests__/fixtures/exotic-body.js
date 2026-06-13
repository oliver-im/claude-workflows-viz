export const meta = {
  name: "Exotic body",
  description: "A meta-only file whose body has no recoverable orchestration",
  phases: [
    { title: "Only phase", detail: "the body below is opaque to the analyzer" },
  ],
};

// Deliberately weird-but-valid JS with ZERO orchestration calls: the analyzer
// must degrade honestly and the CLI must render the v1-equivalent page with
// exit 0 — never crash, never execute any of this.
const decoder = new TextDecoder();
function* gen() {
  yield* [Symbol.iterator, globalThis["eval"]];
}
outer: for (const x of gen()) {
  switch (typeof x) {
    case "function":
      continue outer;
    default: {
      const p = new Proxy({}, { get: () => decoder });
      void (p?.[`weird ${String(x)}`] ?? (async () => import("nope"))());
      break outer;
    }
  }
}
do {
  var hoisted = (hoisted ?? 0) + 1;
} while (hoisted < 2 && Math.random() < -1);
