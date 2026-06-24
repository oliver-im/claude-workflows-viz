import { describe, expect, it } from "vitest";
import { analyzeBody } from "../analyze-body.js";
import type { GrammarLevel } from "../grammar.js";
import { parseWorkflowSource } from "../extract-meta.js";
import { detectGrammarUse, grammarWarning, requiredGrammarLevel } from "../feature-detect.js";

const parse = (src: string) => parseWorkflowSource(src);
const META = `export const meta = { name: "x", description: "y" };\n`;

/**
 * The min-computation core. The real lexicon is all level 1, so a synthetic level
 * table is the honest way to exercise the level-2+ path (the acceptance's "assert
 * via a unit test on the min-computation").
 */
describe("requiredGrammarLevel", () => {
  const levels = new Map<string, GrammarLevel>([
    ["agent", 1],
    ["race", 2],
  ]);

  it("floors at level 1 when no used token is newer (or none are used)", () => {
    expect(requiredGrammarLevel(["agent"], levels)).toBe(1);
    expect(requiredGrammarLevel([], levels)).toBe(1);
  });

  it("rises to the max level among the used tokens", () => {
    expect(requiredGrammarLevel(["agent", "race"], levels)).toBe(2);
    expect(requiredGrammarLevel(["race"], levels)).toBe(2);
  });

  it("ignores tokens absent from the level table", () => {
    expect(requiredGrammarLevel(["somethingElse"], levels)).toBe(1);
  });
});

describe("detectGrammarUse", () => {
  it("a level-1 body: requiredLevel 1, recognizerLevel 1, nothing unrecognized", () => {
    const d = detectGrammarUse(parse(`${META}await agent("do it", { model: "opus" });`));
    expect(d.requiredLevel).toBe(1);
    expect(d.recognizerLevel).toBe(1);
    expect(d.unrecognized).toEqual([]);
  });

  it("flags an awaited unrecognized callee as possibly newer (soft signal)", () => {
    const d = detectGrammarUse(parse(`${META}const w = await race([candidateA(), candidateB()]);`));
    expect(d.unrecognized).toEqual(["race"]);
    // An unknown token does not raise the *known*-token minimum.
    expect(d.requiredLevel).toBe(1);
  });

  it("does not flag awaited recognized orchestration, nor non-awaited unknowns", () => {
    const d = detectGrammarUse(
      parse(`${META}await parallel([() => agent("a")]);\nconst x = helper();`),
    );
    expect(d.unrecognized).toEqual([]);
  });

  it("de-duplicates and sorts the unrecognized callees", () => {
    const d = detectGrammarUse(parse(`${META}await zeta([]);\nawait alpha([]);\nawait zeta([]);`));
    expect(d.unrecognized).toEqual(["alpha", "zeta"]);
  });
});

describe("grammarWarning", () => {
  it("returns null when nothing exceeds the level (the level-1 happy path)", () => {
    expect(
      grammarWarning({ requiredLevel: 1, recognizerLevel: 1, unrecognized: [] }),
    ).toBeNull();
  });

  it("warns when the required level exceeds the recognizer's", () => {
    const msg = grammarWarning({ requiredLevel: 2, recognizerLevel: 1, unrecognized: [] });
    expect(msg).toMatch(/requires grammar level 2/);
    expect(msg).toMatch(/supports up to level 1/);
  });

  it("warns (softer) on an unrecognized awaited callee even at level 1", () => {
    const msg = grammarWarning({
      requiredLevel: 1,
      recognizerLevel: 1,
      unrecognized: ["race"],
    });
    expect(msg).toMatch(/`race`/);
    expect(msg).toMatch(/not recognized as orchestration/);
  });
});

describe("analyzeBody grammar attachment", () => {
  const analyze = (src: string) => analyzeBody(parse(src), src, []);

  it("attaches requiredLevel + recognizerLevel to the Topology", () => {
    const t = analyze(`${META}await agent("go");`);
    expect(t.requiredLevel).toBe(1);
    expect(t.recognizerLevel).toBe(1);
  });

  it("a no-orchestration body with an unknown awaited primitive: hasOrchestration false, but the degradation is noted (not silently dropped)", () => {
    const t = analyze(`${META}const w = await race([candidateA()]);`);
    expect(t.hasOrchestration).toBe(false);
    expect(t.notes.some((n) => /race/.test(n.message))).toBe(true);
  });
});
