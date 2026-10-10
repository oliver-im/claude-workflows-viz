import { describe, expect, it } from "vitest";
import {
  CARD_H1,
  CARD_LINE_STEP,
  CARD_MAX_W,
  DECK_DEPTH,
  DECK_STEP,
  agentCard,
  cardAtWidth,
  equalizeHeights,
  rowCardWidth,
} from "../node-card.js";

describe("agentCard", () => {
  it("lays out an authored label above model · effort, with the effort's meter level", () => {
    const card = agentCard({ label: "review:x", model: "claude-sonnet-5", modelShort: "sonnet", effort: "medium" });
    expect(card.lines).toEqual(["review:x"]);
    expect(card.meta).toBe("sonnet · medium");
    expect(card.meter).toBe(2);
    expect(card.cardH).toBe(CARD_H1 + CARD_LINE_STEP);
  });

  it("names the model line by explicit model, else custom agent type, else the session model", () => {
    expect(agentCard({ model: "gpt-5-codex" }).meta).toBe("gpt-5-codex");
    expect(agentCard({ agentType: "codex" }).meta).toBe("codex agent");
    expect(agentCard({}).meta).toBe("session model");
    // A labeled call that sets neither shows the label alone.
    expect(agentCard({ label: "x" }).meta).toBeUndefined();
  });

  it("draws an undocumented effort as text only — no meter for a tier it can't place", () => {
    const card = agentCard({ model: "opus", modelShort: "opus", effort: "turbo" });
    expect(card.meta).toBe("opus · turbo");
    expect(card.meter).toBeUndefined();
  });

  it("stacks a ×N card and captions it with the expression its count comes from", () => {
    const card = agentCard({ label: "verify:${f}", mult: "×N", hint: "fresh" });
    expect(card.mult).toBe("×N");
    expect(card.caption).toBe("fresh");
    expect(card.h).toBeGreaterThan(card.cardH + DECK_STEP * DECK_DEPTH);
  });

  it("wraps a label past the width cap onto a second line instead of truncating it", () => {
    const card = agentCard({ label: "sweep:by dynamic dispatch and more" });
    expect(card.w).toBeLessThanOrEqual(CARD_MAX_W);
    expect(card.lines.length).toBe(2);
    expect(card.lines.join(" ").replace(/\s+/g, " ")).toBe("sweep:by dynamic dispatch and more");
  });
});

describe("rowCardWidth", () => {
  const inputs = ["sweep:by name", "sweep:by call graph", "sweep:by test references", "sweep:by dynamic dispatch"].map(
    (label) => ({ label, model: "sonnet", modelShort: "sonnet" }),
  );

  it("uses the widest natural card when the row fits", () => {
    const w = rowCardWidth(inputs.slice(0, 2), 2, 600, 16) as number;
    expect(w).toBe(Math.max(...inputs.slice(0, 2).map((i) => agentCard(i).w)));
  });

  it("narrows the row to fit, wrapping labels onto two lines", () => {
    const w = rowCardWidth(inputs, 4, 600, 16) as number;
    expect(4 * w + 3 * 16).toBeLessThanOrEqual(600);
    expect(inputs.every((i) => cardAtWidth(i, w).lines.length <= 2)).toBe(true);
  });

  it("gives up — so the caller collapses to ×N — when no width can hold the row", () => {
    expect(rowCardWidth(inputs, 12, 600, 16)).toBeUndefined();
  });
});

describe("equalizeHeights", () => {
  it("gives every card in a row the tallest card's height", () => {
    const row = equalizeHeights([agentCard({ label: "a" }), agentCard({ label: "b", model: "opus" })]);
    expect(row[0].cardH).toBe(row[1].cardH);
    expect(row[0].h).toBe(row[1].h);
  });
});
