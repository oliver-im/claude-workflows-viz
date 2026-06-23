import type * as acorn from "acorn";
import {
  AGENT_OPTION_KEYS,
  type DialectEpoch,
  epochRank,
  ORCHESTRATION_CALLEES,
  RECOGNIZER_TARGET,
  wiredEpochs,
} from "./dialect.js";

/**
 * Caniuse-style per-file feature detection over the dialect lexicon. Reads the
 * acorn AST (never executes it) and answers two honest questions:
 *
 *   - **requiredDialect** — the minimum dialect epoch needed to understand the
 *     file, computed as `max sinceEpoch` over the **wired** lexicon tokens it
 *     actually uses (orchestration calls + recognized `agent()` options),
 *     floored at `D1`. Descriptive/native-JS constructs (loops, `.map`, …) are
 *     always-present and never raise it — only the wired vocabulary is versioned.
 *   - **unrecognized** — a softer, distinct signal: bare callees that are
 *     *awaited like orchestration* (`await foo(…)`) yet are not recognized
 *     orchestration calls. The dialect's primitives are overwhelmingly awaited,
 *     so an awaited unknown callee is the strongest cheap hint of a primitive
 *     newer than the recognizer targets. Surfaced rather than silently ignored.
 *
 * Both feed one consumer each off a single computation: `analyzeBody` attaches
 * `requiredDialect`/`recognizerTarget` to the `Topology` (so the JSON emit
 * carries them) and notes each unrecognized callee; the CLI consults
 * `dialectWarning` for a one-line stderr warning, independent of whether any
 * orchestration was recovered.
 */
export interface DialectUse {
  requiredDialect: DialectEpoch;
  recognizerTarget: DialectEpoch;
  /** Sorted, de-duplicated awaited-but-unrecognized callee names. */
  unrecognized: string[];
}

// Recognized callees that may legitimately appear awaited without being a new
// orchestration primitive — excluded from the "possibly newer" signal. Kept
// tiny and explicit; everything else awaited-and-unknown is worth flagging.
const BENIGN_AWAITED = new Set(["phase", "log"]);

/**
 * The max epoch over `used` tokens looked up through `epochs`, floored at
 * `floor`. A pure function of its inputs — the unit-testable core of the
 * required-minimum computation (feed a synthetic `epochs` to exercise `D2`+).
 */
export function requiredEpoch(
  used: Iterable<string>,
  epochs: ReadonlyMap<string, DialectEpoch> = wiredEpochs(),
  floor: DialectEpoch = "D1",
): DialectEpoch {
  let best = floor;
  let bestRank = epochRank(floor);
  for (const token of used) {
    const epoch = epochs.get(token);
    if (epoch !== undefined) {
      const rank = epochRank(epoch);
      if (rank > bestRank) {
        best = epoch;
        bestRank = rank;
      }
    }
  }
  return best;
}

/** Detect the dialect epoch a parsed workflow requires, and any newer-looking calls. */
export function detectDialectUse(program: acorn.Node): DialectUse {
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
    requiredDialect: requiredEpoch(used),
    recognizerTarget: RECOGNIZER_TARGET,
    unrecognized: [...unrecognized].sort(),
  };
}

/**
 * The one-line warning for a file whose dialect needs exceed the recognizer's
 * target, or `null` when nothing does. The hard signal (a known token newer
 * than the target) wins over the soft one (an awaited unknown callee).
 */
export function dialectWarning(use: DialectUse): string | null {
  if (epochRank(use.requiredDialect) > epochRank(use.recognizerTarget)) {
    return `file uses constructs from dialect ${use.requiredDialect}; recognizer targets ${use.recognizerTarget} — newer constructs may render opaque`;
  }
  if (use.unrecognized.length > 0) {
    const calls = use.unrecognized.map((n) => `\`${n}\``).join(", ");
    return `awaited ${calls} not recognized as orchestration — possibly newer than dialect ${use.recognizerTarget}`;
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
