import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

/**
 * Regenerate every committed render (SVG + PNG) from its source workflow, using
 * the built CLI in its DEFAULT view — the full workflow page (header + phase
 * table + graph), which is what the corpus is committed as. Run after any change
 * to the renderer so the checked-in `examples/level-N/` corpus stays in sync with
 * the code. Requires a fresh `dist/cli.js` (`npm run build`).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/cli.js");

// Auto-discovered, so minting a grammar level and adding `examples/level-N/`
// doesn't also require remembering to list it here.
const dirs = readdirSync(join(root, "examples"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^level-\d+$/.test(d.name))
  .map((d) => `examples/${d.name}`)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const jobs = [];
for (const dir of dirs) {
  const abs = join(root, dir);
  for (const file of readdirSync(abs).filter((f) => f.endsWith(".js"))) {
    jobs.push(join(abs, file));
  }
}

let count = 0;
for (const src of jobs) {
  const stem = join(dirname(src), basename(src, ".js"));
  for (const ext of ["svg", "png"]) {
    execFileSync("node", [cli, src, "-o", `${stem}.${ext}`], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    count++;
  }
}
console.log(`Regenerated ${count} artifacts from ${jobs.length} workflows.`);
