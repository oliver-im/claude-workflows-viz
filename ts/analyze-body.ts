import type * as acorn from "acorn";
import { tryEvalLiteral } from "./extract-meta.js";
import {
  type AgentStep,
  type AnalysisNote,
  type BandRef,
  type ControlStep,
  type LoopStep,
  type Multiplicity,
  type OpaqueStep,
  type ParallelStep,
  type PipelineStep,
  type SourceSpan,
  type Step,
  type Topology,
  type WorkflowStep,
  COND_MAX,
  HINT_MAX,
  LABEL_MAX,
  OPAQUE_LABEL_MAX,
  PROMPT_PREVIEW_MAX,
  sliceSource,
} from "./topology.js";
import { truncatePlain } from "./svg-primitives.js";

/**
 * Statically analyze a workflow body into the tree IR (`Topology`). The
 * workflow is NEVER executed: everything here is read off the acorn AST as
 * data, and the only value-level reasoning anywhere is `tryEvalLiteral` on
 * module-level `const` initializers (pure data literals — code is rejected,
 * not run).
 *
 * The analyzer is a TOTAL function: it never throws on weird-but-valid JS.
 * Every statement is walked inside a try/catch, and anything it cannot read
 * structurally degrades honestly — an `OpaqueStep` (visible blob) and/or an
 * `AnalysisNote` — never a silent drop.
 *
 * Recognized vocabulary: `phase()` markers, `agent()`/`workflow()` calls,
 * chained-call unwrapping, `parallel()` (thunk-array branches and `.map`
 * fan-outs), `pipeline(items, ...stages)`, loops, and if/ternary branches.
 * Fan-out parameters shadow module consts for the body they bind in — the
 * one soundness rule in const resolution.
 */
export function analyzeBody(
  program: acorn.Node,
  src: string,
  metaPhases: readonly string[],
): Topology {
  const ctx: Ctx = {
    src,
    consts: collectModuleConsts(program),
    shadowed: new Set(),
    bands: metaPhases.map((title) => ({ title, inMeta: true })),
    notes: [],
    ambientPhase: null,
    fanoutMult: null,
    expansion: null,
  };
  const steps = walkStatements(ctx, (program as any).body ?? []);
  return {
    steps,
    bands: ctx.bands,
    notes: ctx.notes,
    hasOrchestration: stepsHaveOrchestration(steps),
  };
}

// ---------------------------------------------------------------------------
// Walk state
// ---------------------------------------------------------------------------

interface Ctx {
  src: string;
  /** Module-level `const` name → literal value (pass 1). */
  consts: Map<string, unknown>;
  /** Names rebound lexically (fan-out/stage/loop parameters) — never resolved as consts. */
  shadowed: Set<string>;
  /** Meta phases first (`inMeta: true`), body-only titles appended in first lexical occurrence order. */
  bands: BandRef[];
  notes: AnalysisNote[];
  /**
   * The band in lexical effect — `phase("…")` statement markers mutate it.
   * Sequential regions (blocks, loop bodies, try blocks) leak it onward;
   * conditional/per-lane regions (branch arms, catch handlers, parallel
   * lanes, pipeline stages) restore it on exit (`withScopedPhase`).
   */
  ambientPhase: string | null;
  /** Fan-out width threaded onto agent/workflow steps produced inside a `.map` body. */
  fanoutMult: Multiplicity | null;
  /** Label-expansion context: named lanes + the bare parameter to substitute. */
  expansion: { param: string; names: readonly string[] } | null;
}

/**
 * Walk a conditional or per-lane region: its `phase()` markers band its own
 * steps only — the ambient phase is restored on exit. Sequential regions
 * (blocks, loop bodies, try blocks) deliberately leak instead: their markers
 * really are in effect for everything after them.
 */
function withScopedPhase<T>(ctx: Ctx, fn: () => T): T {
  const before = ctx.ambientPhase;
  try {
    return fn();
  } finally {
    ctx.ambientPhase = before;
  }
}

/** Shadow `names` for the duration of `fn` (names already shadowed stay shadowed after). */
function withShadowed<T>(ctx: Ctx, names: readonly string[], fn: () => T): T {
  const added: string[] = [];
  for (const n of names) {
    if (!ctx.shadowed.has(n)) {
      ctx.shadowed.add(n);
      added.push(n);
    }
  }
  try {
    return fn();
  } finally {
    for (const n of added) ctx.shadowed.delete(n);
  }
}

/**
 * Enter a fan-out/stage body: replace (not inherit) the threading context.
 * `mult: null` for pipeline stages — the flattener applies lane multiplicity
 * there; `expansion: null` whenever the lanes aren't named.
 */
function withFanout<T>(
  ctx: Ctx,
  mult: Multiplicity | null,
  expansion: Ctx["expansion"],
  fn: () => T,
): T {
  const prevMult = ctx.fanoutMult;
  const prevExp = ctx.expansion;
  ctx.fanoutMult = mult;
  ctx.expansion = expansion;
  try {
    return fn();
  } finally {
    ctx.fanoutMult = prevMult;
    ctx.expansion = prevExp;
  }
}

/** Collect every bound Identifier name in a binding pattern. */
function collectPatternNames(node: any, out: string[]): void {
  if (!node || typeof node !== "object") return;
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      return;
    case "ObjectPattern":
      for (const p of node.properties ?? []) {
        collectPatternNames(p.type === "Property" ? p.value : p.argument, out);
      }
      return;
    case "ArrayPattern":
      for (const el of node.elements ?? []) collectPatternNames(el, out);
      return;
    case "AssignmentPattern":
      collectPatternNames(node.left, out);
      return;
    case "RestElement":
      collectPatternNames(node.argument, out);
      return;
    default:
      return;
  }
}

const isFn = (n: any): boolean =>
  n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression";

const spanOf = (node: any): SourceSpan => ({ start: node.start, end: node.end });

function note(ctx: Ctx, message: string, node?: any): void {
  ctx.notes.push({
    message,
    ...(node
      ? { span: spanOf(node), snippet: sliceSource(ctx.src, spanOf(node), OPAQUE_LABEL_MAX) }
      : {}),
  });
}

/** Label an opaque step with the (collapsed, truncated) first source line. */
function opaqueLabel(ctx: Ctx, node: any): string {
  const nl = ctx.src.indexOf("\n", node.start);
  const end = nl === -1 || nl > node.end ? node.end : nl;
  return sliceSource(ctx.src, { start: node.start, end }, OPAQUE_LABEL_MAX);
}

function opaque(ctx: Ctx, node: any): OpaqueStep {
  return { kind: "opaque", label: opaqueLabel(ctx, node), phase: ctx.ambientPhase, span: spanOf(node) };
}

function control(ctx: Ctx, node: any, label: string, flow: ControlStep["flow"]): ControlStep {
  return {
    kind: "control",
    label,
    flow,
    phase: ctx.ambientPhase,
    span: spanOf(node),
    tooltip: sliceSource(ctx.src, spanOf(node), PROMPT_PREVIEW_MAX),
  };
}

function registerBand(ctx: Ctx, title: string): void {
  if (!ctx.bands.some((b) => b.title === title)) {
    ctx.bands.push({ title, inMeta: false });
  }
}

/** Collapse whitespace runs in a literal VALUE (sliceSource does it for source text). */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** String value of a `Literal` string or a no-substitution template, else undefined. */
function stringLiteralValue(node: any): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pass 1 — module consts
// ---------------------------------------------------------------------------

/**
 * Collect top-level (incl. `export const`) const declarators whose
 * initializer is a pure data literal. Runs fully before the statement walk,
 * so lookups are order-independent (a const declared below its use still
 * resolves). `let`/`var` are never trusted — they are reassignable, so their
 * "current value" is not a static fact.
 */
export function collectModuleConsts(program: acorn.Node): Map<string, unknown> {
  const consts = new Map<string, unknown>();
  for (const node of (program as any).body ?? []) {
    const decl =
      node.type === "VariableDeclaration"
        ? node
        : node.type === "ExportNamedDeclaration" &&
            node.declaration?.type === "VariableDeclaration"
          ? node.declaration
          : null;
    if (!decl || decl.kind !== "const") continue;
    for (const d of decl.declarations) {
      try {
        if (d.id?.type !== "Identifier" || d.id.name === "meta" || !d.init) continue;
        const result = tryEvalLiteral(d.init);
        if (result.ok) consts.set(d.id.name, result.value);
      } catch {
        // Totality: a weird declarator never aborts const collection.
      }
    }
  }
  return consts;
}

// ---------------------------------------------------------------------------
// Orchestration gate
// ---------------------------------------------------------------------------

const ORCHESTRATION_CALLEES = new Set(["agent", "parallel", "pipeline", "workflow"]);

/**
 * Does this subtree contain a bare `agent(…)`/`parallel(…)`/`pipeline(…)`/
 * `workflow(…)` call? Descends into nested function bodies. Used ONLY as the
 * emit/skip gate: orchestrating-but-unreadable constructs become opaque
 * steps; non-orchestrating ones (logs, budget reads) emit nothing.
 */
export function containsOrchestration(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(containsOrchestration);
  if (typeof node.type !== "string") return false; // RegExp values etc. — not AST nodes
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    ORCHESTRATION_CALLEES.has(node.callee.name)
  ) {
    return true;
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (containsOrchestration(node[key])) return true;
  }
  return false;
}

/**
 * Collect every bare `phase(…)` call in a subtree — same descent rules as
 * `containsOrchestration`. A marker only sets a band as a statement-level
 * call in walked flow; one in a subtree the walk abandons (dropped, opaqued,
 * or never entered) silently loses its effect unless noted.
 */
function collectPhaseCalls(node: any, out: any[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const el of node) collectPhaseCalls(el, out);
    return;
  }
  if (typeof node.type !== "string") return; // RegExp values etc. — not AST nodes
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "phase"
  ) {
    out.push(node);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    collectPhaseCalls(node[key], out);
  }
}

/**
 * One note per phase() marker lost in an abandoned subtree — a missing band
 * is a real loss even when the region itself is already an opaque step.
 */
function notePhaseMarkerDrops(ctx: Ctx, node: any): void {
  const calls: any[] = [];
  collectPhaseCalls(node, calls);
  for (const call of calls) {
    note(
      ctx,
      "phase() marker in expression position or an untraced region; it never sets the band",
      call,
    );
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — statement walk
// ---------------------------------------------------------------------------

function walkStatements(ctx: Ctx, stmts: readonly any[]): Step[] {
  const steps: Step[] = [];
  for (const stmt of stmts) {
    try {
      steps.push(...walkStatement(ctx, stmt));
    } catch (e) {
      // Totality: an analyzer bug on one statement degrades that statement,
      // never the whole analysis.
      let orchestrates = true;
      try {
        orchestrates = containsOrchestration(stmt);
      } catch {
        // keep true — err on the visible side
      }
      note(ctx, `analyzer error on a statement: ${(e as Error).message}`, stmt);
      if (orchestrates) steps.push(opaque(ctx, stmt));
    }
  }
  return steps;
}

function walkStatement(ctx: Ctx, stmt: any): Step[] {
  switch (stmt.type) {
    case "ImportDeclaration":
      return [];

    case "ExportNamedDeclaration":
      // `export const meta = …` / exported consts — analyze the inner
      // declaration as if unexported. A bare `export { x }` has none.
      return stmt.declaration ? walkStatement(ctx, stmt.declaration) : [];

    case "VariableDeclaration": {
      const steps: Step[] = [];
      for (const d of stmt.declarations) {
        // The meta block is extract-meta's business, not a flow step.
        if (d.id?.type === "Identifier" && d.id.name === "meta") continue;
        if (!d.init) continue;
        // The binding pattern (Identifier/ObjectPattern/ArrayPattern) is
        // irrelevant — the flow lives in the initializer. Gate per INIT, not
        // per statement, so one recognized declarator can't mask
        // orchestration hiding in a sibling.
        steps.push(...walkGated(ctx, d.init, "initializer"));
      }
      return steps;
    }

    case "ReturnStatement":
      // Reached inside thunk/stage block bodies — the returned expression is
      // the branch's flow. (Invalid at module top level, so harmless there.)
      return stmt.argument ? walkGated(ctx, stmt.argument, "return value") : [];

    case "ExpressionStatement":
      return walkExpressionStatement(ctx, stmt);

    case "BlockStatement":
      // Same ambient phase on purpose: `phase()` markers take lexical effect
      // and leak past the block, exactly like the runtime's ambient phase.
      return walkStatements(ctx, stmt.body);

    case "TryStatement": {
      const steps = walkStatements(ctx, stmt.block.body);
      const catchNames: string[] = [];
      collectPatternNames(stmt.handler?.param, catchNames);
      for (const part of [stmt.handler?.body, stmt.finalizer]) {
        if (!part) continue;
        if (containsOrchestration(part)) {
          note(
            ctx,
            "try/catch flattened: steps from a catch/finally block are drawn in the main flow",
            part,
          );
          if (part === stmt.handler?.body) {
            // A handler only runs on a throw — its markers are conditional.
            steps.push(
              ...withScopedPhase(ctx, () =>
                withShadowed(ctx, catchNames, () => walkStatements(ctx, part.body)),
              ),
            );
          } else {
            // A finalizer always runs — its markers leak like sequential flow.
            steps.push(...walkStatements(ctx, part.body));
          }
        } else {
          notePhaseMarkerDrops(ctx, part);
        }
      }
      return steps;
    }

    case "FunctionDeclaration": {
      // Helper functions are never traced into — their call sites decide the
      // flow, and those are opaque to a static reading.
      if (containsOrchestration(stmt.body)) {
        const name = stmt.id?.name ?? "(anonymous)";
        note(ctx, `helper '${name}' contains agent calls; not traced`, stmt);
      }
      notePhaseMarkerDrops(ctx, stmt.body);
      return [];
    }

    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement":
    case "ForOfStatement":
    case "ForInStatement":
      return loopSteps(ctx, stmt);

    case "IfStatement":
      return branchSteps(ctx, stmt);

    default:
      notePhaseMarkerDrops(ctx, stmt);
      if (containsOrchestration(stmt)) {
        note(
          ctx,
          `unrecognized statement (${stmt.type}) contains orchestration; rendered as one opaque step`,
          stmt,
        );
        return [opaque(ctx, stmt)];
      }
      return [];
  }
}

function walkExpressionStatement(ctx: Ctx, stmt: any): Step[] {
  const expr = stmt.expression;

  // A bare `phase("Title")` statement is the band marker.
  if (
    expr?.type === "CallExpression" &&
    expr.callee?.type === "Identifier" &&
    expr.callee.name === "phase"
  ) {
    const title = stringLiteralValue(expr.arguments?.[0]);
    if (expr.arguments?.length === 1 && title !== undefined) {
      ctx.ambientPhase = title;
      registerBand(ctx, title);
    } else {
      note(ctx, "phase() marker without a single string-literal title; band unchanged", expr);
    }
    return [];
  }

  return walkGated(ctx, expr, "expression"); // log(…), budget.* — nothing to draw
}

/**
 * Walk an expression through the honesty gate: recognized steps pass through;
 * an unrecognized-but-orchestrating expression degrades to one opaque step +
 * note; markers inside an abandoned expression are accounted for either way.
 */
function walkGated(ctx: Ctx, expr: any, what: string): Step[] {
  const got = walkExpression(ctx, expr);
  if (got.length > 0) return got;
  if (containsOrchestration(expr)) {
    note(ctx, `orchestration inside an unrecognized ${what}; rendered as one opaque step`, expr);
    notePhaseMarkerDrops(ctx, expr);
    return [opaque(ctx, expr)];
  }
  notePhaseMarkerDrops(ctx, expr);
  return [];
}

/** Skip a non-orchestrating region, still accounting for markers inside it. */
function skipScanned(ctx: Ctx, node: any): Step[] {
  if (node) notePhaseMarkerDrops(ctx, node);
  return [];
}

function containsAbruptControl(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(containsAbruptControl);
  switch (node.type) {
    case "ContinueStatement":
    case "BreakStatement":
    case "ReturnStatement":
    case "ThrowStatement":
      return true;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return false;
    default:
      for (const key of Object.keys(node)) {
        if (key === "type" || key === "start" || key === "end") continue;
        if (containsAbruptControl(node[key])) return true;
      }
      return false;
  }
}

function controlSteps(ctx: Ctx, node: any): Step[] {
  if (!node || typeof node !== "object") return [];
  switch (node.type) {
    case "BlockStatement":
      return (node.body ?? []).flatMap((stmt: any) => controlSteps(ctx, stmt));
    case "ContinueStatement":
      return [control(ctx, node, "continue loop", "continue")];
    case "BreakStatement":
      return [control(ctx, node, "break loop", "break")];
    case "ReturnStatement": {
      const label = node.argument
        ? `return ${sliceSource(ctx.src, spanOf(node.argument), HINT_MAX)}`
        : "return";
      return [control(ctx, node, label, "return")];
    }
    case "ThrowStatement":
      return [control(ctx, node, "throw", "throw")];
    case "IfStatement": {
      const nested = [
        ...controlSteps(ctx, node.consequent),
        ...(node.alternate ? controlSteps(ctx, node.alternate) : []),
      ];
      return nested.length > 0
        ? [
            control(
              ctx,
              node,
              `if ${sliceSource(ctx.src, spanOf(node.test), HINT_MAX)}`,
              undefined,
            ),
            ...nested,
          ]
        : [];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Structural recognizers — loops & branches
// ---------------------------------------------------------------------------

const LOOP_KINDS: Record<string, LoopStep["loopKind"]> = {
  WhileStatement: "while",
  DoWhileStatement: "do-while",
  ForStatement: "for",
  ForOfStatement: "for-of",
  ForInStatement: "for-in",
};

/**
 * A loop whose body orchestrates becomes a `LoopStep`; orchestration in the
 * test/collection runs (at least once) before the body, so it is prepended as
 * its own steps. The condition label is a verbatim truncated source slice.
 */
function loopSteps(ctx: Ctx, stmt: any): Step[] {
  if (!containsOrchestration(stmt)) return skipScanned(ctx, stmt);
  const phase = ctx.ambientPhase;
  const pre: Step[] = [];
  const shadowNames: string[] = [];
  let conditionLabel: string;
  let conditionTooltip: string;
  let iterations: number | undefined;

  if (stmt.type === "ForOfStatement" || stmt.type === "ForInStatement") {
    // "const m of MODULES" — left-through-right slice.
    const conditionSpan = { start: stmt.left.start, end: stmt.right.end };
    conditionLabel = sliceSource(ctx.src, conditionSpan, COND_MAX);
    conditionTooltip = collapseWs(ctx.src.slice(conditionSpan.start, conditionSpan.end));
    if (stmt.type === "ForOfStatement") {
      const m = resolveMultiplicity(stmt.right, ctx);
      if (m.kind === "exact") iterations = m.count;
      else if (m.kind === "named") iterations = m.names.length;
    }
    pre.push(
      ...(containsOrchestration(stmt.right)
        ? walkGated(ctx, stmt.right, "loop collection")
        : skipScanned(ctx, stmt.right)),
    );
    collectPatternNames(
      stmt.left?.type === "VariableDeclaration" ? stmt.left.declarations?.[0]?.id : stmt.left,
      shadowNames,
    );
  } else if (stmt.type === "ForStatement") {
    const conditionSpan = stmt.test ? spanOf(stmt.test) : { start: stmt.start, end: stmt.body.start };
    conditionLabel = sliceSource(ctx.src, conditionSpan, COND_MAX);
    conditionTooltip = collapseWs(ctx.src.slice(conditionSpan.start, conditionSpan.end));
    if (stmt.test) {
      pre.push(
        ...(containsOrchestration(stmt.test)
          ? walkGated(ctx, stmt.test, "loop condition")
          : skipScanned(ctx, stmt.test)),
      );
    }
    for (const part of [stmt.init, stmt.update]) {
      if (!part) continue;
      if (containsOrchestration(part)) {
        note(ctx, "loop header contains orchestration; not traced", part);
      }
      notePhaseMarkerDrops(ctx, part);
    }
    if (stmt.init?.type === "VariableDeclaration") {
      for (const d of stmt.init.declarations ?? []) collectPatternNames(d.id, shadowNames);
    }
  } else {
    const conditionSpan = spanOf(stmt.test);
    conditionLabel = sliceSource(ctx.src, conditionSpan, COND_MAX);
    conditionTooltip = collapseWs(ctx.src.slice(conditionSpan.start, conditionSpan.end));
    pre.push(
      ...(containsOrchestration(stmt.test)
        ? walkGated(ctx, stmt.test, "loop condition")
        : skipScanned(ctx, stmt.test)),
    );
  }

  const bodyStmts = stmt.body?.type === "BlockStatement" ? stmt.body.body : [stmt.body];
  const body = withShadowed(ctx, shadowNames, () => walkStatements(ctx, bodyStmts));
  if (body.length === 0) {
    // All the orchestration lived in the header — nothing to arc back over.
    return pre;
  }
  const loop: Step = {
    kind: "loop",
    loopKind: LOOP_KINDS[stmt.type],
    conditionLabel,
    conditionTooltip,
    ...(iterations !== undefined ? { iterations } : {}),
    body,
    phase,
    span: spanOf(stmt),
  };
  // A do-while runs its body before the first test — its test steps follow
  // the loop instead of preceding it (execution-order honesty).
  return stmt.type === "DoWhileStatement" ? [loop, ...pre] : [...pre, loop];
}

/**
 * An `if` with orchestration in at least one arm becomes a `BranchStep`.
 * Non-orchestrating arms that abruptly alter control flow (`continue`,
 * `return`, etc.) are kept as explicit control nodes because they explain
 * which path does not continue to later steps. A logs-only `if` is omitted
 * entirely. Orchestration in the test runs first — prepended.
 */
function branchSteps(ctx: Ctx, stmt: any): Step[] {
  const thenOrch = containsOrchestration(stmt.consequent);
  const elseOrch = stmt.alternate ? containsOrchestration(stmt.alternate) : false;
  const thenControl = !thenOrch && containsAbruptControl(stmt.consequent);
  const elseControl = !elseOrch && stmt.alternate ? containsAbruptControl(stmt.alternate) : false;
  if (!thenOrch && !elseOrch && !thenControl && !elseControl) {
    if (containsOrchestration(stmt.test)) {
      const pre = walkGated(ctx, stmt.test, "branch condition");
      notePhaseMarkerDrops(ctx, stmt.consequent);
      if (stmt.alternate) notePhaseMarkerDrops(ctx, stmt.alternate);
      return pre;
    }
    return skipScanned(ctx, stmt);
  }
  const phase = ctx.ambientPhase;
  const pre = containsOrchestration(stmt.test)
    ? walkGated(ctx, stmt.test, "branch condition")
    : skipScanned(ctx, stmt.test);
  const walkArm = (arm: any, orch: boolean, keepControl: boolean): Step[] => {
    if (!arm) return [];
    if (keepControl) {
      return withScopedPhase(ctx, () => {
        notePhaseMarkerDrops(ctx, arm);
        return controlSteps(ctx, arm);
      });
    }
    if (!orch) return skipScanned(ctx, arm);
    // Arms are alternative futures — a marker in one must not band the other
    // (or anything after the branch).
    return withScopedPhase(ctx, () =>
      walkStatements(ctx, arm.type === "BlockStatement" ? arm.body : [arm]),
    );
  };
  return [
    ...pre,
    {
      kind: "branch",
      conditionLabel: sliceSource(ctx.src, spanOf(stmt.test), COND_MAX),
      thenSteps: walkArm(stmt.consequent, thenOrch, thenControl),
      elseSteps: walkArm(stmt.alternate, elseOrch, elseControl),
      phase,
      span: spanOf(stmt),
    },
  ];
}

// ---------------------------------------------------------------------------
// Expression recognizers
// ---------------------------------------------------------------------------

function walkExpression(ctx: Ctx, node: any): Step[] {
  if (!node || typeof node !== "object") return [];

  if (node.type === "AwaitExpression") return walkExpression(ctx, node.argument);
  // Optional chains (`agent?.(…)`) parse wrapped in a ChainExpression.
  if (node.type === "ChainExpression") return walkExpression(ctx, node.expression);
  // `bracket = await agent(…)` — the flow lives in the right-hand side.
  if (node.type === "AssignmentExpression") return walkExpression(ctx, node.right);

  // A ternary with orchestration in at least one arm is a branch.
  if (node.type === "ConditionalExpression") {
    const thenOrch = containsOrchestration(node.consequent);
    const elseOrch = containsOrchestration(node.alternate);
    if (!thenOrch && !elseOrch) {
      // Not a branch — the enclosing gate decides what to do with the rest.
      return [];
    }
    const phase = ctx.ambientPhase;
    const pre = containsOrchestration(node.test)
      ? walkGated(ctx, node.test, "branch condition")
      : skipScanned(ctx, node.test);
    const walkArm = (arm: any, orch: boolean): Step[] =>
      orch ? walkGated(ctx, arm, "branch arm") : skipScanned(ctx, arm);
    return [
      ...pre,
      {
        kind: "branch",
        conditionLabel: sliceSource(ctx.src, spanOf(node.test), COND_MAX),
        thenSteps: walkArm(node.consequent, thenOrch),
        elseSteps: walkArm(node.alternate, elseOrch),
        phase,
        span: spanOf(node),
      },
    ];
  }

  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    containsOrchestration(node.callee.object)
  ) {
    // Unwrap chained calls on an orchestrating expression — `agent(…).then(cb)`,
    // `(await parallel(…)).filter(Boolean)`: the object IS the flow; the chained
    // call only post-processes its result. An orchestrating callback argument is
    // its own flow the chain hides — degrade it visibly.
    const steps = walkExpression(ctx, node.callee.object);
    if (steps.length === 0) {
      // The object orchestrates but wasn't recognized — degrade IT here, so a
      // recognized callback opaque below can't mask it from the statement gate.
      note(ctx, "orchestration inside an unrecognized chained expression; rendered as one opaque step", node.callee.object);
      steps.push(opaque(ctx, node.callee.object));
    }
    for (const arg of node.arguments ?? []) {
      if (arg && containsOrchestration(arg)) {
        note(ctx, "callback on a chained call contains orchestration; rendered as one opaque step", arg);
        steps.push(opaque(ctx, arg));
      }
      if (arg) notePhaseMarkerDrops(ctx, arg);
    }
    return steps;
  }

  if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
    switch (node.callee.name) {
      case "agent":
        return [agentStep(ctx, node)];
      case "workflow":
        return [workflowStep(ctx, node)];
      case "parallel":
        return [parallelStep(ctx, node)];
      case "pipeline":
        return [pipelineStep(ctx, node)];
      // A phase() call here is expression position — the abandoned-subtree
      // scans at the statement/init/argument exits note the dropped marker.
      default:
        return [];
    }
  }

  return []; // the statement-level gate decides opaqueness
}

/** Walk a function's body: expression body through the gate, block body as statements. */
function walkFunctionBody(ctx: Ctx, fn: any, what: string): Step[] {
  if (fn.body?.type === "BlockStatement") return walkStatements(ctx, fn.body.body);
  return walkGated(ctx, fn.body, what);
}

/** Walk one parallel-branches thunk (params shadowed; phase scoped per lane). */
function walkThunk(ctx: Ctx, fn: any, what: string): Step[] {
  const names: string[] = [];
  for (const p of fn.params ?? []) collectPatternNames(p, names);
  return withScopedPhase(ctx, () =>
    withShadowed(ctx, names, () => walkFunctionBody(ctx, fn, what)),
  );
}

/**
 * `parallel(arg)`: a literal thunk array is k distinct branches; a
 * `<collection>.map(cb)` is a fan-out whose width is the collection's
 * multiplicity (resolved BEFORE the callback parameter shadows anything).
 * The conventional double arrow (`item => () => agent(…)`) unwraps; a
 * single un-thunked arrow is tolerated. Anything else degrades honestly.
 */
function parallelStep(ctx: Ctx, call: any): ParallelStep {
  const base = { kind: "parallel" as const, phase: ctx.ambientPhase, span: spanOf(call) };
  const arg = call.arguments?.[0];

  if (arg?.type === "ArrayExpression") {
    const branches: Step[][] = (arg.elements ?? []).map((el: any) => {
      if (isFn(el)) return walkThunk(ctx, el, "parallel branch");
      const at = el ?? arg;
      note(ctx, "parallel branch is not an inline function; rendered as one opaque step", at);
      notePhaseMarkerDrops(ctx, el);
      return [opaque(ctx, at)];
    });
    return { ...base, form: "branches", branches };
  }

  if (
    arg?.type === "CallExpression" &&
    arg.callee?.type === "MemberExpression" &&
    !arg.callee.computed &&
    arg.callee.property?.type === "Identifier" &&
    arg.callee.property.name === "map"
  ) {
    const collection = arg.callee.object;
    const multiplicity = resolveMultiplicity(collection, ctx);
    if (containsOrchestration(collection)) {
      note(ctx, "fan-out collection contains orchestration; not traced", collection);
      notePhaseMarkerDrops(ctx, collection);
    }
    const cb = arg.arguments?.[0];
    if (!isFn(cb)) {
      note(ctx, "fan-out callback is not an inline function; lanes not traced", arg);
      notePhaseMarkerDrops(ctx, cb);
      return { ...base, form: "fanout", multiplicity, body: [] };
    }
    const paramNames: string[] = [];
    for (const p of cb.params ?? []) collectPatternNames(p, paramNames);
    const fanoutParam = cb.params?.[0]?.type === "Identifier" ? cb.params[0].name : undefined;
    const expansion =
      multiplicity.kind === "named" && fanoutParam !== undefined
        ? { param: fanoutParam, names: multiplicity.names }
        : null;
    // Double-arrow unwrap: `(item) => () => agent(…)` — the thunk is the body.
    const inner = isFn(cb.body) && (cb.body.params ?? []).length === 0 ? cb.body : cb;
    const body = withScopedPhase(ctx, () =>
      withShadowed(ctx, paramNames, () =>
        withFanout(ctx, multiplicity, expansion, () => walkFunctionBody(ctx, inner, "fan-out body")),
      ),
    );
    return { ...base, form: "fanout", multiplicity, body };
  }

  note(ctx, "parallel() argument is neither a thunk array nor a .map fan-out; not traced", arg ?? call);
  notePhaseMarkerDrops(ctx, arg);
  return {
    ...base,
    form: "fanout",
    multiplicity: arg ? unknownMult(ctx, arg) : { kind: "unknown" },
    body: [],
  };
}

/**
 * `pipeline(items, ...stages)`: items' multiplicity is the lane count; each
 * function stage walks with its params shadowed. The first param is the stage
 * parameter — with named items, label templates over it expand per lane (the
 * flattener applies lane multiplicity to stage nodes; the analyzer does not).
 */
function pipelineStep(ctx: Ctx, call: any): PipelineStep {
  const phase = ctx.ambientPhase;
  const args: any[] = call.arguments ?? [];
  const itemsArg = args[0];
  const items: Multiplicity = itemsArg ? resolveMultiplicity(itemsArg, ctx) : { kind: "unknown" };
  if (itemsArg) {
    if (containsOrchestration(itemsArg)) {
      note(ctx, "pipeline items expression contains orchestration; not traced", itemsArg);
    }
    notePhaseMarkerDrops(ctx, itemsArg);
  }
  const stages: Step[][] = args.slice(1).map((st: any) => {
    if (!isFn(st)) {
      const at = st ?? call;
      note(ctx, "pipeline stage is not an inline function; rendered as one opaque step", at);
      notePhaseMarkerDrops(ctx, st);
      return [opaque(ctx, at)];
    }
    const paramNames: string[] = [];
    for (const p of st.params ?? []) collectPatternNames(p, paramNames);
    const stageParam = st.params?.[0]?.type === "Identifier" ? st.params[0].name : undefined;
    const expansion =
      items.kind === "named" && stageParam !== undefined
        ? { param: stageParam, names: items.names }
        : null;
    return withScopedPhase(ctx, () =>
      withShadowed(ctx, paramNames, () =>
        withFanout(ctx, null, expansion, () => walkFunctionBody(ctx, st, "pipeline stage")),
      ),
    );
  });
  return { kind: "pipeline", items, stages, phase, span: spanOf(call) };
}

function agentStep(ctx: Ctx, call: any): AgentStep {
  const promptArg = call.arguments?.[0];
  const optsArg = call.arguments?.[1];

  // Nested orchestration inside arguments (e.g. an agent call interpolated
  // into the prompt) is real flow this step doesn't draw — say so.
  for (const arg of call.arguments ?? []) {
    if (arg && containsOrchestration(arg)) {
      note(ctx, "agent() arguments contain nested orchestration; not traced", arg);
    }
    if (arg) notePhaseMarkerDrops(ctx, arg);
  }

  let optLabel: string | undefined;
  let labelTemplate: any; // the raw TemplateLiteral node, kept for expansion
  let model: string | undefined;
  let agentType: string | undefined;
  let optPhase: string | undefined;

  if (optsArg) {
    if (optsArg.type !== "ObjectExpression") {
      note(ctx, "agent() options are not an inline object literal; label/model/phase unread", optsArg);
    } else {
      for (const prop of optsArg.properties) {
        if (prop.type !== "Property" || prop.computed) {
          note(ctx, "agent() options contain a spread or computed key; those options are unread", prop);
          continue;
        }
        const key =
          prop.key.type === "Identifier"
            ? prop.key.name
            : prop.key.type === "Literal"
              ? String(prop.key.value)
              : undefined;
        switch (key) {
          case "label": {
            const lit = stringLiteralValue(prop.value);
            if (lit !== undefined) {
              optLabel = truncatePlain(collapseWs(lit), LABEL_MAX);
            } else if (prop.value.type === "TemplateLiteral") {
              // Verbatim inner source slice — `refute:${lens}` stays exactly that.
              optLabel = sliceSource(
                ctx.src,
                { start: prop.value.start + 1, end: prop.value.end - 1 },
                LABEL_MAX,
              );
              labelTemplate = prop.value;
            } else {
              note(ctx, "agent label is not a string or template literal; using the prompt", prop.value);
            }
            break;
          }
          case "model": {
            const lit = stringLiteralValue(prop.value);
            if (lit !== undefined) model = lit;
            else note(ctx, "agent model is not a string literal; model unread", prop.value);
            break;
          }
          case "agentType": {
            const lit = stringLiteralValue(prop.value);
            if (lit !== undefined) agentType = lit;
            else note(ctx, "agent agentType is not a string literal; unread", prop.value);
            break;
          }
          case "phase": {
            const lit = stringLiteralValue(prop.value);
            if (lit !== undefined) {
              optPhase = lit;
            } else {
              note(
                ctx,
                "agent phase is not a string literal; using the ambient phase",
                prop.value,
              );
            }
            break;
          }
          default:
            break; // schema etc. — no visual meaning
        }
      }
    }
  }

  // Label precedence: opts.label > prompt literal/template-head > "agent".
  let label = optLabel;
  if (label === undefined && promptArg) {
    const lit = stringLiteralValue(promptArg);
    if (lit !== undefined) {
      label = truncatePlain(collapseWs(lit), LABEL_MAX);
    } else if (promptArg.type === "TemplateLiteral") {
      const head = collapseWs(promptArg.quasis[0]?.value.cooked ?? "");
      if (head !== "") {
        // "…" marks the elided expressions; truncatePlain re-caps if the head
        // itself is over-length.
        label = truncatePlain(`${head}…`, LABEL_MAX);
      }
    }
  }
  if (label === undefined) label = "agent";

  let promptPreview: string | undefined;
  if (promptArg) {
    const lit = stringLiteralValue(promptArg);
    if (lit !== undefined) {
      promptPreview = truncatePlain(collapseWs(lit), PROMPT_PREVIEW_MAX);
    } else if (promptArg.type === "TemplateLiteral") {
      // Verbatim inner source (with `${…}` shown) — honest about what's dynamic.
      promptPreview = sliceSource(
        ctx.src,
        { start: promptArg.start + 1, end: promptArg.end - 1 },
        PROMPT_PREVIEW_MAX,
      );
    }
  }

  let phase = ctx.ambientPhase;
  if (optPhase !== undefined) {
    phase = optPhase;
    registerBand(ctx, optPhase);
  }

  // Label expansion — ONLY pure textual substitution: the lanes are named and
  // every template expression is the bare fan-out/stage parameter, so each
  // name drops into the cooked quasis. Anything fancier stays unexpanded.
  // (The convention assumes the parameter is not rebound/reassigned inside
  // the body — that is invisible to a static reading and outside the
  // convention, like every other shadow-by-mutation.)
  let expandedLabels: string[] | undefined;
  if (labelTemplate !== undefined && ctx.expansion !== null) {
    const { param, names } = ctx.expansion;
    const exprs: any[] = labelTemplate.expressions ?? [];
    if (exprs.length > 0 && exprs.every((e) => e?.type === "Identifier" && e.name === param)) {
      const quasis: any[] = labelTemplate.quasis ?? [];
      expandedLabels = names.map((n) =>
        truncatePlain(
          collapseWs(
            quasis.map((q, i) => (q.value.cooked ?? "") + (i < exprs.length ? n : "")).join(""),
          ),
          LABEL_MAX,
        ),
      );
    }
  }

  return {
    kind: "agent",
    label,
    multiplicity: ctx.fanoutMult ?? { kind: "one" },
    phase,
    span: spanOf(call),
    ...(expandedLabels !== undefined ? { expandedLabels } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(promptPreview !== undefined ? { promptPreview } : {}),
  };
}

function workflowStep(ctx: Ctx, call: any): WorkflowStep {
  const arg = call.arguments?.[0];
  for (const a of call.arguments ?? []) {
    if (a && containsOrchestration(a)) {
      note(ctx, "workflow() arguments contain nested orchestration; not traced", a);
    }
    if (a) notePhaseMarkerDrops(ctx, a);
  }
  const name = stringLiteralValue(arg);
  const label =
    name !== undefined
      ? truncatePlain(collapseWs(name), LABEL_MAX)
      : arg
        ? sliceSource(ctx.src, spanOf(arg), LABEL_MAX)
        : "workflow";
  return {
    kind: "workflow",
    label,
    multiplicity: ctx.fanoutMult ?? { kind: "one" },
    phase: ctx.ambientPhase,
    span: spanOf(call),
  };
}

// ---------------------------------------------------------------------------
// Multiplicity resolution (consumed by Unit 04's fan-out/pipeline recognizers;
// exported now so the policy is testable on its own)
// ---------------------------------------------------------------------------

export interface MultiplicityState {
  src: string;
  consts: ReadonlyMap<string, unknown>;
  shadowed: ReadonlySet<string>;
}

/**
 * How wide is a fan-out over `expr`? Literal arrays count themselves;
 * identifiers resolve through the module-const table (unless lexically
 * shadowed — a fan-out parameter is not the module const it shades);
 * `Array.from({length: L})` resolves a literal/const L. Anything else is
 * honestly unknown, with the expression's own source as the hint.
 */
export function resolveMultiplicity(expr: any, state: MultiplicityState): Multiplicity {
  if (expr?.type === "ArrayExpression") {
    const els: any[] = expr.elements ?? [];
    if (els.some((el) => el === null || el.type === "SpreadElement")) {
      return unknownMult(state, expr); // holes/spread — width not literal
    }
    if (els.length > 0 && els.every((el) => el.type === "Literal" && typeof el.value === "string")) {
      return { kind: "named", names: els.map((el) => el.value as string) };
    }
    return { kind: "exact", count: els.length };
  }

  if (expr?.type === "Identifier") {
    if (!state.shadowed.has(expr.name) && state.consts.has(expr.name)) {
      const v = state.consts.get(expr.name);
      if (Array.isArray(v)) {
        return v.length > 0 && v.every((x) => typeof x === "string")
          ? { kind: "named", names: [...(v as string[])] }
          : { kind: "exact", count: v.length };
      }
    }
    return unknownMult(state, expr);
  }

  // Array.from({ length: L })
  if (
    expr?.type === "CallExpression" &&
    expr.callee?.type === "MemberExpression" &&
    !expr.callee.computed &&
    expr.callee.object?.type === "Identifier" &&
    expr.callee.object.name === "Array" &&
    expr.callee.property?.type === "Identifier" &&
    expr.callee.property.name === "from"
  ) {
    const arg0 = expr.arguments?.[0];
    if (arg0?.type === "ObjectExpression") {
      for (const prop of arg0.properties) {
        if (
          prop.type === "Property" &&
          !prop.computed &&
          ((prop.key.type === "Identifier" && prop.key.name === "length") ||
            (prop.key.type === "Literal" && prop.key.value === "length"))
        ) {
          const n = resolveNumeric(prop.value, state);
          if (n !== undefined && Number.isInteger(n) && n >= 0) {
            return { kind: "exact", count: n };
          }
        }
      }
    }
    return unknownMult(state, expr);
  }

  return unknownMult(state, expr);
}

function resolveNumeric(node: any, state: MultiplicityState): number | undefined {
  if (node?.type === "Literal" && typeof node.value === "number") return node.value;
  if (node?.type === "Identifier" && !state.shadowed.has(node.name)) {
    const v = state.consts.get(node.name);
    if (typeof v === "number") return v;
  }
  return undefined;
}

function unknownMult(state: MultiplicityState, expr: any): Multiplicity {
  return { kind: "unknown", hint: sliceSource(state.src, spanOf(expr), HINT_MAX) };
}

// ---------------------------------------------------------------------------
// Orchestration summary
// ---------------------------------------------------------------------------

/** Opaque-only analysis ⇒ false ⇒ the renderer falls back to v1 wholesale. */
function stepsHaveOrchestration(steps: readonly Step[]): boolean {
  return steps.some((s) => {
    switch (s.kind) {
      case "agent":
      case "workflow":
      case "parallel":
      case "pipeline":
        return true;
      case "loop":
        return stepsHaveOrchestration(s.body);
      case "branch":
        return stepsHaveOrchestration(s.thenSteps) || stepsHaveOrchestration(s.elseSteps);
      case "opaque":
      case "control":
        return false;
    }
  });
}
