import type { DialectEpoch } from "./dialect.js";
import { truncatePlain } from "./svg-primitives.js";

/**
 * The body analyzer's TREE IR: a source-faithful, nested account of what the
 * workflow body *says* — agent calls, fan-outs, pipelines, loops, branches —
 * read statically off the acorn AST (the workflow is never executed).
 * `place-topology.ts` consumes this tree directly, positioning it as one
 * graph-first swimlane layout; this module is types + truncation policy only.
 *
 * Honesty contract carried by these types: counts appear only when literal
 * (`exact`/`named`), everything else is `unknown` with at most a verbatim
 * source hint; condition labels and control labels are truncated source slices
 * or fixed JS-control terms, never paraphrases; every degradation surfaces as an `OpaqueStep` or an
 * `AnalysisNote` — nothing is silently dropped. IR strings are RAW source
 * text — escaping happens at render time.
 */

/** Byte offsets into the workflow source (acorn `start`/`end`). */
export interface SourceSpan {
  start: number;
  end: number;
}

/**
 * How many of a thing run: exactly one; a literal count; a literal list of
 * names (e.g. `["correctness", "security"]` lenses); or unknown at parse time
 * — rendered as ×N, optionally with a truncated source hint of the collection
 * expression.
 */
export type Multiplicity =
  | { kind: "one" }
  | { kind: "exact"; count: number }
  | { kind: "named"; names: string[] }
  | { kind: "unknown"; hint?: string };

/** `phase` is the band title in lexical effect (raw text), null before any marker. */
export interface StepBase {
  phase: string | null;
  span: SourceSpan;
}

/** One `agent(...)` call. */
export interface AgentStep extends StepBase {
  kind: "agent";
  label: string;
  /**
   * True iff the author supplied `{ label }` (string or template). False when
   * `label` was DERIVED by slicing the prompt because no label was given — a
   * derived label is redundant with the phase row, so the topology renderer
   * draws a bare node and lets the row name it. The label string is identical
   * either way; this only records its provenance.
   */
  labelExplicit: boolean;
  /**
   * Present only when multiplicity is `named` AND the label template's every
   * expression is the bare fan-out parameter: the pure textual substitution
   * of each name (e.g. `` `refute:${lens}` `` → refute:correctness, …).
   */
  expandedLabels?: string[];
  multiplicity: Multiplicity;
  model?: string;
  agentType?: string;
  promptPreview?: string;
}

/** One `workflow(...)` sub-workflow call. */
export interface WorkflowStep extends StepBase {
  kind: "workflow";
  label: string;
  multiplicity: Multiplicity;
}

/**
 * The honest blob: orchestration the analyzer could not read structurally.
 * The label is a truncated verbatim source slice.
 */
export interface OpaqueStep extends StepBase {
  kind: "opaque";
  label: string;
}

/**
 * A non-agent control action that changes how the surrounding flow reads. These
 * are deterministic JS facts (`continue`, `return`, etc.), not inferred prose.
 */
export interface ControlStep extends StepBase {
  kind: "control";
  label: string;
  flow?: "continue" | "break" | "return" | "throw" | "terminal";
  tooltip?: string;
}

/**
 * `parallel(...)`: either a literal array of thunks (k distinct branches) or
 * a `.map` fan-out (one body repeated per item, with the items' multiplicity).
 */
export type ParallelStep = StepBase & { kind: "parallel" } & (
  | { form: "branches"; branches: Step[][] }
  | { form: "fanout"; multiplicity: Multiplicity; body: Step[] }
);

/** `pipeline(items, ...stages)`: per-item chains, no barrier between stages. */
export interface PipelineStep extends StepBase {
  kind: "pipeline";
  items: Multiplicity;
  stages: Step[][];
}

/** Any loop statement whose body orchestrates. */
export interface LoopStep extends StepBase {
  kind: "loop";
  loopKind: "while" | "do-while" | "for" | "for-of" | "for-in";
  /** Verbatim truncated source slice of the test (or loop header). */
  conditionLabel: string;
  /** Full collapsed source slice for tooltips when the label was truncated. */
  conditionTooltip?: string;
  /** Only when iterating a literal-resolvable collection. */
  iterations?: number;
  body: Step[];
}

/** An `if`/ternary with orchestration in at least one arm. */
export interface BranchStep extends StepBase {
  kind: "branch";
  /** Verbatim truncated source slice of the test. */
  conditionLabel: string;
  thenSteps: Step[];
  elseSteps: Step[];
}

export type Step =
  | AgentStep
  | WorkflowStep
  | OpaqueStep
  | ControlStep
  | ParallelStep
  | PipelineStep
  | LoopStep
  | BranchStep;

/** A band title: from `meta.phases` or first seen in the body (`phase()` call). */
export interface BandRef {
  title: string;
  inMeta: boolean;
}

/** A degradation record: what the analyzer saw but could not represent. */
export interface AnalysisNote {
  message: string;
  span?: SourceSpan;
  snippet?: string;
}

export interface Topology {
  steps: Step[];
  bands: BandRef[];
  notes: AnalysisNote[];
  /**
   * True iff any recognized step orchestrates (agent/workflow/parallel/
   * pipeline reached). Opaque-only analysis ⇒ false ⇒ the renderer falls back
   * to the v1 phase cards wholesale.
   */
  hasOrchestration: boolean;
  /**
   * The minimum dialect epoch needed to understand this file — `max sinceEpoch`
   * over the wired lexicon tokens it uses, floored at `D1` (see
   * `feature-detect.ts`). Carried for the caniuse-style comparison and the JSON
   * emit; does not affect placement or rendering.
   */
  requiredDialect: DialectEpoch;
  /** The dialect epoch the recognizer targets (`RECOGNIZER_TARGET`), for comparison. */
  recognizerTarget: DialectEpoch;
}

// ---------------------------------------------------------------------------
// Truncation policy — single place, shared by analyzer and flattener.
// ---------------------------------------------------------------------------

export const COND_MAX = 48;
export const LABEL_MAX = 40;
export const PROMPT_PREVIEW_MAX = 80;
export const HINT_MAX = 24;
export const OPAQUE_LABEL_MAX = 40;

/**
 * The one way source text becomes a label: slice the span, collapse all
 * whitespace runs to single spaces, ellipsis-truncate at `max`. Keeps labels
 * verbatim-up-to-truncation — never a paraphrase.
 */
export function sliceSource(src: string, span: SourceSpan, max: number): string {
  const collapsed = src.slice(span.start, span.end).replace(/\s+/g, " ").trim();
  return truncatePlain(collapsed, max);
}
