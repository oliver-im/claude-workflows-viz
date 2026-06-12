import type * as acorn from "acorn";
import { tryEvalLiteral } from "./extract-meta.js";
import {
  type AgentStep,
  type AnalysisNote,
  type BandRef,
  type Multiplicity,
  type OpaqueStep,
  type SourceSpan,
  type Step,
  type Topology,
  type WorkflowStep,
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
 * This unit recognizes the sequential vocabulary (`phase()` markers,
 * `agent()`, `workflow()`, chained-call unwrapping). The structural idioms —
 * `parallel`/`pipeline` calls, loops, branches — deliberately degrade to
 * opaque steps here; Unit 04 replaces those degradations with real
 * recognizers.
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
  /** Names rebound lexically (fan-out parameters — threaded in Unit 04). */
  shadowed: Set<string>;
  /** Meta phases first (`inMeta: true`), body-only titles appended in first lexical occurrence order. */
  bands: BandRef[];
  notes: AnalysisNote[];
  /** The band in lexical effect — `phase("…")` statement markers mutate it. */
  ambientPhase: string | null;
}

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
        // irrelevant — the flow lives in the initializer.
        const got = walkExpression(ctx, d.init);
        if (got.length > 0) {
          steps.push(...got);
        } else {
          if (containsOrchestration(d.init)) {
            // Gate per INIT, not per statement, so one recognized declarator
            // can't mask orchestration hiding in a sibling.
            note(
              ctx,
              "orchestration inside an unrecognized initializer; rendered as one opaque step",
              d.init,
            );
            steps.push(opaque(ctx, d.init));
          }
          notePhaseMarkerDrops(ctx, d.init);
        }
      }
      return steps;
    }

    case "ExpressionStatement":
      return walkExpressionStatement(ctx, stmt);

    case "BlockStatement":
      // Same ambient phase on purpose: `phase()` markers take lexical effect
      // and leak past the block, exactly like the runtime's ambient phase.
      return walkStatements(ctx, stmt.body);

    case "TryStatement": {
      const steps = walkStatements(ctx, stmt.block.body);
      for (const part of [stmt.handler?.body, stmt.finalizer]) {
        if (!part) continue;
        if (containsOrchestration(part)) {
          note(
            ctx,
            "try/catch flattened: steps from a catch/finally block are drawn in the main flow",
            part,
          );
          steps.push(...walkStatements(ctx, part.body));
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
    case "IfStatement":
      // Structural recognizers land in Unit 04 — degrade honestly for now.
      notePhaseMarkerDrops(ctx, stmt);
      if (containsOrchestration(stmt)) {
        note(ctx, "loop or branch structure not recognized; rendered as one opaque step", stmt);
        return [opaque(ctx, stmt)];
      }
      return [];

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

  const steps = walkExpression(ctx, expr);
  if (steps.length > 0) return steps;
  notePhaseMarkerDrops(ctx, expr);
  if (containsOrchestration(expr)) {
    note(ctx, "orchestration inside an unrecognized expression; rendered as one opaque step", expr);
    return [opaque(ctx, expr)];
  }
  return []; // log(…), budget.* — nothing to draw
}

// ---------------------------------------------------------------------------
// Expression recognizers
// ---------------------------------------------------------------------------

function walkExpression(ctx: Ctx, node: any): Step[] {
  if (!node || typeof node !== "object") return [];

  if (node.type === "AwaitExpression") return walkExpression(ctx, node.argument);
  // Optional chains (`agent?.(…)`) parse wrapped in a ChainExpression.
  if (node.type === "ChainExpression") return walkExpression(ctx, node.expression);

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
      // A phase() call here is expression position — the abandoned-subtree
      // scans at the statement/init/argument exits note the dropped marker.
      default:
        return [];
    }
  }

  return []; // the statement-level gate decides opaqueness
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

  return {
    kind: "agent",
    label,
    multiplicity: { kind: "one" }, // fan-out threading lands in Unit 04
    phase,
    span: spanOf(call),
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
    multiplicity: { kind: "one" },
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
        return false;
    }
  });
}
