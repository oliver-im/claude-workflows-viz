import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeBody,
  collectModuleConsts,
  resolveMultiplicity,
} from "../analyze-body.js";
import { extractMetaFromProgram, parseWorkflowSource } from "../extract-meta.js";
import type { AgentStep, Topology } from "../topology.js";

const analyze = (src: string, metaPhases: readonly string[] = []): Topology =>
  analyzeBody(parseWorkflowSource(src), src, metaPhases);

/** First step, asserted to be an agent. */
const firstAgent = (t: Topology): AgentStep => {
  const s = t.steps[0];
  expect(s?.kind).toBe("agent");
  return s as AgentStep;
};

describe("analyzeBody — sequence & phases", () => {
  it("emits agent steps in source order with the ambient phase", () => {
    const t = analyze(
      `await agent("first task");\nphase("P1");\nawait agent("second task");`,
    );
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "agent"]);
    expect(t.steps.map((s) => (s as AgentStep).label)).toEqual([
      "first task",
      "second task",
    ]);
    // Pre-marker steps carry phase: null.
    expect(t.steps.map((s) => s.phase)).toEqual([null, "P1"]);
    expect(t.hasOrchestration).toBe(true);
  });

  it("seeds bands from meta (inMeta) and appends body-only titles in lexical order", () => {
    const t = analyze(
      `phase("P3");\nawait agent("x");\nphase("P1");\nawait agent("y");`,
      ["P1", "P2"],
    );
    expect(t.bands).toEqual([
      { title: "P1", inMeta: true },
      { title: "P2", inMeta: true },
      { title: "P3", inMeta: false }, // body-only, appended — not duplicated for P1
    ]);
  });

  it("phase markers leak lexically out of blocks", () => {
    const t = analyze(`{\n  phase("X");\n}\nawait agent("p");`);
    expect(firstAgent(t).phase).toBe("X");
  });

  it("markers emit no steps; log/budget emit nothing", () => {
    const t = analyze(`phase("A");\nlog("hi");\nbudget.spent();`);
    expect(t.steps).toEqual([]);
    expect(t.notes).toEqual([]);
    expect(t.hasOrchestration).toBe(false);
  });
});

describe("analyzeBody — agent opts", () => {
  it("reads label/model/agentType string literals", () => {
    const t = analyze(`await agent("p", { label: "build", model: "opus", agentType: "codex" });`);
    const a = firstAgent(t);
    expect(a.label).toBe("build");
    expect(a.model).toBe("opus");
    expect(a.agentType).toBe("codex");
    expect(t.notes).toEqual([]);
  });

  it("keeps a template label as its verbatim inner source", () => {
    const t = analyze("await agent(\"p\", { label: `fix:${area}` });");
    expect(firstAgent(t).label).toBe("fix:${area}");
  });

  it("opts.phase overrides the ambient phase and registers the band", () => {
    const t = analyze(`phase("A");\nawait agent("p", { phase: "B" });`, ["A"]);
    expect(firstAgent(t).phase).toBe("B");
    expect(t.bands).toEqual([
      { title: "A", inMeta: true },
      { title: "B", inMeta: false },
    ]);
  });

  it("ignores a template-with-expressions phase, with a note", () => {
    const t = analyze("phase(\"A\");\nawait agent(\"p\", { phase: `x${y}` });");
    expect(firstAgent(t).phase).toBe("A"); // ambient kept
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0].message).toMatch(/phase is not a string literal/);
  });

  it("notes non-object options and falls back to the prompt label", () => {
    const t = analyze(`await agent("do the thing", options);`);
    expect(firstAgent(t).label).toBe("do the thing");
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0].message).toMatch(/options are not an inline object/);
  });
});

describe("analyzeBody — label fallback & previews", () => {
  it("truncates a long literal prompt label at LABEL_MAX", () => {
    const prompt = "x".repeat(60);
    const t = analyze(`await agent("${prompt}");`);
    const a = firstAgent(t);
    expect(a.label).toHaveLength(40);
    expect(a.label.endsWith("…")).toBe(true);
    expect(a.promptPreview).toBe(prompt); // 60 ≤ 80 — preview not cut
  });

  it("uses the template head plus … when expressions follow", () => {
    const t = analyze("await agent(`Review ${x} now`);");
    const a = firstAgent(t);
    expect(a.label).toBe("Review…");
    // Preview is the verbatim inner source, ${…} included.
    expect(a.promptPreview).toBe("Review ${x} now");
  });

  it("falls back to 'agent' for a bare call or an expression-only template", () => {
    const t = analyze("await agent();\nawait agent(`${x}`);");
    expect(t.steps.map((s) => (s as AgentStep).label)).toEqual(["agent", "agent"]);
    expect((t.steps[0] as AgentStep).promptPreview).toBeUndefined();
  });

  it("caps promptPreview at PROMPT_PREVIEW_MAX", () => {
    const prompt = "y".repeat(100);
    const t = analyze(`await agent("${prompt}");`);
    const preview = firstAgent(t).promptPreview!;
    expect(preview).toHaveLength(80);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("defaults multiplicity to one (fan-out threading is Unit 04)", () => {
    const t = analyze(`await agent("p");`);
    expect(firstAgent(t).multiplicity).toEqual({ kind: "one" });
  });
});

describe("collectModuleConsts + resolveMultiplicity", () => {
  const stateFor = (src: string, shadowed: string[] = []) => ({
    src,
    consts: collectModuleConsts(parseWorkflowSource(src)),
    shadowed: new Set(shadowed),
  });
  /** Init expression of the declarator named `__T`. */
  const probeOf = (src: string): any => {
    const program: any = parseWorkflowSource(src);
    for (const node of program.body) {
      const decl = node.type === "VariableDeclaration" ? node : node.declaration;
      for (const d of decl?.declarations ?? []) {
        if (d.id?.name === "__T") return d.init;
      }
    }
    throw new Error("probe not found");
  };

  it("literal arrays: all-strings → named; mixed → exact; holes/spread → unknown", () => {
    const src = `const __T = ["a", "b"];`;
    expect(resolveMultiplicity(probeOf(src), stateFor(src))).toEqual({
      kind: "named",
      names: ["a", "b"],
    });
    const mixed = `const __T = ["a", 2];`;
    expect(resolveMultiplicity(probeOf(mixed), stateFor(mixed))).toEqual({
      kind: "exact",
      count: 2,
    });
    const holes = `const __T = [, "a"];`;
    expect(resolveMultiplicity(probeOf(holes), stateFor(holes)).kind).toBe("unknown");
    const spread = `const __T = [...xs];`;
    expect(resolveMultiplicity(probeOf(spread), stateFor(spread)).kind).toBe("unknown");
  });

  it("resolves identifiers through module consts — even when declared after use", () => {
    const src = `const __T = LENSES;\nconst LENSES = ["x", "y", "z"];`;
    expect(resolveMultiplicity(probeOf(src), stateFor(src))).toEqual({
      kind: "named",
      names: ["x", "y", "z"],
    });
  });

  it("never trusts let/var; shadowed names resolve unknown with the name as hint", () => {
    const letSrc = `let XS = ["a"];\nconst __T = XS;`;
    expect(resolveMultiplicity(probeOf(letSrc), stateFor(letSrc))).toEqual({
      kind: "unknown",
      hint: "XS",
    });
    const src = `const XS = ["a"];\nconst __T = XS;`;
    expect(resolveMultiplicity(probeOf(src), stateFor(src, ["XS"]))).toEqual({
      kind: "unknown",
      hint: "XS",
    });
  });

  it("non-array consts resolve unknown; skips meta; reads export const", () => {
    const src = `const N = 5;\nexport const KEYS = ["k1", "k2"];\nconst __T = N;`;
    const state = stateFor(src);
    expect(state.consts.get("KEYS")).toEqual(["k1", "k2"]);
    expect(resolveMultiplicity(probeOf(src), state).kind).toBe("unknown");
    const meta = `export const meta = { name: "n" };`;
    expect(collectModuleConsts(parseWorkflowSource(meta)).has("meta")).toBe(false);
  });

  it("Array.from({length: L}) with literal or const-resolved L → exact", () => {
    const lit = `const __T = Array.from({ length: 4 });`;
    expect(resolveMultiplicity(probeOf(lit), stateFor(lit))).toEqual({
      kind: "exact",
      count: 4,
    });
    const viaConst = `const FLEET = 3;\nconst __T = Array.from({ length: FLEET });`;
    expect(resolveMultiplicity(probeOf(viaConst), stateFor(viaConst))).toEqual({
      kind: "exact",
      count: 3,
    });
    const dynamic = `const __T = Array.from(xs);`;
    expect(resolveMultiplicity(probeOf(dynamic), stateFor(dynamic)).kind).toBe("unknown");
  });
});

describe("analyzeBody — workflow & catch-all degradation", () => {
  it("recognizes workflow() calls", () => {
    const t = analyze(`await workflow("deploy-staging");`);
    expect(t.steps[0]).toMatchObject({ kind: "workflow", label: "deploy-staging" });
    expect(t.hasOrchestration).toBe(true);
  });

  it("degrades a switch containing agent calls to opaque + note", () => {
    const t = analyze(`switch (x) {\n  case 1:\n    await agent("a");\n}`);
    expect(t.steps.map((s) => s.kind)).toEqual(["opaque"]);
    expect(t.notes.some((n) => n.message.includes("unrecognized statement"))).toBe(true);
    expect(t.hasOrchestration).toBe(false); // opaque-only ⇒ v1 fallback
  });

  it("notes orchestrating helper functions without tracing them", () => {
    const t = analyze(`function helper() {\n  return agent("x");\n}\nhelper();`);
    expect(t.steps).toEqual([]);
    expect(t.notes.some((n) => n.message.includes("helper 'helper' contains agent calls"))).toBe(
      true,
    );
  });

  it("degrades a bare orchestrating map to opaque + note", () => {
    const t = analyze(`xs.map((x) => agent(x));`);
    expect(t.steps.map((s) => s.kind)).toEqual(["opaque"]);
    expect(t.notes).toHaveLength(1);
  });

  // Interim behavior — Unit 04 replaces these degradations with real recognizers.
  it("loops and branches with orchestration degrade to one opaque + note (this unit)", () => {
    const loop = analyze(`while (more) {\n  await agent("x");\n}`);
    expect(loop.steps.map((s) => s.kind)).toEqual(["opaque"]);
    expect(loop.notes.some((n) => n.message.includes("loop or branch"))).toBe(true);

    const ternary = analyze(`const p = c ? null : await agent("x");`);
    expect(ternary.steps.map((s) => s.kind)).toEqual(["opaque"]);
    expect(ternary.notes).toHaveLength(1);
  });

  it("walks try blocks inline and flattens orchestrating handlers with a note", () => {
    const t = analyze(
      `try {\n  await agent("a");\n} catch (e) {\n  await agent("b");\n}`,
    );
    expect(t.steps.map((s) => (s as AgentStep).label)).toEqual(["a", "b"]);
    expect(t.notes.some((n) => n.message.includes("try/catch flattened"))).toBe(true);
  });

  it("unwraps chained calls and degrades orchestrating callbacks visibly", () => {
    const t = analyze(`await agent("root").then((v) => agent(v));`);
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "opaque"]);
    expect((t.steps[0] as AgentStep).label).toBe("root");
    expect(t.notes.some((n) => n.message.includes("callback on a chained call"))).toBe(true);
  });

  it("notes phase() used in expression position without changing bands", () => {
    const t = analyze(`const tag = phase("X");`);
    expect(t.steps).toEqual([]);
    expect(t.bands).toEqual([]);
    expect(t.notes.some((n) => n.message.includes("expression position"))).toBe(true);
  });

  it("notes a phase() marker nested inside an unrecognized expression", () => {
    const t = analyze(`const x = wrap(phase("A"));`);
    expect(t.steps).toEqual([]);
    expect(t.bands).toEqual([]);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0].message).toMatch(/never sets the band/);
  });

  it("notes every marker lost in dropped or opaque regions — band loss is never silent", () => {
    // A logs-only branch is dropped wholesale; its marker would vanish.
    const dropped = analyze(`if (x) {\n  phase("B");\n  log("y");\n}`);
    expect(dropped.steps).toEqual([]);
    expect(dropped.notes.filter((n) => n.message.includes("never sets the band"))).toHaveLength(1);

    // An orchestrating branch degrades to an opaque step (this unit), but the
    // band title inside is a distinct loss — noted separately.
    const opaqued = analyze(`if (x) {\n  phase("B");\n  await agent("y");\n}`);
    expect(opaqued.steps.map((s) => s.kind)).toEqual(["opaque"]);
    const drops = opaqued.notes.filter((n) => n.message.includes("never sets the band"));
    expect(drops).toHaveLength(1);
    expect(drops[0].snippet).toContain('phase("B")');
    expect(opaqued.notes.some((n) => n.message.includes("loop or branch"))).toBe(true);
  });

  it("notes markers hidden in call arguments and in untraced helpers", () => {
    const inArgs = analyze(`await agent(phase("A"));`);
    expect(inArgs.steps.map((s) => s.kind)).toEqual(["agent"]);
    expect(inArgs.notes.some((n) => n.message.includes("never sets the band"))).toBe(true);

    const inHelper = analyze(`function setup() {\n  phase("A");\n}\nsetup();`);
    expect(inHelper.steps).toEqual([]);
    expect(inHelper.notes).toHaveLength(1);
    expect(inHelper.notes[0].message).toMatch(/never sets the band/);
  });

  it("never double-notes: member .phase() calls and malformed bare markers stay single-source", () => {
    const member = analyze(`tracker.phase("A");\nawait agent("p");`);
    expect(member.notes).toEqual([]);

    // The malformed-marker path keeps its specific note, no added drop note.
    const malformed = analyze(`phase(title);`);
    expect(malformed.notes).toHaveLength(1);
    expect(malformed.notes[0].message).toMatch(/without a single string-literal title/);
  });
});

describe("analyzeBody — totality & honesty", () => {
  it("returns hasOrchestration:false and no steps for a non-orchestrating body", () => {
    const t = analyze(`const a = 1;\nlog("x");\nfunction f() { return 2; }`);
    expect(t.steps).toEqual([]);
    expect(t.hasOrchestration).toBe(false);
  });

  it("never throws on a weird-but-valid grab bag, and degrades visibly", () => {
    const src = [
      `"use strict";`,
      `label: for (;;) break label;`,
      `class Foo { get x() { return 1; } static #p = /a+b/gu; }`,
      `const big = 10n;`,
      `const tagged = String.raw\`a\${1}b\`;`,
      `const seq = (1, 2, agent("in-seq"));`,
      `async function helper() { await agent("hidden"); }`,
      `await agent?.("optional");`,
      `export default 42;`,
    ].join("\n");
    let t!: Topology;
    expect(() => {
      t = analyze(src);
    }).not.toThrow();
    // Honesty: both hidden orchestrations surface — the sequence-expression
    // agent as an opaque step, the helper as a note.
    expect(t.steps.some((s) => s.kind === "opaque")).toBe(true);
    expect(t.notes.some((n) => n.message.includes("helper 'helper'"))).toBe(true);
    // The optional call still reads as an agent step.
    expect(t.steps.some((s) => s.kind === "agent")).toBe(true);
  });

  it("is deterministic", () => {
    const src = `phase("A");\nawait agent("p", { label: "x" });\nwhile (q) { await agent("r"); }`;
    expect(JSON.stringify(analyze(src, ["A"]))).toBe(JSON.stringify(analyze(src, ["A"])));
  });
});

describe("analyzeBody — interim integration over examples/", () => {
  const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
  const files = readdirSync(examplesDir).filter((f) => f.endsWith(".js"));

  it("covers all 8 example workflows", () => {
    expect(files).toHaveLength(8);
  });

  it("analyzes every example without throwing (one parse, meta-seeded bands)", () => {
    for (const f of files) {
      const src = readFileSync(join(examplesDir, f), "utf8");
      const program = parseWorkflowSource(src);
      const meta = extractMetaFromProgram(program);
      const titles = meta.phases.map((p) => p.title);
      let t!: Topology;
      expect(() => {
        t = analyzeBody(program, src, titles);
      }).not.toThrow();
      // Every meta phase stays a band, in meta order, ahead of body extras.
      expect(t.bands.slice(0, titles.length)).toEqual(
        titles.map((title) => ({ title, inMeta: true })),
      );
    }
  });

  const analyzeExample = (name: string): Topology => {
    const src = readFileSync(join(examplesDir, name), "utf8");
    const program = parseWorkflowSource(src);
    return analyzeBody(program, src, extractMetaFromProgram(program).phases.map((p) => p.title));
  };

  it("triage-issue: classifier agent recognized; ternary route degrades opaque (this unit)", () => {
    const t = analyzeExample("triage-issue.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "opaque"]);
    const classify = t.steps[0] as AgentStep;
    expect(classify.phase).toBe("Classify the report");
    expect(classify.label).toBe("Classify this issue into one of…");
    expect(classify.promptPreview).toContain("${SPECIALISTS.join(");
    expect(t.hasOrchestration).toBe(true);
  });

  it("summarize-codebase: sequential agents recognized around the (still-opaque) fanout", () => {
    const t = analyzeExample("summarize-codebase.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "opaque", "agent"]);
    expect(t.steps.map((s) => s.phase)).toEqual([
      "List the modules",
      "Read every module in parallel",
      "Synthesize the overview",
    ]);
    expect(t.hasOrchestration).toBe(true);
  });

  it("hunt-bugs: the while loop is one opaque — honest v1 fallback state (this unit)", () => {
    const t = analyzeExample("hunt-bugs.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["opaque"]);
    expect(t.hasOrchestration).toBe(false);
    expect(t.notes.length).toBeGreaterThan(0);
    // The marker inside the opaque'd while is individually accounted for.
    const drops = t.notes.filter((n) => n.message.includes("never sets the band"));
    expect(drops).toHaveLength(1);
    expect(drops[0].snippet).toContain("Verify and bank the survivors");
  });

  it("review-pr: agents recognized around the (still-opaque) pipeline", () => {
    const t = analyzeExample("review-pr.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "opaque", "agent"]);
    expect(t.hasOrchestration).toBe(true);
  });
});
