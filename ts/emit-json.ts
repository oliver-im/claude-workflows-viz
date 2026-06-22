import type * as acorn from "acorn";
import { analyzeBody } from "./analyze-body.js";
import type { Meta } from "./model.js";

/**
 * The `--format json` emit: a faithful, machine-readable dump of everything the
 * tool statically knows about a workflow — the validated `meta` and the body
 * analyzer's tree IR (`Topology`), notes and source spans included. It is the
 * read contract for tooling that wants the structure without scraping SVG —
 * notably the `workflow-readability` skill, which reads this to find code-shaped
 * labels and thin phase details, then rewrites the workflow's own authored
 * strings into prose.
 *
 * Honesty is preserved end to end: this emits only facts (labels verbatim,
 * counts literal-only, conditions as source slices, degradations as notes). It
 * never paraphrases or guesses — turning the structure into human prose is the
 * skill's job (an authoring step a human reviews), never the binary's.
 *
 * Deterministic: a pure function of (meta, analysis), pretty-printed in a stable
 * key order, so the same file always yields byte-identical JSON.
 */
export const ANALYSIS_SCHEMA = "claude-workflows-viz/analysis@1";

export function emitAnalysisJson(
  meta: Meta,
  program: acorn.Node,
  src: string,
  sourcePath: string,
): string {
  const topology = analyzeBody(
    program,
    src,
    meta.phases.map((p) => p.title),
  );
  return `${JSON.stringify(
    { schema: ANALYSIS_SCHEMA, source: sourcePath, meta, topology },
    null,
    2,
  )}\n`;
}
