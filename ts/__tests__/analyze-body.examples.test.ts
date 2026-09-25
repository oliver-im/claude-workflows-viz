import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeBody } from "../analyze-body.js";
import { extractMetaFromProgram, parseWorkflowSource } from "../extract-meta.js";
import type { Step, Topology } from "../topology.js";

/**
 * Corpus-wide acceptance bar for the completed analyzer: every example
 * produces a fully-typed tree — zero opaque steps, zero notes. These tests
 * pin recognizer completeness; any degradation over the corpus is a
 * regression, not an acceptable fallback.
 */

const examplesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");

/** Every level directory's `.js` files, as `level-N/name.js`. The corpus
 *  invariant below sweeps ALL levels, so a new `examples/level-N/` is held to the
 *  same zero-opaque / zero-note bar the moment it lands. */
const levelDirs = readdirSync(examplesRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^level-\d+$/.test(d.name))
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const corpus = levelDirs.flatMap((d) =>
  readdirSync(join(examplesRoot, d))
    .filter((f) => f.endsWith(".js"))
    .map((f) => `${d}/${f}`),
);

const analyzeRel = (rel: string): Topology => {
  const src = readFileSync(join(examplesRoot, rel), "utf8");
  const program = parseWorkflowSource(src);
  const meta = extractMetaFromProgram(program);
  return analyzeBody(
    program,
    src,
    meta.phases.map((p) => p.title),
  );
};

/** Every step in the tree, structures included, depth-first. */
const collectSteps = (steps: readonly Step[]): Step[] => {
  const out: Step[] = [];
  for (const s of steps) {
    out.push(s);
    switch (s.kind) {
      case "parallel":
        out.push(
          ...(s.form === "branches" ? s.branches.flatMap(collectSteps) : collectSteps(s.body)),
        );
        break;
      case "pipeline":
        out.push(...s.stages.flatMap(collectSteps));
        break;
      case "loop":
        out.push(...collectSteps(s.body));
        break;
      case "branch":
        out.push(...collectSteps(s.thenSteps), ...collectSteps(s.elseSteps));
        break;
      default:
        break;
    }
  }
  return out;
};

describe("analyzer corpus invariant", () => {
  const files = corpus;

  it("covers every level directory's example workflows", () => {
    // A tripwire against the corpus silently shrinking — bump it deliberately
    // when a sample is added or retired. Every level dir must contribute.
    expect(files).toHaveLength(13);
    for (const d of levelDirs) expect(files.some((f) => f.startsWith(`${d}/`)), d).toBe(true);
  });

  it("every example: orchestration recognized, ZERO opaques, ZERO notes, meta bands seeded", () => {
    for (const f of files) {
      const t = analyzeRel(f);
      expect(t.hasOrchestration, f).toBe(true);
      expect(t.notes, f).toEqual([]);
      expect(collectSteps(t.steps).filter((s) => s.kind === "opaque"), f).toEqual([]);
      const src = readFileSync(join(examplesRoot, f), "utf8");
      const titles = extractMetaFromProgram(parseWorkflowSource(src)).phases.map((p) => p.title);
      expect(t.bands.slice(0, titles.length), f).toEqual(
        titles.map((title) => ({ title, inMeta: true })),
      );
    }
  });

  it("is deterministic across runs", () => {
    for (const f of files) {
      expect(JSON.stringify(analyzeRel(f))).toBe(JSON.stringify(analyzeRel(f)));
    }
  });
});
