import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeBody } from "../analyze-body.js";
import { extractMetaFromProgram, parseWorkflowSource } from "../extract-meta.js";
import type {
  AgentStep,
  BranchStep,
  ControlStep,
  LoopStep,
  ParallelStep,
  PipelineStep,
  Step,
  Topology,
} from "../topology.js";

/**
 * Corpus-wide acceptance bar for the completed analyzer: every example
 * produces a fully-typed tree — zero opaque steps, zero notes. These tests
 * pin recognizer completeness; any degradation over the corpus is a
 * regression, not an acceptable fallback.
 */

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "level-1");

const analyzeExample = (name: string): Topology => {
  const src = readFileSync(join(examplesDir, name), "utf8");
  const program = parseWorkflowSource(src);
  const meta = extractMetaFromProgram(program);
  return analyzeBody(
    program,
    src,
    meta.phases.map((p) => p.title),
  );
};

/** Every step in the tree, structures included, depth-first. */
const collectSteps = (steps: readonly Step[]): Step[] => {
  const out: Step[] = [];
  for (const s of steps) {
    out.push(s);
    switch (s.kind) {
      case "parallel":
        out.push(
          ...(s.form === "branches" ? s.branches.flatMap(collectSteps) : collectSteps(s.body)),
        );
        break;
      case "pipeline":
        out.push(...s.stages.flatMap(collectSteps));
        break;
      case "loop":
        out.push(...collectSteps(s.body));
        break;
      case "branch":
        out.push(...collectSteps(s.thenSteps), ...collectSteps(s.elseSteps));
        break;
      default:
        break;
    }
  }
  return out;
};

type Fanout = ParallelStep & { form: "fanout" };
type Branches = ParallelStep & { form: "branches" };

describe("analyzer corpus invariant", () => {
  const files = readdirSync(examplesDir).filter((f) => f.endsWith(".js"));

  it("covers all 8 example workflows", () => {
    expect(files).toHaveLength(8);
  });

  it("every example: orchestration recognized, ZERO opaques, ZERO notes, meta bands seeded", () => {
    for (const f of files) {
      const t = analyzeExample(f);
      expect(t.hasOrchestration, f).toBe(true);
      expect(t.notes, f).toEqual([]);
      expect(collectSteps(t.steps).filter((s) => s.kind === "opaque"), f).toEqual([]);
      const src = readFileSync(join(examplesDir, f), "utf8");
      const titles = extractMetaFromProgram(parseWorkflowSource(src)).phases.map((p) => p.title);
      expect(t.bands.slice(0, titles.length), f).toEqual(
        titles.map((title) => ({ title, inMeta: true })),
      );
    }
  });

  it("is deterministic across runs", () => {
    for (const f of files) {
      expect(JSON.stringify(analyzeExample(f))).toBe(JSON.stringify(analyzeExample(f)));
    }
  });
});

describe("per-example structure", () => {
  it("review-pr: agent → pipeline(named dims; expanded review:*; nested verify fan-out) → agent", () => {
    const t = analyzeExample("review-pr.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "pipeline", "agent"]);

    const pipe = t.steps[1] as PipelineStep;
    expect(pipe.items).toEqual({
      kind: "named",
      names: ["correctness", "security", "performance"],
    });
    expect(pipe.stages).toHaveLength(2);

    expect(pipe.stages[0].map((s) => s.kind)).toEqual(["agent"]);
    const review = pipe.stages[0][0] as AgentStep;
    expect(review.label).toBe("review:${dim}");
    expect(review.expandedLabels).toEqual([
      "review:correctness",
      "review:security",
      "review:performance",
    ]);
    expect(review.phase).toBe("Review by dimension");
    expect(review.multiplicity).toEqual({ kind: "one" }); // lanes applied by the flattener

    expect(pipe.stages[1].map((s) => s.kind)).toEqual(["parallel"]);
    const fan = pipe.stages[1][0] as Fanout;
    expect(fan.form).toBe("fanout");
    expect(fan.multiplicity).toEqual({ kind: "unknown", hint: "review.findings" });
    expect(fan.body.map((s) => s.kind)).toEqual(["agent"]);
    const verify = fan.body[0] as AgentStep;
    expect(verify.label).toBe("verify:${f.title}");
    expect(verify.expandedLabels).toBeUndefined(); // f.title is no bare parameter
    expect(verify.phase).toBe("Adversarially verify");
    expect(verify.multiplicity).toEqual({ kind: "unknown", hint: "review.findings" });
  });

  it("triage-issue: classify agent → branch with empty then-arm and the routed fix agent", () => {
    const t = analyzeExample("triage-issue.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "branch"]);

    const classify = t.steps[0] as AgentStep;
    expect(classify.phase).toBe("Classify the report");
    expect(classify.label).toBe("Classify this issue into one of…");
    expect(classify.promptPreview).toContain("${SPECIALISTS.join(");

    const br = t.steps[1] as BranchStep;
    expect(br.conditionLabel).toBe("confidence < 0.5");
    expect(br.phase).toBe("Route to a specialist");
    expect(br.thenSteps).toEqual([]);
    expect(br.elseSteps.map((s) => s.kind)).toEqual(["agent"]);
    const fix = br.elseSteps[0] as AgentStep;
    expect(fix.label).toBe("fix:${area}");
    expect(fix.expandedLabels).toBeUndefined(); // area is no fan-out parameter
    expect(fix.phase).toBe("Draft a fix");
    // "Reply or escalate" stays a band with no steps.
    expect(t.bands.some((b) => b.title === "Reply or escalate" && b.inMeta)).toBe(true);
  });

  it("summarize-codebase: agent → unknown-width fan-out (read:${m}) → agent", () => {
    const t = analyzeExample("summarize-codebase.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "parallel", "agent"]);
    expect(t.steps.map((s) => s.phase)).toEqual([
      "List the modules",
      "Read every module in parallel",
      "Synthesize the overview",
    ]);
    const fan = t.steps[1] as Fanout;
    expect(fan.form).toBe("fanout");
    expect(fan.multiplicity).toEqual({ kind: "unknown", hint: "modules.modules" });
    expect(fan.body.map((s) => s.kind)).toEqual(["agent"]);
    const read = fan.body[0] as AgentStep;
    expect(read.label).toBe("read:${m}");
    expect(read.expandedLabels).toBeUndefined(); // width unknown — nothing to expand
    expect(read.multiplicity).toEqual({ kind: "unknown", hint: "modules.modules" });
  });

  it("verify-fix: agent → agent → named refute panel expanded refute:*", () => {
    const t = analyzeExample("verify-fix.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "agent", "parallel"]);
    const fan = t.steps[2] as Fanout;
    expect(fan.multiplicity).toEqual({
      kind: "named",
      names: ["correctness", "security", "regressions"],
    });
    const refute = fan.body[0] as AgentStep;
    expect(refute.expandedLabels).toEqual([
      "refute:correctness",
      "refute:security",
      "refute:regressions",
    ]);
    expect(refute.multiplicity).toEqual({
      kind: "named",
      names: ["correctness", "security", "regressions"],
    });
    // "Ship or bounce" stays a band with no steps.
    expect(t.bands.some((b) => b.title === "Ship or bounce" && b.inMeta)).toBe(true);
  });

  it("name-the-feature: named gen fan-out → filter agent → shortlist agent", () => {
    const t = analyzeExample("name-the-feature.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["parallel", "agent", "agent"]);
    const fan = t.steps[0] as Fanout;
    expect(fan.multiplicity).toEqual({
      kind: "named",
      names: ["literal", "playful", "metaphorical"],
    });
    expect((fan.body[0] as AgentStep).expandedLabels).toEqual([
      "gen:literal",
      "gen:playful",
      "gen:metaphorical",
    ]);
  });

  it("choose-approach: draft fan-out → while(bracket) > for(i) tournament → write-up agent", () => {
    const t = analyzeExample("choose-approach.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["parallel", "loop", "agent"]);

    const fan = t.steps[0] as Fanout;
    expect(fan.multiplicity).toEqual({
      kind: "named",
      names: ["simplest", "most scalable", "least risky", "fastest to ship"],
    });
    expect((fan.body[0] as AgentStep).expandedLabels).toEqual([
      "draft:simplest",
      "draft:most scalable",
      "draft:least risky",
      "draft:fastest to ship",
    ]);

    const outer = t.steps[1] as LoopStep;
    expect(outer.loopKind).toBe("while");
    expect(outer.conditionLabel).toBe("bracket.length > 1");
    expect(outer.phase).toBe("Judge pairwise");
    expect(outer.body.map((s) => s.kind)).toEqual(["loop"]);

    const inner = outer.body[0] as LoopStep;
    expect(inner.loopKind).toBe("for");
    expect(inner.conditionLabel).toBe("i < bracket.length");
    expect(inner.body.map((s) => s.kind)).toEqual(["branch", "agent"]);
    const bye = inner.body[0] as BranchStep;
    expect(bye.conditionLabel).toBe("!b");
    expect(bye.thenSteps.map((s) => s.kind)).toEqual(["control"]);
    expect((bye.thenSteps[0] as ControlStep).label).toBe("continue loop");
    const match = inner.body[1] as AgentStep;
    expect(match.label).toBe("match:${i / 2}");
    expect(match.phase).toBe("Judge pairwise");
  });

  it("hunt-bugs: one while loop spanning bands, with dry-path control and verify fan-out", () => {
    const t = analyzeExample("hunt-bugs.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["loop"]);
    const loop = t.steps[0] as LoopStep;
    expect(loop.loopKind).toBe("while");
    expect(loop.conditionLabel.startsWith("dryRounds < 2 &&")).toBe(true);
    expect(loop.conditionLabel.endsWith("…")).toBe(true); // COND_MAX-truncated, verbatim
    expect(loop.phase).toBe("Find a round of bugs");
    expect(loop.body.map((s) => s.kind)).toEqual(["agent", "branch", "parallel"]);
    expect(loop.body[0].phase).toBe("Find a round of bugs");
    const dry = loop.body[1] as BranchStep;
    expect(dry.conditionLabel).toBe("fresh.length === 0");
    expect(dry.thenSteps.map((s) => s.kind)).toEqual(["control"]);
    expect((dry.thenSteps[0] as ControlStep).label).toBe("continue loop");
    expect((dry.thenSteps[0] as ControlStep).flow).toBe("continue");
    expect(dry.elseSteps).toEqual([]);
    const fan = loop.body[2] as Fanout;
    expect(fan.phase).toBe("Verify and bank the survivors"); // the loop spans bands
    expect(fan.multiplicity).toEqual({ kind: "unknown", hint: "fresh" });
    expect(fan.body.map((s) => s.kind)).toEqual(["agent"]);
    expect((fan.body[0] as AgentStep).label).toBe("verify:${b.id}");
  });

  it("dual-lineage-review: agent → two-branch parallel (claude + codex lanes) → agent", () => {
    const t = analyzeExample("dual-lineage-review.js");
    expect(t.steps.map((s) => s.kind)).toEqual(["agent", "parallel", "agent"]);
    const par = t.steps[1] as Branches;
    expect(par.form).toBe("branches");
    expect(par.branches.map((b) => b.map((s) => s.kind))).toEqual([["agent"], ["agent"]]);
    const claude = par.branches[0][0] as AgentStep;
    expect(claude.label).toBe("review:claude");
    expect(claude.phase).toBe("Claude review");
    expect(claude.multiplicity).toEqual({ kind: "one" });
    const external = par.branches[1][0] as AgentStep;
    expect(external.label).toBe("review:external");
    expect(external.agentType).toBe("codex");
    expect(external.phase).toBe("External review");
  });
});
