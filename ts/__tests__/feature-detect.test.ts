import { describe, expect, it } from "vitest";
import { analyzeBody } from "../analyze-body.js";
import { type GrammarLevel, RECOGNIZER_LEVEL } from "../grammar.js";
import { parseWorkflowSource } from "../extract-meta.js";
import { detectGrammarUse, grammarWarning, requiredGrammarLevel } from "../feature-detect.js";

const parse = (src: string) => parseWorkflowSource(src);
const META = `export const meta = { name: "x", description: "y" };\n`;

/**
 * The min-computation core, exercised against a SYNTHETIC level table rather than
 * the real lexicon. The point is the computation, not today's vocabulary: a
 * synthetic table keeps these cases meaningful no matter which tokens the real
 * lexicon happens to carry at which level, so minting a level never rewrites them.
 * (The real lexicon's own level-2 tokens are exercised by `detectGrammarUse` below.)
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
  it("a level-1 body: requiredLevel 1, nothing unrecognized", () => {
    const d = detectGrammarUse(parse(`${META}await agent("do it", { model: "opus" });`));
    expect(d.requiredLevel).toBe(1);
    expect(d.recognizerLevel).toBe(RECOGNIZER_LEVEL);
    expect(d.unrecognized).toEqual([]);
  });

  // The real lexicon's level-2 token: `agent()`'s `effort` option. Unlike the
  // synthetic table above, this proves the wired vocabulary itself carries levels
  // through to a file's required minimum.
  it("a body using the level-2 `effort` option: requiredLevel 2", () => {
    const d = detectGrammarUse(parse(`${META}await agent("do it", { effort: "max" });`));
    expect(d.requiredLevel).toBe(2);
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
    expect(t.recognizerLevel).toBe(RECOGNIZER_LEVEL);
  });

  it("a no-orchestration body with an unknown awaited primitive: hasOrchestration false, but the degradation is noted (not silently dropped)", () => {
    const t = analyze(`${META}const w = await race([candidateA()]);`);
    expect(t.hasOrchestration).toBe(false);
    expect(t.notes.some((n) => /race/.test(n.message))).toBe(true);
  });
});
