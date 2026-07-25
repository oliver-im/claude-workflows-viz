import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Anatomy-hero drift guard.
 *
 * The README hero (`examples/level-2/review-pr.annotated.png`) is built by
 * `scripts/annotate-anatomy.mjs`, which overlays lettered pins on the committed
 * `review-pr` render. Its pin coordinates are LITERALS tuned by eye — nothing
 * computes them from the base — so if the base render moves, the pins quietly
 * stop pointing at the things they name, and the hero on the front page of the
 * repo becomes wrong while still looking plausible.
 *
 * Re-running the generator would NOT fix that: it would redraw the same literals
 * over different content. The only real fix is a human re-tuning them. So the
 * script pins its base by hash (`TUNED_AGAINST_BASE_SHA256`) and this test holds
 * that hash to the committed base — the CI-visible half of the same guard, which
 * needs neither `resvg` nor a render pass, just two file reads.
 *
 * When this fails, the render changed and the hero needs attention; the fix is
 * the `--retune` loop documented in the script, not a hash bump.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = join(root, "scripts", "annotate-anatomy.mjs");
const basePath = join(root, "examples", "level-2", "review-pr.svg");

describe("anatomy hero is tuned against the current base render", () => {
  it("annotate-anatomy.mjs pins the base SVG it was tuned against", () => {
    const script = readFileSync(scriptPath, "utf8");
    const declared = script.match(/TUNED_AGAINST_BASE_SHA256\s*=\s*"([0-9a-f]{64})"/);
    expect(
      declared,
      "scripts/annotate-anatomy.mjs must declare TUNED_AGAINST_BASE_SHA256 as a 64-hex literal",
    ).not.toBeNull();

    const actual = createHash("sha256").update(readFileSync(basePath)).digest("hex");
    expect(
      declared![1],
      "examples/level-2/review-pr.svg has changed since the anatomy pins were tuned, so the " +
        "README hero's pins may no longer point at what they name. Run " +
        "`node scripts/annotate-anatomy.mjs --retune`, verify every pin in the output, then " +
        "paste the printed hash into TUNED_AGAINST_BASE_SHA256.",
    ).toBe(actual);
  });
});
