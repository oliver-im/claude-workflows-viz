import { describe, expect, it } from "vitest";
import {
  arrowHead,
  polyline,
  roundedElbowPath,
  strokePath,
} from "../svg-primitives.js";

// Only the NEW path helpers are tested here — the moved text/card primitives
// stay covered through render-svg's snapshot (byte-identity is the gate).

describe("strokePath / polyline", () => {
  it("emits a non-filled stroked path with optional dasharray", () => {
    expect(strokePath("M 0 0 L 10 0", "#475569")).toBe(
      '<path d="M 0 0 L 10 0" fill="none" stroke="#475569" stroke-width="1"/>',
    );
    expect(strokePath("M 0 0", "#000", { width: 2, dasharray: "4 3" })).toContain(
      'stroke-width="2" stroke-dasharray="4 3"',
    );
  });

  it("polyline rounds coordinates and joins as x,y pairs", () => {
    expect(polyline([[0, 0.005], [10.123, 5]], "#000")).toBe(
      '<polyline points="0,0.01 10.12,5" fill="none" stroke="#000" stroke-width="1"/>',
    );
  });
});

describe("roundedElbowPath", () => {
  it("renders an L-bend as line, quarter arc, line", () => {
    // Right then down: a clockwise turn in screen coords → sweep flag 1.
    const el = roundedElbowPath([[0, 0], [20, 0], [20, 20]], 10, "#e8694a");
    expect(el).toBe(
      '<path d="M 0 0 L 10 0 A 10 10 0 0 1 20 10 L 20 20" fill="none" stroke="#e8694a" stroke-width="1"/>',
    );
  });

  it("uses sweep 0 for a counter-clockwise turn", () => {
    // Right then up.
    const el = roundedElbowPath([[0, 20], [20, 20], [20, 0]], 10, "#000");
    expect(el).toContain("A 10 10 0 0 0 20 10");
  });

  it("clamps the corner radius to half the shorter adjacent segment", () => {
    // 8-long incoming segment → radius clamps to 4 even though 10 was asked.
    const el = roundedElbowPath([[0, 0], [8, 0], [8, 40]], 10, "#000");
    expect(el).toContain("L 4 0 A 4 4 0 0 1 8 4");
  });

  it("degrades to straight lines for 2 points and collinear runs", () => {
    expect(roundedElbowPath([[0, 0], [10, 0]], 10, "#000")).toContain(
      'd="M 0 0 L 10 0"',
    );
    expect(roundedElbowPath([[0, 0], [10, 0], [20, 0]], 10, "#000")).toContain(
      'd="M 0 0 L 10 0 L 20 0"',
    );
    expect(roundedElbowPath([], 10, "#000")).toBe("");
  });
});

describe("arrowHead", () => {
  it("points right at angle 0: tip forward, base corners 7 back and ±3.5 out", () => {
    expect(arrowHead(10, 10, 0, "#475569")).toBe(
      '<polygon points="10,10 3,13.5 3,6.5" fill="#475569"/>',
    );
  });

  it("points down at angle π/2", () => {
    expect(arrowHead(0, 10, Math.PI / 2, "#000")).toBe(
      '<polygon points="0,10 -3.5,3 3.5,3" fill="#000"/>',
    );
  });
});
