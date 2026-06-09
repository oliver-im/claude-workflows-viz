import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MetaExtractionError, extractMetaFromSource } from "../extract-meta.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string): string => readFileSync(join(fixtures, name), "utf8");

describe("extractMetaFromSource", () => {
  it("extracts name, description, whenToUse, and phases with models", () => {
    const meta = extractMetaFromSource(read("full.js"));
    expect(meta.name).toBe("Find flaky tests");
    expect(meta.whenToUse).toBe("When CI is intermittently red");
    expect(meta.phases.map((p) => p.title)).toEqual(["Scan", "Triage", "Fix"]);
    expect(meta.phases[2]?.model).toBe("opus");
  });

  it("defaults phases to [] when omitted", () => {
    const meta = extractMetaFromSource(read("no-phases.js"));
    expect(meta.phases).toEqual([]);
  });

  it("never executes the module body", () => {
    // throwing-body.js's top-level `await agent(...)` + `throw` would blow up
    // if the module were run. Extraction reads `meta` and stops.
    const meta = extractMetaFromSource(read("throwing-body.js"));
    expect(meta.name).toBe("Risky body");
  });

  it("rejects getters in meta WITHOUT executing them", () => {
    const src =
      `export const meta = { name: "x", description: "y", get phases() { throw new Error("EXECUTED"); } };`;
    expect(() => extractMetaFromSource(src)).toThrow(MetaExtractionError);
    // The getter body must never run — the failure is a clean rejection, not
    // the getter's own thrown error.
    expect(() => extractMetaFromSource(src)).not.toThrow(/EXECUTED/);
  });

  it("does not let a `__proto__` key smuggle required fields via the prototype", () => {
    // A normal `{}` treats `__proto__:` as a prototype setter, so zod would see
    // inherited name/description and wrongly validate this malformed meta. The
    // literal is built null-proto, so `__proto__` is an inert own key (stripped)
    // and validation correctly fails on the genuinely-missing required fields.
    const src = `export const meta = { __proto__: { name: "x", description: "y" } };`;
    expect(() => extractMetaFromSource(src)).toThrow(MetaExtractionError);
    expect(() => extractMetaFromSource(src)).toThrow(/validation/i);
  });

  it("errors clearly when meta is missing", () => {
    expect(() => extractMetaFromSource(read("missing-meta.js"))).toThrow(
      /no .*meta/i,
    );
  });

  it("rejects a non-literal meta (spread of a variable) without executing it", () => {
    expect(() => extractMetaFromSource(read("non-literal-meta.js"))).toThrow(
      MetaExtractionError,
    );
  });

  it("errors when a required field is missing", () => {
    expect(() =>
      extractMetaFromSource(`export const meta = { name: "x" };`),
    ).toThrow(/validation/i);
  });
});
