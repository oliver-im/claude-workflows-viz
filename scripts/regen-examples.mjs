import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

/**
 * Regenerate every committed topology artifact (SVG + PNG) from its source
 * workflow, using the built CLI. Run after any change to the renderer so the
 * checked-in `examples/*` and the `workflow-readability` before/after images
 * stay in sync with the code. Requires a fresh `dist/cli.js` (`npm run build`).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/cli.js");

const dirs = ["examples", "skills/workflow-readability/example"];
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
    execFileSync("node", [cli, src, "--view", "topology", "-o", `${stem}.${ext}`], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    count++;
  }
}
console.log(`Regenerated ${count} artifacts from ${jobs.length} workflows.`);
