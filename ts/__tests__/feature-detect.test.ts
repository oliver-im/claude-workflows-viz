import { describe, expect, it } from "vitest";
import { analyzeBody } from "../analyze-body.js";
import type { DialectEpoch } from "../dialect.js";
import { parseWorkflowSource } from "../extract-meta.js";
import { detectDialectUse, dialectWarning, requiredEpoch } from "../feature-detect.js";

const parse = (src: string) => parseWorkflowSource(src);
const META = `export const meta = { name: "x", description: "y" };\n`;

/**
 * The min-computation core. The real lexicon is all-D1, so a synthetic epoch
 * table is the honest way to exercise the D2+ path (the acceptance's "assert via
 * a unit test on the min-computation").
 */
describe("requiredEpoch", () => {
  const epochs = new Map<string, DialectEpoch>([
    ["agent", "D1"],
    ["race", "D2"],
  ]);

  it("floors at D1 when no used token is newer (or none are used)", () => {
    expect(requiredEpoch(["agent"], epochs)).toBe("D1");
    expect(requiredEpoch([], epochs)).toBe("D1");
  });

  it("rises to the max epoch among the used tokens", () => {
    expect(requiredEpoch(["agent", "race"], epochs)).toBe("D2");
    expect(requiredEpoch(["race"], epochs)).toBe("D2");
  });

  it("ignores tokens absent from the epoch table", () => {
    expect(requiredEpoch(["somethingElse"], epochs)).toBe("D1");
  });
});

describe("detectDialectUse", () => {
  it("a D1 body: requiredDialect D1, target D1, nothing unrecognized", () => {
    const d = detectDialectUse(parse(`${META}await agent("do it", { model: "opus" });`));
    expect(d.requiredDialect).toBe("D1");
    expect(d.recognizerTarget).toBe("D1");
    expect(d.unrecognized).toEqual([]);
  });

  it("flags an awaited unrecognized callee as possibly newer (soft signal)", () => {
    const d = detectDialectUse(parse(`${META}const w = await race([candidateA(), candidateB()]);`));
    expect(d.unrecognized).toEqual(["race"]);
    // An unknown token does not raise the *known*-token minimum.
    expect(d.requiredDialect).toBe("D1");
  });

  it("does not flag awaited recognized orchestration, nor non-awaited unknowns", () => {
    const d = detectDialectUse(
      parse(`${META}await parallel([() => agent("a")]);\nconst x = helper();`),
    );
    expect(d.unrecognized).toEqual([]);
  });

  it("de-duplicates and sorts the unrecognized callees", () => {
    const d = detectDialectUse(parse(`${META}await zeta([]);\nawait alpha([]);\nawait zeta([]);`));
    expect(d.unrecognized).toEqual(["alpha", "zeta"]);
  });
});

describe("dialectWarning", () => {
  it("returns null when nothing exceeds the target (the D1 happy path)", () => {
    expect(
      dialectWarning({ requiredDialect: "D1", recognizerTarget: "D1", unrecognized: [] }),
    ).toBeNull();
  });

  it("warns when the required epoch exceeds the target", () => {
    const msg = dialectWarning({ requiredDialect: "D2", recognizerTarget: "D1", unrecognized: [] });
    expect(msg).toMatch(/dialect D2/);
    expect(msg).toMatch(/recognizer targets D1/);
  });

  it("warns (softer) on an unrecognized awaited callee even at D1", () => {
    const msg = dialectWarning({
      requiredDialect: "D1",
      recognizerTarget: "D1",
      unrecognized: ["race"],
    });
    expect(msg).toMatch(/`race`/);
    expect(msg).toMatch(/not recognized as orchestration/);
  });
});

describe("analyzeBody dialect attachment", () => {
  const analyze = (src: string) => analyzeBody(parse(src), src, []);

  it("attaches requiredDialect + recognizerTarget to the Topology", () => {
    const t = analyze(`${META}await agent("go");`);
    expect(t.requiredDialect).toBe("D1");
    expect(t.recognizerTarget).toBe("D1");
  });

  it("a no-orchestration body with an unknown awaited primitive: hasOrchestration false, but the degradation is noted (not silently dropped)", () => {
    const t = analyze(`${META}const w = await race([candidateA()]);`);
    expect(t.hasOrchestration).toBe(false);
    expect(t.notes.some((n) => /race/.test(n.message))).toBe(true);
  });
});
