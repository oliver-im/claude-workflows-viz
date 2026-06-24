/**
 * The workflow-grammar lexicon — the single enumerated source of truth for the
 * vocabulary `analyze-body.ts` recognizes. Each token is tagged with the grammar
 * level that introduced it (all level `1` at baseline; the level ledger and the
 * upstream snapshots it pins live in `docs/GRAMMAR-CHANGELOG.md` and
 * `spec/upstream/`). The prose semantics stay in `docs/workflow-js-structure.md`
 * §3 — this module is the *data*, that doc is the *meaning*.
 *
 * The `wired` flag draws the boundary the later units scope to:
 *
 *   - **wired** (`true`) — string-identifier tokens the recognizer keys on *by
 *     name*, so they round-trip to a runtime set the recognizer consumes:
 *     `orchestration-call` (the bare callees that count as orchestration) and
 *     `agent-option` (the keys the `agent()` options object is read for). These
 *     two sets are derived below and imported by `analyze-body.ts` — so the
 *     analyzer reads the lexicon directly rather than a hand-kept copy. (The
 *     lexicon-consistency test in `ts/__tests__/grammar.test.ts` asserts the
 *     round-trip against the recognizer's own dispatch.)
 *
 *   - **descriptive** (`false`) — recognized by **AST node shape, not by a callee
 *     name** (`marker` = `phase()`; `width-idiom` = `.map` / `Array.from`;
 *     `host-construct` = loops + `if`/ternary). There is no identifier-set to
 *     round-trip, so these are carried for documentation and the per-file
 *     feature-detection floor only — they do not drive recognition.
 */

/**
 * This project's tracking version of the externally-owned grammar — a plain
 * monotonic integer (1, 2, …), bumped only on a grammar-relevant upstream change.
 * Not an official Anthropic number (the grammar is unversioned upstream); we mint
 * it so the recognizer, docs, and feature-detection share one stable handle.
 */
export type GrammarLevel = number;

export type LexiconKind =
  | "orchestration-call" // wired: a bare callee whose presence means "orchestrates"
  | "agent-option" // wired: a key read off the agent() options object literal
  | "marker" // descriptive: the bare phase("…") band marker
  | "width-idiom" // descriptive: a fan-out/stage width expression shape
  | "host-construct"; // descriptive: a JS control construct recognized by node type

export interface LexiconEntry {
  /** The token as it appears in source (a callee/option name, or a construct gloss). */
  token: string;
  kind: LexiconKind;
  /** Keyed on by name → round-trips to a recognizer set (orchestration-call / agent-option). */
  wired: boolean;
  /** The grammar level that introduced the token. */
  sinceLevel: GrammarLevel;
  /** One-line gloss of what the recognizer does with it. */
  note: string;
}

export const LEXICON: readonly LexiconEntry[] = [
  // ── wired · orchestration calls (analyze-body's ORCHESTRATION_CALLEES gate) ──
  { token: "agent", kind: "orchestration-call", wired: true, sinceLevel: 1, note: "spawn one subagent — the atom of the graph" },
  { token: "workflow", kind: "orchestration-call", wired: true, sinceLevel: 1, note: "invoke a named sub-workflow" },
  { token: "parallel", kind: "orchestration-call", wired: true, sinceLevel: 1, note: "concurrent branches / fan-out with a join barrier" },
  { token: "pipeline", kind: "orchestration-call", wired: true, sinceLevel: 1, note: "per-item staged flow, no barrier between stages" },

  // ── wired · agent() options (the agentStep options switch) ──
  { token: "label", kind: "agent-option", wired: true, sinceLevel: 1, note: "node caption — string or template literal" },
  { token: "model", kind: "agent-option", wired: true, sinceLevel: 1, note: "colors the agent circle — string literal only" },
  { token: "agentType", kind: "agent-option", wired: true, sinceLevel: 1, note: "recorded — string literal only" },
  { token: "phase", kind: "agent-option", wired: true, sinceLevel: 1, note: "overrides the ambient phase for this node — string literal only" },
  { token: "schema", kind: "agent-option", wired: true, sinceLevel: 1, note: "recognized as an option, but carries no visual meaning" },
  { token: "isolation", kind: "agent-option", wired: true, sinceLevel: 1, note: "'worktree' runs the agent in a fresh worktree — recognized, but carries no visual meaning" },

  // ── descriptive · recognized by AST node shape, not by a callee name ──
  // (`phase` is listed twice on purpose: a bare statement is the band marker
  //  below; the agent() option above is a distinct, wired use of the same word.)
  { token: "phase", kind: "marker", wired: false, sinceLevel: 1, note: 'a bare phase("…") statement sets the ambient band' },
  { token: ".map", kind: "width-idiom", wired: false, sinceLevel: 1, note: "collection.map(…) fan-out — width is the collection's multiplicity" },
  { token: "Array.from", kind: "width-idiom", wired: false, sinceLevel: 1, note: "Array.from({ length: L }) — exact width when L is literal/known" },
  { token: "while", kind: "host-construct", wired: false, sinceLevel: 1, note: "while loop whose body orchestrates → LoopStep" },
  { token: "do-while", kind: "host-construct", wired: false, sinceLevel: 1, note: "do/while loop whose body orchestrates → LoopStep" },
  { token: "for", kind: "host-construct", wired: false, sinceLevel: 1, note: "for loop whose body orchestrates → LoopStep" },
  { token: "for-of", kind: "host-construct", wired: false, sinceLevel: 1, note: "for-of loop whose body orchestrates → LoopStep" },
  { token: "for-in", kind: "host-construct", wired: false, sinceLevel: 1, note: "for-in loop whose body orchestrates → LoopStep" },
  { token: "if", kind: "host-construct", wired: false, sinceLevel: 1, note: "if/else whose arm orchestrates → BranchStep" },
  { token: "ternary", kind: "host-construct", wired: false, sinceLevel: 1, note: "?: conditional whose arm orchestrates → BranchStep" },
];

/** The wired tokens of one kind, as the runtime set the recognizer keys on. */
function wiredSet(kind: LexiconKind): ReadonlySet<string> {
  return new Set(LEXICON.filter((e) => e.wired && e.kind === kind).map((e) => e.token));
}

/**
 * Wired: the bare callee names whose presence means a subtree "orchestrates".
 * `analyze-body.ts` imports this as its emit/skip gate, so this lexicon is the
 * sole definition of the recognized orchestration calls.
 */
export const ORCHESTRATION_CALLEES: ReadonlySet<string> = wiredSet("orchestration-call");

/**
 * Wired: the keys the `agent()` options object is recognized for. `analyze-body`
 * gates its option switch on this set; a key outside it draws nothing.
 */
export const AGENT_OPTION_KEYS: ReadonlySet<string> = wiredSet("agent-option");

/**
 * The grammar level the recognizer is currently reconciled to (the provenance
 * header in `docs/workflow-js-structure.md` and the ledger's latest entry). A
 * file that needs a higher level than this uses constructs newer than what the
 * recognizer understands — the caniuse-style comparison in `feature-detect.ts`.
 */
export const RECOGNIZER_LEVEL: GrammarLevel = 1;

/**
 * The Claude Code version the current `RECOGNIZER_LEVEL` is reconciled to — the
 * `ccVersion` of the latest `spec/upstream/` baseline. A maintenance anchor only
 * (the level, not this version, is the primary key: two CC releases shipping a
 * byte-identical grammar share one level). It is the concrete reference behind a
 * grammar level in `docs/GRAMMAR-CHANGELOG.md`; it does NOT appear in the rendered
 * provenance footer. Bump it alongside the level when reconciling;
 * `ts/__tests__/grammar.test.ts` pins it to the latest committed baseline so the
 * two can't silently diverge.
 */
export const RECOGNIZER_LEVEL_CC = "2.1.173";

/**
 * Map every **wired** token to the grammar level that introduced it — the lookup
 * feature-detection uses to turn "tokens this file uses" into a required-minimum
 * level. Descriptive tokens have no round-tripped identifier and are excluded.
 * Defaults to the real `LEXICON`; the lexicon is a parameter so the
 * min-computation can be unit-tested against a synthetic (e.g. level-`2`) table.
 */
export function wiredLevels(lexicon: readonly LexiconEntry[] = LEXICON): Map<string, GrammarLevel> {
  const m = new Map<string, GrammarLevel>();
  for (const e of lexicon) if (e.wired) m.set(e.token, e.sinceLevel);
  return m;
}
