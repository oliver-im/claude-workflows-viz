import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { RECOGNIZER_LEVEL } from "../grammar.js";
import { detectGrammarUse } from "../feature-detect.js";
import { parseWorkflowSource } from "../extract-meta.js";

/**
 * Examples grammar lock — every shipped workflow `.js` file declares, IN THE FILE,
 * the grammar level it is written against (a `* Grammar level: 1` header line),
 * and this suite enforces that the declaration is present and honest:
 *
 *   1. the file MUST carry a declaration — a missing stamp fails loudly, so the
 *      vocabulary cannot grow a sample that forgets to say what grammar it needs;
 *   2. it must not USE anything newer than it DECLARES (`requiredLevel ≤ declared`)
 *      — the declared level is an independent anchor the derived `requiredLevel`
 *      is checked against, not a value read back off the recognizer;
 *   3. the recognizer must be able to render what it declares (`declared ≤ recognizer`);
 *   4. it must not `await` an unrecognized callee (the soft "primitive newer than
 *      the grammar level" signal from `feature-detect.ts`);
 *   5. a level-versioned directory and the in-file stamp must agree — a sample in
 *      `examples/level-N/` must declare `Grammar level: N`, so the corpus versions
 *      one way, not two.
 *
 * This is an INTRA-REPO consistency lock, not an upstream-drift detector — drift
 * (Claude Code changing the grammar out from under us) is `npm run check-grammar`'s
 * job. The stamp pins each example to a LEVEL, deliberately not a CC version: two
 * CC releases that ship a byte-identical grammar share one level (see
 * `docs/GRAMMAR-CHANGELOG.md`), so a version stamp would churn for no reason. When
 * a new level is minted and an example adopts a newer construct, its
 * `requiredLevel` rises and assertion (2) forces a conscious stamp bump here.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every directory that ships hand-authored workflow `.js` files in the npm package
// (`package.json` "files"). Each must stay locked to a declared grammar level.
const GRAMMAR_DIRS = ["examples/level-1", "skills/workflow-readability/example"];

/** The `* Grammar level: 1` header marker — the in-file level declaration. */
const DECLARED_LEVEL = /\*\s*Grammar level:\s*(\d+)\b/;

const grammarFiles = GRAMMAR_DIRS.flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, f)),
);

describe("shipped examples declare and stay within their grammar level", () => {
  it("discovers the shipped workflow corpus", () => {
    expect(grammarFiles.length).toBeGreaterThan(0);
  });

  for (const rel of grammarFiles) {
    it(rel, () => {
      const src = readFileSync(join(root, rel), "utf8");

      // 1. a declaration must exist.
      const match = src.match(DECLARED_LEVEL);
      expect(
        match,
        `${rel} must declare its grammar level in the header (e.g. \`* Grammar level: 1\`)`,
      ).not.toBeNull();
      const declared = Number(match![1]);

      const use = detectGrammarUse(parseWorkflowSource(src));

      // 2. doesn't use anything newer than it claims.
      expect(
        use.requiredLevel,
        `${rel} uses grammar level ${use.requiredLevel} but declares ${declared} — bump the stamp or revert the construct`,
      ).toBeLessThanOrEqual(declared);

      // 3. the recognizer can render what it claims.
      expect(
        declared,
        `${rel} declares ${declared} but the recognizer supports up to ${RECOGNIZER_LEVEL}`,
      ).toBeLessThanOrEqual(RECOGNIZER_LEVEL);

      // 4. no awaited-but-unrecognized callee (possible newer primitive).
      expect(use.unrecognized, rel).toEqual([]);

      // 5. a level-versioned directory (examples/level-N/) and the in-file stamp
      //    must agree — the directory IS the canonical level, so a misfiled or
      //    mis-stamped sample fails rather than silently versioning two ways.
      const dirLevel = rel.match(/(?:^|\/)level-(\d+)\//);
      if (dirLevel) {
        expect(
          declared,
          `${rel} sits under level-${dirLevel[1]}/ but its header declares ${declared}`,
        ).toBe(Number(dirLevel[1]));
      }
    });
  }
});
