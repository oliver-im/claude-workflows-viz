import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeBody } from "../analyze-body.js";
import {
  AGENT_OPTION_KEYS,
  type LexiconEntry,
  LEXICON,
  ORCHESTRATION_CALLEES,
  RECOGNIZER_LEVEL_CC,
} from "../grammar.js";
import { parseWorkflowSource } from "../extract-meta.js";
import type { AgentStep, Step, Topology } from "../topology.js";

/**
 * Lexicon ↔ recognizer consistency — the CC-independent half of the grammar
 * drift gate (its install-dependent half is `scripts/capture-grammar.mjs --check`,
 * `npm run check-grammar`). This suite needs no `claude` binary, so it runs in
 * ordinary `vitest` CI, and guards the seam Unit 03 opened: the lexicon
 * (`ts/grammar.ts`) is the single source of truth, but `analyze-body.ts` keys on
 * it in *two* ways — a derived gate set (`ORCHESTRATION_CALLEES` / `AGENT_OPTION_KEYS`)
 * and a hand-written dispatch `switch` per token. The gate can't drift (it's
 * derived); the dispatch switches can. So each wired token is checked twice: its
 * membership round-trips to the derived set, **and** — for every token whose
 * dispatch has an observable effect — the recognizer actually dispatches it.
 * Iterating the lexicon means a newly-added wired token with no probe below fails
 * loudly — you cannot extend the vocabulary without wiring both the recognizer and
 * this test. (The exceptions are the inert `schema` and `isolation` agent options:
 * each dispatch arm is a bare `break`, behaviorally indistinguishable from no arm at
 * all, so no probe can prove they are *dispatched*. Their real guarantee is gate
 * membership — the round-trip — and their probes only check that supplying them does
 * not disrupt recognition.)
 *
 * Descriptive kinds (`marker` / `width-idiom` / `host-construct`) are recognized
 * by AST node shape, not by a callee name, so they have no identifier set to
 * round-trip and are deliberately out of scope here (only their non-wired flag is
 * asserted, below).
 */

const analyze = (src: string): Topology => analyzeBody(parseWorkflowSource(src), src, []);
const tokensOfKind = (kind: LexiconEntry["kind"]): string[] =>
  LEXICON.filter((e) => e.kind === kind).map((e) => e.token);
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

describe("RECOGNIZER_LEVEL_CC is pinned to the latest baseline", () => {
  // `RECOGNIZER_LEVEL_CC` is the concrete CC version behind the current grammar
  // level — a maintenance anchor for `docs/GRAMMAR-CHANGELOG.md` (it is NOT shown
  // in the rendered footer). This pins it to the `ccVersion` of the latest
  // committed `spec/upstream/` snapshot, so a re-capture that lands a newer
  // baseline can't leave the changelog anchor stale. Numeric collation matches
  // `capture-grammar.mjs`'s latest-baseline rule (cc-2.1.9 < cc-2.1.100).
  it("equals the latest spec/upstream baseline's ccVersion", () => {
    const upstreamDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "spec", "upstream");
    const baselines = readdirSync(upstreamDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}-cc-/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    expect(baselines.length).toBeGreaterThan(0);
    const latest = baselines[baselines.length - 1];
    const manifest = JSON.parse(readFileSync(join(upstreamDir, latest, "manifest.json"), "utf8"));
    expect(RECOGNIZER_LEVEL_CC).toBe(manifest.ccVersion);
  });
});

describe("wired lexicon ↔ derived recognizer sets round-trip", () => {
  it("orchestration-call tokens are all wired and equal ORCHESTRATION_CALLEES", () => {
    const calls = LEXICON.filter((e) => e.kind === "orchestration-call");
    expect(calls.every((e) => e.wired)).toBe(true);
    expect(sorted(calls.map((e) => e.token))).toEqual(sorted(ORCHESTRATION_CALLEES));
  });

  it("agent-option tokens are all wired and equal AGENT_OPTION_KEYS", () => {
    const opts = LEXICON.filter((e) => e.kind === "agent-option");
    expect(opts.every((e) => e.wired)).toBe(true);
    expect(sorted(opts.map((e) => e.token))).toEqual(sorted(AGENT_OPTION_KEYS));
  });

  it("descriptive tokens carry no wired flag (no recognizer set to round-trip)", () => {
    const descriptive = LEXICON.filter((e) => e.kind !== "orchestration-call" && e.kind !== "agent-option");
    expect(descriptive.length).toBeGreaterThan(0);
    expect(descriptive.every((e) => !e.wired)).toBe(true);
  });
});

// Minimal valid use of each orchestration call → the Step kind the recognizer's
// dispatch (`analyze-body.ts` `walkGated`, the `switch (node.callee.name)`) must
// produce. Keyed by token so a NEW orchestration call with no entry fails this
// suite — forcing the dispatch case and this probe to land together.
const CALL_DISPATCH: Record<string, { src: string; kind: Step["kind"] }> = {
  agent: { src: `await agent("p");`, kind: "agent" },
  workflow: { src: `await workflow("deploy");`, kind: "workflow" },
  parallel: { src: `await parallel([() => agent("a")]);`, kind: "parallel" },
  pipeline: { src: `await pipeline([1], (x) => agent("s"));`, kind: "pipeline" },
};

describe("every orchestration-call token is dispatched to a recognized step", () => {
  for (const token of tokensOfKind("orchestration-call")) {
    const probe = CALL_DISPATCH[token];
    it(`${token}() → a recognized ${probe?.kind ?? "?"} step`, () => {
      expect(probe, `add a dispatch probe for new orchestration call \`${token}\``).toBeDefined();
      const t = analyze(probe.src);
      // A recognized step of the right kind (not the honest opaque blob a
      // gate-passes-but-dispatch-misses token would degrade to), and it counts
      // as orchestration (opaque-only analysis would leave this false).
      expect(t.steps.map((s) => s.kind)).toContain(probe.kind);
      expect(t.hasOrchestration).toBe(true);
    });
  }
});

// Each agent option, exercised on an agent() call, with the observable proof the
// recognizer's option switch (`analyze-body.ts`, `switch (key)`) actually read it.
// Keyed by token so a NEW option with no entry fails loudly. Four options set a
// field — deleting their switch case (while keeping the lexicon key) leaves the
// field unset and the probe fails, so these have real dispatch teeth. `schema` and
// `isolation` are the exceptions: their `case …: break` arms are inert, so the same
// observation (no note, agent untouched) also holds for an *unrecognized* key — their
// probes are "doesn't disrupt recognition" smoke checks, NOT dispatch proofs. Their
// actual coverage is gate membership, asserted by the round-trip suite above.
const OPTION_DISPATCH: Record<
  string,
  { opt: string; check: (a: AgentStep, t: Topology) => void }
> = {
  label: {
    opt: `label: "build"`,
    check: (a) => {
      expect(a.label).toBe("build");
      expect(a.labelExplicit).toBe(true);
    },
  },
  model: { opt: `model: "opus"`, check: (a) => expect(a.model).toBe("opus") },
  agentType: { opt: `agentType: "codex"`, check: (a) => expect(a.agentType).toBe("codex") },
  phase: { opt: `phase: "B"`, check: (a) => expect(a.phase).toBe("B") },
  schema: {
    opt: `schema: Sentinel`,
    check: (a, t) => {
      // Smoke check only (see the note above): supplying schema leaves the agent
      // clean — no degradation note, label still prompt-derived. This holds for
      // any inert key; schema's recognition is proven by the round-trip suite.
      expect(t.notes).toEqual([]);
      expect(a.label).toBe("p");
    },
  },
  isolation: {
    opt: `isolation: "worktree"`,
    check: (a, t) => {
      // Inert like schema (see the note above): recognized but no visual meaning,
      // so this only checks it doesn't disrupt the agent; round-trip proves it.
      expect(t.notes).toEqual([]);
      expect(a.label).toBe("p");
    },
  },
};

describe("every agent-option token is read by the recognizer's option switch", () => {
  for (const token of tokensOfKind("agent-option")) {
    const probe = OPTION_DISPATCH[token];
    it(`agent() reads { ${token} }`, () => {
      expect(probe, `add an option probe for new agent option \`${token}\``).toBeDefined();
      const t = analyze(`await agent("p", { ${probe.opt} });`);
      const a = t.steps[0] as AgentStep;
      expect(a.kind).toBe("agent");
      probe.check(a, t);
    });
  }
});
