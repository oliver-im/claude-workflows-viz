import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Command } from "commander";
import { MetaExtractionError, extractMeta } from "./extract-meta.js";
import { wrapSvgHtml } from "./html.js";
import { openBrowser } from "./output.js";
import { svgToPng } from "./render-png.js";
import { renderSvg } from "./render-svg.js";

declare const __CWV_VERSION__: string;

const FORMATS = ["svg", "png", "html"] as const;
export type Format = (typeof FORMATS)[number];

interface CliOpts {
  out?: string;
  format?: string;
  open?: boolean;
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

/** Default output path when `--out` is absent but a file is required. */
function defaultOutPath(workflow: string, format: Format, ephemeral: boolean): string {
  const stem = basename(workflow).replace(/\.[^.]+$/, "") || "workflow";
  const name = `${stem}.${format}`;
  // `--open` with no `--out` just wants something to view → a temp file, not
  // clutter in the cwd. An unrouted PNG (binary, can't stream) lands next to cwd.
  return ephemeral ? join(tmpdir(), `claude-workflows-viz-${name}`) : name;
}

function run(workflow: string, opts: CliOpts): void {
  const format = resolveFormat(opts.format, opts.out);

  let meta;
  try {
    meta = extractMeta(workflow);
  } catch (e) {
    if (e instanceof MetaExtractionError) fail(e.message);
    throw e;
  }

  const svg = renderSvg(meta);
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
    "Render a Claude Code dynamic-workflow file's static meta block as an SVG/PNG diagram",
  )
  .version(__CWV_VERSION__, "-v, --version", "Show version number");

program
  .argument("<workflow>", "Path to a dynamic-workflow .js file")
  .option("-o, --out <file>", "Write the diagram to this path (else stdout for svg/html)")
  .option(
    "--format <format>",
    "Output format: svg | png | html (default: svg, or inferred from --out)",
  )
  .option("--open", "Open the rendered output in the default app after writing")
  .action(run);

await program.parseAsync();
