import { Command } from "commander";

declare const __CWV_VERSION__: string;

export type Format = "svg" | "png" | "html";

export interface RenderOpts {
  out?: string;
  format: Format;
  open?: boolean;
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
  .option("-o, --out <file>", "Write the diagram to this path")
  .option(
    "--format <format>",
    "Output format: svg | png | html",
    "svg",
  )
  .option("--open", "Open the rendered output after writing")
  .action((workflow: string, opts: RenderOpts) => {
    // The end-to-end pipeline (extract meta -> render SVG -> rasterize PNG ->
    // write/open) is wired in Unit 04. Until then this is an intentional stub.
    process.stderr.write(
      `claude-workflows-viz: not yet implemented (workflow=${workflow}, ` +
        `format=${opts.format})\n`,
    );
    process.exit(1);
  });

await program.parseAsync();
