import type * as acorn from "acorn";
import {
  AGENT_OPTION_KEYS,
  type GrammarLevel,
  ORCHESTRATION_CALLEES,
  RECOGNIZER_LEVEL,
  wiredLevels,
} from "./grammar.js";

/**
 * Caniuse-style per-file feature detection over the grammar lexicon. Reads the
 * acorn AST (never executes it) and answers two honest questions:
 *
 *   - **requiredLevel** — the minimum grammar level needed to understand the
 *     file, computed as `max sinceLevel` over the **wired** lexicon tokens it
 *     actually uses (orchestration calls + recognized `agent()` options),
 *     floored at level `1`. Descriptive/native-JS constructs (loops, `.map`, …)
 *     are always-present and never raise it — only the wired vocabulary is
 *     versioned.
 *   - **unrecognized** — a softer, distinct signal: bare callees that are
 *     *awaited like orchestration* (`await foo(…)`) yet are not recognized
 *     orchestration calls. The grammar's primitives are overwhelmingly awaited,
 *     so an awaited unknown callee is the strongest cheap hint of a primitive
 *     newer than the recognizer targets. Surfaced rather than silently ignored.
 *
 * Both feed one consumer each off a single computation: `analyzeBody` attaches
 * `requiredLevel`/`recognizerLevel` to the `Topology` (so the JSON emit carries
 * them) and notes each unrecognized callee; the CLI consults `grammarWarning`
 * for a one-line stderr warning, independent of whether any orchestration was
 * recovered.
 */
export interface GrammarUse {
  requiredLevel: GrammarLevel;
  recognizerLevel: GrammarLevel;
  /** Sorted, de-duplicated awaited-but-unrecognized callee names. */
  unrecognized: string[];
}

// Recognized callees that may legitimately appear awaited without being a new
// orchestration primitive — excluded from the "possibly newer" signal. Kept
// tiny and explicit; everything else awaited-and-unknown is worth flagging.
const BENIGN_AWAITED = new Set(["phase", "log"]);

/**
 * The max grammar level over `used` tokens looked up through `levels`, floored at
 * `floor`. A pure function of its inputs — the unit-testable core of the
 * required-minimum computation (feed a synthetic `levels` to exercise level 2+).
 */
export function requiredGrammarLevel(
  used: Iterable<string>,
  levels: ReadonlyMap<string, GrammarLevel> = wiredLevels(),
  floor: GrammarLevel = 1,
): GrammarLevel {
  let best = floor;
  for (const token of used) {
    const level = levels.get(token);
    if (level !== undefined && level > best) best = level;
  }
  return best;
}

/** Detect the grammar level a parsed workflow requires, and any newer-looking calls. */
export function detectGrammarUse(program: acorn.Node): GrammarUse {
  const used = new Set<string>();
  const unrecognized = new Set<string>();
  walk(program, (node) => {
    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      const name = node.callee.name;
      if (ORCHESTRATION_CALLEES.has(name)) {
        used.add(name);
        if (name === "agent") collectAgentOptionTokens(node, used);
      }
    } else if (node.type === "AwaitExpression") {
      const arg = node.argument;
      if (arg?.type === "CallExpression" && arg.callee?.type === "Identifier") {
        const name = arg.callee.name;
        if (!ORCHESTRATION_CALLEES.has(name) && !BENIGN_AWAITED.has(name)) {
          unrecognized.add(name);
        }
      }
    }
  });
  return {
    requiredLevel: requiredGrammarLevel(used),
    recognizerLevel: RECOGNIZER_LEVEL,
    unrecognized: [...unrecognized].sort(),
  };
}

/**
 * The one-line warning for a file whose grammar needs exceed the recognizer's
 * level, or `null` when nothing does. The hard signal (a known token newer than
 * the level) wins over the soft one (an awaited unknown callee).
 */
export function grammarWarning(use: GrammarUse): string | null {
  if (use.requiredLevel > use.recognizerLevel) {
    return `file requires grammar level ${use.requiredLevel}; recognizer supports up to level ${use.recognizerLevel} — newer constructs may render opaque`;
  }
  if (use.unrecognized.length > 0) {
    const calls = use.unrecognized.map((n) => `\`${n}\``).join(", ");
    return `awaited ${calls} not recognized as orchestration — possibly newer than grammar level ${use.recognizerLevel}`;
  }
  return null;
}

/** Add every recognized `agent()` option key present on the call to `used`. */
function collectAgentOptionTokens(call: any, used: Set<string>): void {
  const opts = call.arguments?.[1];
  if (opts?.type !== "ObjectExpression") return;
  for (const prop of opts.properties ?? []) {
    if (prop.type !== "Property" || prop.computed) continue;
    const key =
      prop.key?.type === "Identifier"
        ? prop.key.name
        : prop.key?.type === "Literal"
          ? String(prop.key.value)
          : undefined;
    if (key !== undefined && AGENT_OPTION_KEYS.has(key)) used.add(key);
  }
}

/** Visit every AST node once (same descent rules as the analyzer's scanners). */
function walk(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const el of node) walk(el, visit);
    return;
  }
  if (typeof node.type !== "string") return; // RegExp values etc. — not AST nodes
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    walk(node[key], visit);
  }
}
