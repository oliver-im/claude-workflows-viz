import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "dist", "cli.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// `pretest` builds dist/cli.js, so the bundle exists when these run.
describe("cli smoke", () => {
  it("prints its version", () => {
    const out = execFileSync("node", [cli, "--version"], { encoding: "utf8" });
    expect(out.trim()).toBe(pkg.version);
  });

  it("lists the command surface in --help", () => {
    const out = execFileSync("node", [cli, "--help"], { encoding: "utf8" });
    expect(out).toContain("--format");
    expect(out).toContain("--out");
    expect(out).toContain("workflow");
  });
});
