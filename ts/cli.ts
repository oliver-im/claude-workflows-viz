import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type * as acorn from "acorn";
import { Command } from "commander";
import { analyzeBody } from "./analyze-body.js";
import {
  MetaExtractionError,
  extractMetaFromProgram,
  parseWorkflowSource,
  readWorkflowSource,
} from "./extract-meta.js";
import { wrapSvgHtml } from "./html.js";
import type { Meta } from "./model.js";
import { openBrowser } from "./output.js";
import { placeTopology } from "./place-topology.js";
import { svgToPng } from "./render-png.js";
import { renderSvg } from "./render-svg.js";
import { renderTopology } from "./render-topology.js";

declare const __CWV_VERSION__: string;

const FORMATS = ["svg", "png", "html"] as const;
export type Format = (typeof FORMATS)[number];

const VIEWS = ["topology", "phases"] as const;
export type View = (typeof VIEWS)[number];

interface CliOpts {
  out?: string;
  format?: string;
  open?: boolean;
  view?: string;
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

/** Resolve `--view`: topology (the default) or the v1 phase-card page. */
function resolveView(explicit: string | undefined): View {
  if (explicit === undefined) return "topology";
  if (!(VIEWS as readonly string[]).includes(explicit)) {
    fail(`unknown --view '${explicit}' (expected: ${VIEWS.join(", ")})`);
  }
  return explicit as View;
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
 * The topology view: statically analyze the body (never executing it) into the
 * tree IR, place it as one graph-first swimlane layout, and render that. A body
 * with no recoverable orchestration is by-design degradation, not failure — it
 * renders the v1 phases page wholesale (byte-identical to `renderSvg`), with no
 * warning. The analyzer and placement are total by contract, so the try/catch
 * is a defensive belt: if anything ever does throw, the CLI degrades to that
 * same v1 page with a one-line stderr warning and exit 0 — visible, never
 * fatal, never silent.
 */
function renderTopologyView(meta: Meta, program: acorn.Node, src: string): string {
  try {
    const topology = analyzeBody(program, src, meta.phases.map((p) => p.title));
    if (!topology.hasOrchestration) return renderSvg(meta);
    return renderTopology(placeTopology(topology, meta), meta);
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
    process.stderr.write(
      `claude-workflows-viz: warning: body analysis failed (${reason}); rendering meta phases only\n`,
    );
    return renderSvg(meta);
  }
}

function run(workflow: string, opts: CliOpts): void {
  const format = resolveFormat(opts.format, opts.out);
  const view = resolveView(opts.view);

  // One read, one parse — meta extraction and body analysis share the AST.
  let meta: Meta;
  let svg: string;
  try {
    const src = readWorkflowSource(workflow);
    const program = parseWorkflowSource(src);
    meta = extractMetaFromProgram(program);
    svg = view === "phases" ? renderSvg(meta) : renderTopologyView(meta, program, src);
  } catch (e) {
    if (e instanceof MetaExtractionError) fail(e.message);
    throw e;
  }

  const data: string | Buffer =
    format === "png" ? svgToPng(svg) : format === "html" ? wrapSvgHtml(svg, meta.name) : svg;

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
    "Render a Claude Code dynamic-workflow file as an SVG/PNG diagram — the agent topology statically inferred from the body (never executed), or the meta phase cards via --view phases",
  )
  .version(__CWV_VERSION__, "-v, --version", "Show version number");

program
  .argument("<workflow>", "Path to a dynamic-workflow .js file")
  .option("-o, --out <file>", "Write the diagram to this path (else stdout for svg/html)")
  .option(
    "--format <format>",
    "Output format: svg | png | html (default: svg, or inferred from --out)",
  )
  .option(
    "--view <view>",
    "View: topology (default; banded agent graph) | phases (v1 phase cards)",
  )
  .option("--open", "Open the rendered output in the default app after writing")
  .action(run);

await program.parseAsync();
