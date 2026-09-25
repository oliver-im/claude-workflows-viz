import { describe, expect, it } from "vitest";
import { analyzeBody } from "../analyze-body.js";
import { RECOGNIZER_LEVEL } from "../grammar.js";
import { parseWorkflowSource } from "../extract-meta.js";
import { detectGrammarUse, grammarWarning } from "../feature-detect.js";

const parse = (src: string) => parseWorkflowSource(src);
const META = `export const meta = { name: "x", description: "y" };\n`;

describe("detectGrammarUse", () => {
  it("a body using the level-2 `effort` option: requiredLevel 2", () => {
    const d = detectGrammarUse(parse(`${META}await agent("do it", { effort: "max" });`));
    expect(d.requiredLevel).toBe(2);
    expect(d.unrecognized).toEqual([]);
  });

  it("flags an awaited unrecognized callee as possibly newer (soft signal)", () => {
    const d = detectGrammarUse(parse(`${META}const w = await race([candidateA(), candidateB()]);`));
    expect(d.unrecognized).toEqual(["race"]);
    // An unknown token does not raise the *known*-token minimum, which floors at 1.
    expect(d.requiredLevel).toBe(1);
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
    // A level-2 body, so the attached level can only come from detection — the
    // level-1 floor would pass for a hardcoded default.
    const t = analyze(`${META}await agent("go", { effort: "max" });`);
    expect(t.requiredLevel).toBe(2);
    expect(t.recognizerLevel).toBe(RECOGNIZER_LEVEL);
  });

  it("a no-orchestration body with an unknown awaited primitive: hasOrchestration false, but the degradation is noted (not silently dropped)", () => {
    const t = analyze(`${META}const w = await race([candidateA()]);`);
    expect(t.hasOrchestration).toBe(false);
    expect(t.notes.some((n) => /race/.test(n.message))).toBe(true);
  });
});
