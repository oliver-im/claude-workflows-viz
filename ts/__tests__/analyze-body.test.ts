import { describe, expect, it } from "vitest";
import {
  analyzeBody,
  collectModuleConsts,
  resolveMultiplicity,
} from "../analyze-body.js";
import { parseWorkflowSource } from "../extract-meta.js";
import type {
  AgentStep,
  BranchStep,
  ControlStep,
  LoopStep,
  ParallelStep,
  PipelineStep,
  Topology,
} from "../topology.js";

type Fanout = ParallelStep & { form: "fanout" };
type Branches = ParallelStep & { form: "branches" };

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

  it("assignment statements walk their right-hand side", () => {
    const t = analyze(`let r;\nr = await agent("x");`);
    expect(t.steps.map((s) => s.kind)).toEqual(["agent"]);
    expect(t.notes).toEqual([]);
  });

  it("keeps abrupt non-agent branch arms as deterministic control nodes", () => {
    const t = analyze(
      `while (again) {\n  await agent("find");\n  if (fresh.length === 0) {\n    dryRounds += 1;\n    continue;\n  }\n  await agent("verify");\n}`,
    );
    const loop = t.steps[0] as LoopStep;
    expect(loop.body.map((s) => s.kind)).toEqual(["agent", "branch", "agent"]);
    const br = loop.body[1] as BranchStep;
    expect(br.conditionLabel).toBe("fresh.length === 0");
    expect(br.thenSteps.map((s) => s.kind)).toEqual(["control"]);
    expect((br.thenSteps[0] as ControlStep).label).toBe("continue loop");
    expect((br.thenSteps[0] as ControlStep).flow).toBe("continue");
    expect(br.elseSteps).toEqual([]);
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

    // A still-unrecognized structure opaques wholesale; the band title inside
    // is a distinct loss — noted separately.
    const opaqued = analyze(`switch (x) {\n  case 1:\n    phase("B");\n    await agent("y");\n}`);
    expect(opaqued.steps.map((s) => s.kind)).toEqual(["opaque"]);
    const drops = opaqued.notes.filter((n) => n.message.includes("never sets the band"));
    expect(drops).toHaveLength(1);
    expect(drops[0].snippet).toContain('phase("B")');
    expect(opaqued.notes.some((n) => n.message.includes("unrecognized statement"))).toBe(true);
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

describe("analyzeBody — parallel", () => {
  it("thunk array → branches form, one walked branch per thunk", () => {
    const t = analyze(`await parallel([() => agent("a"), () => agent("b", { label: "B" })]);`);
    expect(t.steps).toHaveLength(1);
    const p = t.steps[0] as Branches;
    expect(p.kind).toBe("parallel");
    expect(p.form).toBe("branches");
    expect(p.branches.map((b) => b.map((s) => (s as AgentStep).label))).toEqual([["a"], ["B"]]);
    expect(t.notes).toEqual([]);
    expect(t.hasOrchestration).toBe(true);
  });

  it("non-function branch element degrades to an opaque branch + note", () => {
    const t = analyze(`await parallel([() => agent("a"), thunks]);`);
    const p = t.steps[0] as Branches;
    expect(p.branches[0].map((s) => s.kind)).toEqual(["agent"]);
    expect(p.branches[1].map((s) => s.kind)).toEqual(["opaque"]);
    expect(t.notes.some((n) => n.message.includes("parallel branch is not an inline function"))).toBe(
      true,
    );
  });

  it(".map fan-out: named multiplicity threads onto body agents with expanded labels", () => {
    const t = analyze(
      "const LENSES = [\"x\", \"y\"];\nawait parallel(LENSES.map((l) => () => agent(\"p\", { label: `r:${l}` })));",
    );
    const p = t.steps[0] as Fanout;
    expect(p.form).toBe("fanout");
    expect(p.multiplicity).toEqual({ kind: "named", names: ["x", "y"] });
    const a = p.body[0] as AgentStep;
    expect(a.multiplicity).toEqual({ kind: "named", names: ["x", "y"] });
    expect(a.label).toBe("r:${l}");
    expect(a.expandedLabels).toEqual(["r:x", "r:y"]);
    expect(t.notes).toEqual([]);
  });

  it("fan-out parameters shadow module consts inside the body (soundness)", () => {
    const t = analyze(
      `const ROWS = ["r1", "r2"];\nawait parallel(XS.map((ROWS) => () => parallel(ROWS.map((c) => () => agent(c)))));`,
    );
    const outer = t.steps[0] as Fanout;
    expect(outer.multiplicity.kind).toBe("unknown"); // XS is no const
    const inner = outer.body[0] as Fanout;
    expect(inner.kind).toBe("parallel");
    // ROWS here is the fan-out parameter, NOT the module const.
    expect(inner.multiplicity).toEqual({ kind: "unknown", hint: "ROWS" });
  });

  it("Array.from fan-outs resolve exact counts; exact lanes never expand labels", () => {
    const t = analyze(
      "await parallel(Array.from({ length: 3 }).map((w) => () => agent(\"p\", { label: `w:${w}` })));",
    );
    const p = t.steps[0] as Fanout;
    expect(p.multiplicity).toEqual({ kind: "exact", count: 3 });
    const a = p.body[0] as AgentStep;
    expect(a.multiplicity).toEqual({ kind: "exact", count: 3 });
    expect(a.expandedLabels).toBeUndefined();
  });

  it("tolerates an un-thunked single arrow with a chained call body", () => {
    const t = analyze(`const XS = ["a", "b"];\nawait parallel(XS.map((x) => agent(x).then((v) => v)));`);
    const p = t.steps[0] as Fanout;
    expect(p.body.map((s) => s.kind)).toEqual(["agent"]);
    expect(t.notes).toEqual([]);
  });

  it("unreadable parallel arguments degrade to an empty fan-out + note", () => {
    const t = analyze(`await parallel(buildThunks());`);
    const p = t.steps[0] as Fanout;
    expect(p.body).toEqual([]);
    expect(p.multiplicity.kind).toBe("unknown");
    expect(t.notes.some((n) => n.message.includes("neither a thunk array nor a .map"))).toBe(true);
    // parallel() itself is still flow — orchestration is claimed.
    expect(t.hasOrchestration).toBe(true);
  });
});

describe("analyzeBody — pipeline", () => {
  it("walks stages with stage-param label expansion; lane multiplicity stays with the flattener", () => {
    const t = analyze(
      "const DIMS = [\"a\", \"b\"];\nawait pipeline(DIMS, (d) => agent(`s1 ${d}`, { label: `st1:${d}` }), (r) => agent(\"s2\"));",
    );
    const p = t.steps[0] as PipelineStep;
    expect(p.kind).toBe("pipeline");
    expect(p.items).toEqual({ kind: "named", names: ["a", "b"] });
    expect(p.stages).toHaveLength(2);
    const s1 = p.stages[0][0] as AgentStep;
    expect(s1.expandedLabels).toEqual(["st1:a", "st1:b"]);
    expect(s1.multiplicity).toEqual({ kind: "one" });
    const s2 = p.stages[1][0] as AgentStep;
    expect(s2.label).toBe("s2");
    expect(s2.expandedLabels).toBeUndefined();
    expect(t.notes).toEqual([]);
  });

  it("degrades a non-function stage to an opaque stage + note", () => {
    const t = analyze(`await pipeline(xs, (x) => agent("s1"), stage2);`);
    const p = t.steps[0] as PipelineStep;
    expect(p.items.kind).toBe("unknown");
    expect(p.stages[0].map((s) => s.kind)).toEqual(["agent"]);
    expect(p.stages[1].map((s) => s.kind)).toEqual(["opaque"]);
    expect(t.notes.some((n) => n.message.includes("pipeline stage is not an inline function"))).toBe(
      true,
    );
  });

  it("a stage returning parallel(...) nests naturally", () => {
    const t = analyze(`await pipeline(xs, (x) => parallel(x.items.map((i) => () => agent("v"))));`);
    const p = t.steps[0] as PipelineStep;
    const nested = p.stages[0][0] as Fanout;
    expect(nested.kind).toBe("parallel");
    expect(nested.multiplicity).toEqual({ kind: "unknown", hint: "x.items" });
    expect(nested.body.map((s) => s.kind)).toEqual(["agent"]);
  });
});

describe("analyzeBody — loops & branches", () => {
  it("while loops with orchestrating bodies become LoopSteps with verbatim conditions", () => {
    const t = analyze(`phase("P");\nwhile (more.work) {\n  await agent("x");\n}`);
    const l = t.steps[0] as LoopStep;
    expect(l.kind).toBe("loop");
    expect(l.loopKind).toBe("while");
    expect(l.conditionLabel).toBe("more.work");
    expect(l.phase).toBe("P");
    expect(l.body.map((s) => s.kind)).toEqual(["agent"]);
    expect(t.notes).toEqual([]);
  });

  it("do-while and for loops carry their kinds and test slices", () => {
    const dw = analyze(`do {\n  await agent("x");\n} while (more);`);
    expect((dw.steps[0] as LoopStep).loopKind).toBe("do-while");
    expect((dw.steps[0] as LoopStep).conditionLabel).toBe("more");

    const f = analyze(`for (let i = 0; i < n; i += 1) {\n  await agent("x");\n}`);
    const fl = f.steps[0] as LoopStep;
    expect(fl.loopKind).toBe("for");
    expect(fl.conditionLabel).toBe("i < n");
    expect(fl.iterations).toBeUndefined();
  });

  it("for-of over a resolvable collection records iterations", () => {
    const t = analyze(
      "const MODS = [\"m1\", \"m2\"];\nfor (const m of MODS) {\n  await agent(`read ${m}`);\n}",
    );
    const l = t.steps[0] as LoopStep;
    expect(l.loopKind).toBe("for-of");
    expect(l.conditionLabel).toBe("const m of MODS");
    expect(l.iterations).toBe(2);
  });

  it("truncates long loop conditions at COND_MAX", () => {
    const long = "x".repeat(60);
    const t = analyze(`while (flagA && ${long}) {\n  await agent("x");\n}`);
    const l = t.steps[0] as LoopStep;
    expect(l.conditionLabel).toHaveLength(48);
    expect(l.conditionLabel.endsWith("…")).toBe(true);
  });

  it("orchestration in a loop condition is prepended", () => {
    const t = analyze(`while (await agent("check")) {\n  await agent("body");\n}`);
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "loop"]);
    expect((t.steps[0] as AgentStep).label).toBe("check");
    expect((t.steps[1] as LoopStep).body.map((s) => s.kind)).toEqual(["agent"]);
  });

  it("do-while test orchestration follows the loop (the body runs first)", () => {
    const t = analyze(`do {\n  await agent("body");\n} while (await agent("check"));`);
    expect(t.steps.map((s) => s.kind)).toEqual(["loop", "agent"]);
    expect((t.steps[1] as AgentStep).label).toBe("check");
    expect((t.steps[0] as LoopStep).body.map((s) => (s as AgentStep).label)).toEqual(["body"]);
  });

  it("non-orchestrating loops are omitted, with markers accounted", () => {
    const t = analyze(`for (const x of xs) {\n  phase("Z");\n  log(x);\n}`);
    expect(t.steps).toEqual([]);
    expect(t.notes.some((n) => n.message.includes("never sets the band"))).toBe(true);
  });

  it("ifs with an orchestrating arm become BranchSteps; arms walk as lists", () => {
    const t = analyze(`if (ok) {\n  await agent("a");\n} else {\n  await agent("b");\n}`);
    const b = t.steps[0] as BranchStep;
    expect(b.kind).toBe("branch");
    expect(b.conditionLabel).toBe("ok");
    expect(b.thenSteps.map((s) => (s as AgentStep).label)).toEqual(["a"]);
    expect(b.elseSteps.map((s) => (s as AgentStep).label)).toEqual(["b"]);
    expect(t.notes).toEqual([]);
  });

  it("ternaries are branches; a null/non-orchestrating arm is []", () => {
    const t = analyze(`const p = c < 0.5 ? null : await agent("x");`);
    const b = t.steps[0] as BranchStep;
    expect(b.kind).toBe("branch");
    expect(b.conditionLabel).toBe("c < 0.5");
    expect(b.thenSteps).toEqual([]);
    expect(b.elseSteps.map((s) => s.kind)).toEqual(["agent"]);
    expect(t.notes).toEqual([]);
  });

  it("orchestration in an if test is prepended; single-statement arms wrap", () => {
    const t = analyze(`if (await agent("gate")) await agent("then");`);
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "branch"]);
    const b = t.steps[1] as BranchStep;
    expect(b.thenSteps.map((s) => (s as AgentStep).label)).toEqual(["then"]);
    expect(b.elseSteps).toEqual([]);
  });

  it("else-if chains nest as branches in elseSteps", () => {
    const t = analyze(`if (a) {\n  await agent("x");\n} else if (b) {\n  await agent("y");\n}`);
    const b = t.steps[0] as BranchStep;
    expect(b.elseSteps.map((s) => s.kind)).toEqual(["branch"]);
    expect((b.elseSteps[0] as BranchStep).thenSteps.map((s) => s.kind)).toEqual(["agent"]);
  });

  it("phase markers inside loop bodies mutate the ambient band (spans bands)", () => {
    const t = analyze(
      `phase("A");\nwhile (q) {\n  await agent("one");\n  phase("B");\n  await agent("two");\n}`,
      ["A", "B"],
    );
    const l = t.steps[0] as LoopStep;
    expect(l.phase).toBe("A");
    expect(l.body.map((s) => s.phase)).toEqual(["A", "B"]);
  });

  it("branch-arm markers band their own steps only — no cross-arm or downstream leak", () => {
    const t = analyze(
      `if (ok) {\n  phase("A");\n  await agent("a");\n} else {\n  await agent("b");\n}\nawait agent("after");`,
    );
    const b = t.steps[0] as BranchStep;
    expect((b.thenSteps[0] as AgentStep).phase).toBe("A");
    expect((b.elseSteps[0] as AgentStep).phase).toBeNull();
    expect(t.steps[1].phase).toBeNull();
    // The band itself stays registered — the title genuinely exists.
    expect(t.bands).toEqual([{ title: "A", inMeta: false }]);
  });

  it("parallel-lane and catch-handler markers stay inside their region", () => {
    const lanes = analyze(
      `await parallel([() => {\n  phase("L1");\n  return agent("a");\n}, () => agent("b")]);\nawait agent("after");`,
    );
    const p = lanes.steps[0] as Branches;
    expect(p.branches[0].map((s) => s.phase)).toEqual(["L1"]);
    expect(p.branches[1].map((s) => s.phase)).toEqual([null]);
    expect(lanes.steps[1].phase).toBeNull();

    const caught = analyze(
      `try {\n  await agent("a");\n} catch (e) {\n  phase("H");\n  await agent("h");\n}\nawait agent("after");`,
    );
    expect(caught.steps.map((s) => s.phase)).toEqual([null, "H", null]);
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
