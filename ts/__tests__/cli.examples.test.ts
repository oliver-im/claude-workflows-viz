import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "dist", "cli.js");
const examplesRoot = join(root, "examples");

// Discover every grammar level, just as regen-examples does. The committed SVGs
// are the expectations; never compute them using the renderer under test.
const corpus = readdirSync(examplesRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^level-\d+$/.test(d.name))
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .flatMap((dir) =>
    readdirSync(join(examplesRoot, dir))
      .filter((file) => file.endsWith(".js"))
      .sort()
      .map((file) => join(dir, file)),
  );

describe("CLI default view matches the committed SVG corpus", () => {
  // npm test's pretest hook rebuilds the CLI. Render to stdout so checking the
  // corpus never overwrites the expected files or executes a workflow itself.
  it.each(corpus)("%s", (file) => {
    const source = join(examplesRoot, file);
    const expected = readFileSync(source.replace(/\.js$/, ".svg"), "utf8");
    const result = spawnSync(process.execPath, [cli, source], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      result.stdout,
      `${file}: review the render change before updating examples with npm run regen-examples`,
    ).toBe(expected);
  });
});
