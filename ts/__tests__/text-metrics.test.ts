import { describe, expect, it } from "vitest";
import { fitText, textWidth, wrapText } from "../text-metrics.js";

describe("textWidth", () => {
  it("measures Helvetica's real advances, not a per-character guess", () => {
    // Helvetica: a = 556, i = 222, M = 833 per 1000 em.
    expect(textWidth("a", { size: 1000 })).toBeCloseTo(556.2, 0);
    expect(textWidth("i", { size: 1000 })).toBeCloseTo(222.2, 0);
    expect(textWidth("M", { size: 1000 })).toBeCloseTo(833, 0);
    expect(textWidth("iiii", { size: 10 })).toBeLessThan(textWidth("MMMM", { size: 10 }));
  });

  it("measures mono at one advance per glyph, and wide glyphs at two", () => {
    const one = textWidth("x", { size: 10, mono: true });
    expect(textWidth("review:x", { size: 10, mono: true })).toBeCloseTo(8 * one, 5);
    expect(textWidth("日", { size: 10, mono: true })).toBeCloseTo(2 * one, 5);
  });

  it("gives combining marks no width and accented letters their base letter's", () => {
    expect(textWidth("é", { size: 10 })).toBeCloseTo(textWidth("e", { size: 10 }), 5);
    expect(textWidth("é", { size: 10 })).toBeCloseTo(textWidth("e", { size: 10 }), 5);
  });
});

describe("wrapText", () => {
  it("wraps at spaces to fill the width it is given", () => {
    const lines = wrapText("one two three four five six", 60, { size: 10 });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(textWidth(line, { size: 10 })).toBeLessThanOrEqual(60);
    expect(lines.join(" ")).toBe("one two three four five six");
  });

  it("breaks a code token after a soft-break character before splitting mid-word", () => {
    const f = { size: 11, mono: true };
    expect(wrapText("review:correctness", textWidth("correctness", f) + 1, f)).toEqual(["review:", "correctness"]);
  });

  it("hard-breaks an unbreakable token rather than dropping any of it", () => {
    const lines = wrapText("a".repeat(30), 50, { size: 10 });
    expect(lines.join("")).toBe("a".repeat(30));
    expect(lines.length).toBeGreaterThan(1);
  });

  it("clips only at maxLines, ending the last line in an ellipsis", () => {
    const lines = wrapText("one two three four five six seven", 40, { size: 10 }, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
  });
});

describe("fitText", () => {
  it("returns text that fits untouched, and cuts the rest to fit with an ellipsis", () => {
    expect(fitText("short", 100, { size: 10 })).toBe("short");
    const cut = fitText("a much longer string than fits", 60, { size: 10 });
    expect(cut.endsWith("…")).toBe(true);
    expect(textWidth(cut, { size: 10 })).toBeLessThanOrEqual(60);
  });
});
