import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type * as acorn from "acorn";
import { Command } from "commander";
import { analyzeBody } from "./analyze-body.js";
import { emitAnalysisJson } from "./emit-json.js";
import {
  MetaExtractionError,
  extractMetaFromProgram,
  parseWorkflowSource,
  readWorkflowSource,
} from "./extract-meta.js";
import { detectGrammarUse, grammarWarning } from "./feature-detect.js";
import { wrapSvgHtml } from "./html.js";
import type { Meta } from "./model.js";
import { openBrowser } from "./output.js";
import { placeTopology } from "./place-topology.js";
import { DEFAULT_PNG_SCALE, svgToPng } from "./render-png.js";
import { type Provenance, renderSvg } from "./render-svg.js";
import { renderTopology, renderTopologyGraph } from "./render-topology.js";

declare const __CWV_VERSION__: string;

/**
 * The provenance stamped into every rendered diagram: the tool version. A
 * build-time constant, so the footer is deterministic and identical across views.
 * Grammar level is not stamped here — it is tracked by the example corpus under
 * `examples/level-N/`, not pinned into each diagram.
 */
const PROVENANCE: Provenance = {
  toolVersion: __CWV_VERSION__,
};

const FORMATS = ["svg", "png", "html", "json"] as const;
export type Format = (typeof FORMATS)[number];

const VIEWS = ["workflow", "topology", "phases"] as const;
export type View = (typeof VIEWS)[number];

interface CliOpts {
  out?: string;
  format?: string;
  open?: boolean;
  view?: string;
  scale?: string;
}

/** Print a one-line error to stderr and exit non-zero. */
function fail(message: string): never {
  process.stderr.write(`claude-workflows-viz: ${message}\n`);
  process.exit(1);
}

/**
 * Resolve the output format: an explicit `--format` wins (and is validated);
 * otherwise infer from the `--out` file extension; otherwise default to svg.
 */
function resolveFormat(explicit: string | undefined, out: string | undefined): Format {
  if (explicit !== undefined) {
    if (!(FORMATS as readonly string[]).includes(explicit)) {
      fail(`unknown --format '${explicit}' (expected: ${FORMATS.join(", ")})`);
    }
    return explicit as Format;
  }
  if (out) {
    const ext = extname(out).slice(1).toLowerCase();
    if ((FORMATS as readonly string[]).includes(ext)) return ext as Format;
  }
  return "svg";
}

/** Resolve `--view`: full workflow page (default), topology graph, or phase cards. */
function resolveView(explicit: string | undefined): View {
  if (explicit === undefined) return "workflow";
  if (!(VIEWS as readonly string[]).includes(explicit)) {
    fail(`unknown --view '${explicit}' (expected: ${VIEWS.join(", ")})`);
  }
  return explicit as View;
}

/**
 * Resolve `--scale`: the PNG rasterization zoom (default 2). PNG-only — vector
 * SVG/HTML carry their own intrinsic size. Bounded to a sane range so a typo
 * like `--scale 1000` can't try to allocate a gigapixel raster.
 */
function resolveScale(explicit: string | undefined): number {
  if (explicit === undefined) return DEFAULT_PNG_SCALE;
  const n = Number(explicit);
  if (!Number.isFinite(n) || n <= 0 || n > 10) {
    fail(`invalid --scale '${explicit}' (expected a number in 0 < n ≤ 10)`);
  }
  return n;
}

/** Default output path when `--out` is absent but a file is required. */
function defaultOutPath(workflow: string, format: Format, ephemeral: boolean): string {
  const stem = basename(workflow).replace(/\.[^.]+$/, "") || "workflow";
  const name = `${stem}.${format}`;
  // `--open` with no `--out` just wants something to view → a temp file, not
  // clutter in the cwd. An unrouted PNG (binary, can't stream) lands next to cwd.
  return ephemeral ? join(tmpdir(), `claude-workflows-viz-${name}`) : name;
}

/**
 * The analyzed views: statically analyze the body (never executing it) into the
 * tree IR, place it once, and render either the full workflow swimlane page or
 * the graph-only topology. A body with no recoverable orchestration is by-design
 * degradation, not failure — it renders the v1 phases page wholesale
 * (byte-identical to `renderSvg`), with no warning. The analyzer and placement
 * are total by contract, so the try/catch is a defensive belt: if anything ever
 * does throw, the CLI degrades to that same v1 page with a one-line stderr
 * warning and exit 0 — visible, never fatal, never silent.
 */
function renderAnalyzedView(meta: Meta, program: acorn.Node, src: string, view: "workflow" | "topology"): string {
  try {
    const topology = analyzeBody(program, src, meta.phases.map((p) => p.title));
    if (!topology.hasOrchestration) return renderSvg(meta, PROVENANCE);
    const layout = placeTopology(topology, meta);
    return view === "workflow"
      ? renderTopology(layout, meta, PROVENANCE)
      : renderTopologyGraph(layout, PROVENANCE);
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
    process.stderr.write(
      `claude-workflows-viz: warning: body analysis failed (${reason}); rendering meta phases only\n`,
    );
    return renderSvg(meta, PROVENANCE);
  }
}

/**
 * Emit a one-line stderr warning when the file needs a higher grammar level than
 * the recognizer supports — or awaits an unrecognized orchestration-shaped call.
 * The warning is advisory: it never changes the output or the (0) exit code.
 *
 * It detects straight from the AST rather than reading the detection off the
 * `Topology` `analyzeBody` attaches, on purpose: in the render path that
 * `Topology` is produced *inside* `renderTopologyView`, behind a defensive
 * try/catch and the `hasOrchestration` early return — the very return this
 * warning must precede so a newer-construct file that recovers no orchestration
 * still warns. `detectGrammarUse` is a pure, deterministic function of `program`,
 * so this call and the fields on the emitted `Topology` are always identical for
 * the same file (no drift) — it is one shared computation invoked at each seam
 * that needs it, not a divergent second pass.
 */
function warnGrammar(program: acorn.Node): void {
  const message = grammarWarning(detectGrammarUse(program));
  if (message) process.stderr.write(`claude-workflows-viz: warning: ${message}\n`);
}

function run(workflow: string, opts: CliOpts): void {
  const format = resolveFormat(opts.format, opts.out);
  const view = resolveView(opts.view);

  // One read, one parse — meta extraction, body analysis, and the json emit
  // all share the AST.
  let meta: Meta;
  let data: string | Buffer;
  try {
    const src = readWorkflowSource(workflow);
    const program = parseWorkflowSource(src);
    meta = extractMetaFromProgram(program);
    if (format === "json") {
      // The structured analysis is a dump of facts, not a rendered view, so
      // `--view` is ignored here by design.
      warnGrammar(program);
      data = emitAnalysisJson(meta, program, src, workflow);
    } else {
      let svg: string;
      if (view === "phases") {
        svg = renderSvg(meta, PROVENANCE); // meta-only view: the body and its grammar go untouched
      } else {
        // Warn BEFORE renderAnalyzedView so a file whose newer construct recovers
        // no orchestration (hitting its hasOrchestration early return) still surfaces it.
        warnGrammar(program);
        svg = renderAnalyzedView(meta, program, src, view);
      }
      data =
        format === "png"
          ? svgToPng(svg, resolveScale(opts.scale))
          : format === "html"
            ? wrapSvgHtml(svg, meta.name)
            : svg;
    }
  } catch (e) {
    if (e instanceof MetaExtractionError) fail(e.message);
    throw e;
  }

  // Routing. Explicit --out always wins. Otherwise text formats (svg/html)
  // stream to stdout so the tool composes in pipelines; PNG is binary, so an
  // unrouted PNG is written to a derived path. `--open` forces a real file.
  if (opts.out) {
    writeFileSync(opts.out, data);
    process.stderr.write(`Wrote ${opts.out}\n`);
    if (opts.open) openBrowser(opts.out);
    return;
  }

  if (!opts.open && typeof data === "string") {
    process.stdout.write(data);
    return;
  }

  const path = defaultOutPath(workflow, format, !!opts.open);
  writeFileSync(path, data);
  process.stderr.write(`Wrote ${path}\n`);
  if (opts.open) openBrowser(path);
}

const program = new Command();

program
  .name("claude-workflows-viz")
  .description(
    "Render a Claude Code dynamic-workflow file as an SVG/PNG diagram — the full workflow view, graph-only topology, or meta phase cards",
  )
  .version(__CWV_VERSION__, "-v, --version", "Show version number");

program
  .argument("<workflow>", "Path to a dynamic-workflow .js file")
  .option("-o, --out <file>", "Write the diagram to this path (else stdout for svg/html)")
  .option(
    "--format <format>",
    "Output format: svg | png | html | json (default: svg, or inferred from --out). json dumps the static analysis (meta + body topology) for tooling/skills.",
  )
  .option(
    "--view <view>",
    "View: workflow (default; phases plus topology) | topology (graph only) | phases (meta phase cards)",
  )
  .option(
    "--scale <n>",
    `PNG rasterization scale, 0 < n ≤ 10 (default: ${DEFAULT_PNG_SCALE}). Higher = sharper and larger. PNG only.`,
  )
  .option("--open", "Open the rendered output in the default app after writing")
  .action(run);

await program.parseAsync();
