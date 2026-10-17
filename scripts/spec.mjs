import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Regenerate the readable side of `spec/` from the raw captures in
 * `spec/upstream/` — each capture's prose as Markdown, a change page per
 * capture, the newest capture at a fixed path, and the captures table inside
 * `spec/README.md`. The logic lives in `ts/spec/` (typed, and tested by
 * `ts/__tests__/spec.test.ts`, which fails when a committed page is stale); this
 * script bundles it with esbuild and runs it, so it needs no build step first.
 * With `--site` it also writes the whole readable spec as one HTML page,
 * `site/index.html` (gitignored; `ts/spec/site.ts`).
 *
 * Also imported by `scripts/capture-grammar.mjs`, which classifies drift with
 * the same code and refreshes these pages after a capture.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Bundle `ts/spec/` into a cache file and import it. */
export async function loadSpec() {
  const outfile = join(root, "node_modules", ".cache", "claude-workflows-viz", "spec.mjs");
  await build({
    entryPoints: [join(root, "ts", "spec", "index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    logLevel: "warning",
  });
  return import(pathToFileURL(outfile).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const spec = await loadSpec();
  const written = spec.writeSpec(root);
  if (written.length === 0) console.log("spec/ is up to date.");
  else for (const path of written) console.log(`wrote ${path}`);
  // `--site`: also render the whole readable spec as one HTML page (gitignored).
  if (process.argv.includes("--site")) {
    const out = join(root, "site", "index.html");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, spec.generateSite(root));
    console.log(`wrote ${out}`);
  }
}
