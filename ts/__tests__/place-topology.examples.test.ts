import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeBody } from "../analyze-body.js";
import { extractMetaFromProgram, parseWorkflowSource } from "../extract-meta.js";
import { placeTopology } from "../place-topology.js";
import type { Layout } from "../topo-geometry.js";

/**
 * Composition acceptance against the real corpus: every example analyzed then
 * placed must satisfy the headline invariant — NO edge points up (loops are
 * badges, not back-edges) — which is exactly the "0 cross-card edges" property,
 * true here by construction because there are no card walls to cross. Plus the
 * per-shape facts the swimlane composition has to get right.
 */

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "level-1");

const place = (name: string): Layout => {
  const src = readFileSync(join(dir, name), "utf8");
  const program = parseWorkflowSource(src);
  const meta = extractMetaFromProgram(program);
  return placeTopology(
    analyzeBody(program, src, meta.phases.map((p) => p.title)),
    meta,
  );
};

const nodeById = (layout: Layout, id: string) => layout.nodes.find((n) => n.id === id);
/** Edges that point up or jump to an earlier band — the back-routes a card wall
 *  used to force. Must be empty everywhere. */
const backRoutes = (layout: Layout) =>
  layout.edges.filter((e) => {
    const a = nodeById(layout, e.from);
    const b = nodeById(layout, e.to);
    return !a || !b || a.y > b.y;
  });

describe("placeTopology — corpus composition", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));

  it("covers all 12 examples", () => {
    expect(files).toHaveLength(12);
  });

  it("every example: ZERO back-routes (no edge points up or to an earlier band)", () => {
    for (const f of files) {
      const layout = place(f);
      expect(backRoutes(layout), f).toEqual([]);
    }
  });

  it("every example: every fan member / pipeline cell connects onward (no dangling fan)", () => {
    for (const f of files) {
      const layout = place(f);
      // Any agent node that shares its lane with a barrier is part of a fan/grid
      // and must have an outgoing edge.
      const barrierLanes = new Set(layout.nodes.filter((n) => n.kind === "barrier").map((n) => n.phase));
      const fanMembers = layout.nodes.filter((n) => n.kind === "agent" && barrierLanes.has(n.phase));
      for (const m of fanMembers) {
        expect(layout.edges.some((e) => e.from === m.id), `${f}: ${m.label}`).toBe(true);
      }
    }
  });

  it("every example: lanes are ordered top→down and non-overlapping", () => {
    for (const f of files) {
      const layout = place(f);
      for (let i = 1; i < layout.lanes.length; i++) {
        expect(layout.lanes[i].yTop, `${f} lane ${i}`).toBeGreaterThanOrEqual(layout.lanes[i - 1].yBot - 1);
      }
    }
  });

  it("tournament (choose-approach): 4 lanes, 'Advance the bracket' is an empty strip, loop badge on the Judge node", () => {
    const layout = place("choose-approach.js");
    expect(layout.lanes).toHaveLength(4);
    const advance = layout.lanes.find((l) => l.title === "Advance the bracket");
    expect(advance?.empty).toBe(true); // control-only → strip, not a card

    // The while + for nest → two stacked repeat badges, both on the match node.
    expect(layout.loops.length).toBeGreaterThanOrEqual(1);
    expect(layout.loops.some((l) => l.label.includes("while bracket.length > 1"))).toBe(true);
    const judgeLane = layout.lanes.findIndex((l) => l.title === "Judge pairwise");
    const badged = nodeById(layout, layout.loops[0].onNode);
    expect(badged?.phase).toBe(judgeLane);
    expect(backRoutes(layout)).toEqual([]); // no band-crossing back-route
  });

  it("triage: router fan contained in its lane; classify→route→fix is a vertical spine", () => {
    const layout = place("triage-issue.js");
    const reply = layout.lanes.find((l) => l.title === "Reply or escalate");
    expect(reply?.empty).toBe(false); // trailing control-only phase gets an explicit end node

    const decision = layout.nodes.find((n) => n.kind === "decision");
    expect(decision).toBeDefined();
    // The classify agent and the fix agent are on the spine; the seq edges
    // joining the main path are (near-)vertical, not gutter detours.
    const spineSeq = layout.edges.filter((e) => {
      const a = nodeById(layout, e.from);
      const b = nodeById(layout, e.to);
      return e.kind === "seq" && a && b && Math.abs(a.x - b.x) < 1 && Math.abs(b.x - decision!.x) < 1;
    });
    expect(spineSeq.length).toBeGreaterThanOrEqual(1);
  });

  it("hunt-bugs: loop badge, dry-path control, readable verify fan-out, and visible end phase", () => {
    const layout = place("hunt-bugs.js");
    expect(layout.loops).toHaveLength(1);
    expect(layout.nodes.some((n) => n.kind === "control" && n.label === "continue loop")).toBe(true);
    expect(layout.nodes.some((n) => n.kind === "agent" && n.label === "verify each fresh")).toBe(true);
    const stop = layout.lanes.find((l) => l.title === "Stop when the well runs dry");
    expect(stop?.empty).toBe(false);
    const stopLane = layout.lanes.findIndex((l) => l.title === "Stop when the well runs dry");
    expect(layout.nodes.some((n) => n.kind === "control" && n.label === "end" && n.phase === stopLane)).toBe(true);
    expect(layout.notes.some((n) => n.includes("spans phases"))).toBe(true);
    expect(backRoutes(layout)).toEqual([]);
  });

  it("review-pr: all four lanes carry graph (the verify fan lands in 'Adversarially verify', not a strip)", () => {
    const layout = place("review-pr.js");
    expect(layout.lanes).toHaveLength(4);
    expect(layout.lanes.every((l) => !l.empty)).toBe(true);
    const verifyLane = layout.lanes.findIndex((l) => l.title === "Adversarially verify");
    const verifyCells = layout.nodes.filter((n) => n.kind === "agent" && n.phase === verifyLane);
    expect(verifyCells.length).toBeGreaterThanOrEqual(1);
    // Every verify cell rejoins the sink — the dangling-fan bug, fixed.
    for (const c of verifyCells) expect(layout.edges.some((e) => e.from === c.id)).toBe(true);
  });

  it("is deterministic across runs for every example", () => {
    for (const f of files) {
      expect(JSON.stringify(place(f)), f).toBe(JSON.stringify(place(f)));
    }
  });
});
