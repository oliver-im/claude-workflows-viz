import { describe, expect, it } from "vitest";
import { wrapToWidth } from "../svg-primitives.js";

// The text/card primitives stay covered through render-svg's snapshot and the
// committed example renders (byte-identity is the gate); only wrapToWidth's
// hard-wrap edge cases are pinned here.

describe("wrapToWidth", () => {
  // fitChars(width, size) = floor(width / (size * 0.58)); 58/(10*0.58) = 10.

  it("lets a broken token's tail share a line with the following word", () => {
    expect(wrapToWidth(`${"a".repeat(25)} bb`, 58, 10, 5)).toEqual([
      "aaaaaaaaaa",
      "aaaaaaaaaa",
      "aaaaa bb",
    ]);
  });

  it("still applies the maxLines backstop — the only residual clip", () => {
    const lines = wrapToWidth("a".repeat(25), 58, 10, 2); // max = 10, cap = 2
    expect(lines).toHaveLength(2);
    expect(lines[lines.length - 1].endsWith("…")).toBe(true);
  });
});
