import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { extractMeta } from "../extract-meta.js";
import { type Provenance, renderSvg } from "../render-svg.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const cli = join(root, "dist", "cli.js");
const fixture = join(here, "fixtures", "full.js");
const exoticFixture = join(here, "fixtures", "exotic-body.js");
const summarizeExample = join(root, "examples", "level-1", "summarize-codebase.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The provenance the CLI stamps into every render — reconstructed here so the
// byte-equality assertions below compare against the SAME footer the CLI emits,
// rather than hardcoding the strings. (`__CWV_VERSION__` is `pkg.version`.)
const prov: Provenance = {
  toolVersion: pkg.version,
};

// Scratch dir for written artifacts; `pretest` builds dist/cli.js first.
const workDir = mkdtempSync(join(tmpdir(), "cwv-smoke-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function runCli(args: string[]) {
  return spawnSync("node", [cli, ...args], { encoding: "utf8" });
}

describe("cli smoke", () => {
  it("prints its version", () => {
    const res = runCli(["--version"]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(pkg.version);
  });

  it("lists the command surface in --help", () => {
    const res = runCli(["--help"]);
    expect(res.stdout).toContain("--format");
    expect(res.stdout).toContain("--out");
    expect(res.stdout).toContain("--view");
    expect(res.stdout).toContain("workflow");
  });

  it("writes a well-formed SVG with -o", () => {
    const out = join(workDir, "out.svg");
    const res = runCli([fixture, "-o", out]);
    expect(res.status).toBe(0);
    const svg = readFileSync(out, "utf8");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain("Find flaky tests");
  });

  it("streams SVG to stdout when no -o is given", () => {
    const res = runCli([fixture]);
    expect(res.status).toBe(0);
    expect(res.stdout.startsWith("<svg ")).toBe(true);
    expect(res.stdout.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("rasterizes a real PNG with --format png -o", () => {
    const out = join(workDir, "out.png");
    const res = runCli([fixture, "--format", "png", "-o", out]);
    expect(res.status).toBe(0);
    const png = readFileSync(out);
    expect([...png.subarray(0, 8)]).toEqual(PNG_MAGIC);
    // IHDR is the first chunk; width/height live right after its type tag.
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBeGreaterThan(0); // width
    expect(png.readUInt32BE(20)).toBeGreaterThan(0); // height
  });

  it("infers PNG format from the -o extension", () => {
    const out = join(workDir, "inferred.png");
    const res = runCli([fixture, "-o", out]);
    expect(res.status).toBe(0);
    expect([...readFileSync(out).subarray(0, 8)]).toEqual(PNG_MAGIC);
  });

  it("emits the static analysis as JSON with --format json", () => {
    const res = runCli([summarizeExample, "--format", "json"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    const parsed = JSON.parse(res.stdout);
    expect(parsed.schema).toBe("claude-workflows-viz/analysis@1");
    expect(parsed.source).toContain("summarize-codebase.js");
    expect(parsed.meta.name).toBeTruthy();
    expect(Array.isArray(parsed.topology.steps)).toBe(true);
    expect(parsed.topology.hasOrchestration).toBe(true);
    // The faithful IR carries the verbatim, un-paraphrased labels the skill reads.
    const kinds = parsed.topology.steps.map((s: { kind: string }) => s.kind);
    expect(kinds).toContain("parallel");
  });

  it("carries the per-file grammar level in the JSON topology block", () => {
    const res = runCli([summarizeExample, "--format", "json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.topology.requiredLevel).toBe(1);
    expect(parsed.topology.recognizerLevel).toBe(1);
  });

  it("infers json format from the -o extension and is deterministic", () => {
    const out = join(workDir, "analysis.json");
    const res = runCli([summarizeExample, "-o", out]);
    expect(res.status).toBe(0);
    const first = readFileSync(out, "utf8");
    expect(JSON.parse(first).schema).toBe("claude-workflows-viz/analysis@1");
    runCli([summarizeExample, "-o", out]);
    expect(readFileSync(out, "utf8")).toBe(first); // byte-identical re-run
  });

  it("exits non-zero with a clear message for a missing file", () => {
    const res = runCli([join(workDir, "does-not-exist.js")]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/cannot read/i);
  });

  it("exits non-zero with a clear message for a bad --format", () => {
    const res = runCli([fixture, "--format", "gif"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/unknown --format/i);
  });

  // `--open` spawns the OS opener (a real window), so it is verified manually,
  // not here, to keep the suite headless and side-effect-free.
});

describe("cli smoke — views", () => {
  it("defaults to the workflow view: phase table plus topology in the output, no warnings", () => {
    const res = runCli([summarizeExample]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain('class="agent-node"');
    expect(res.stdout).toContain('class="swimlane"'); // phase as overlay stripe, not a card
    expect(res.stdout).not.toContain("xband"); // no card-wall routing survives
  });

  it("--view workflow is the explicit spelling of the default view", () => {
    const implicit = runCli([summarizeExample]);
    const explicit = runCli([summarizeExample, "--view", "workflow"]);
    expect(explicit.status).toBe(0);
    expect(explicit.stdout).toBe(implicit.stdout);
  });

  it("--view topology renders the graph only", () => {
    const res = runCli([summarizeExample, "--view", "topology"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain('class="topology"');
    expect(res.stdout).toContain('class="agent-node"');
    expect(res.stdout).not.toContain('class="header-card"');
    expect(res.stdout).not.toContain('class="lane-label"');
    expect(res.stdout).not.toContain('class="swimlane"');
  });

  it("stamps the provenance footer into the rendered diagram", () => {
    const res = runCli([summarizeExample]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('class="provenance"');
    // The tool version — so an image that has travelled away from its `.js`
    // source still says what produced it. Grammar level is tracked by the example
    // corpus under examples/level-N/, not stamped into the diagram.
    expect(res.stdout).toContain(`v${pkg.version}`);
    expect(res.stdout).not.toContain("grammar level");
  });

  it("--view phases renders the byte-stable v1 page", () => {
    const res = runCli([summarizeExample, "--view", "phases"]);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("agent-node");
    // Byte-for-byte the v1 renderer's output (itself pinned by its snapshot
    // suite) — the permanent regression surface for the old view, now including
    // the provenance footer the CLI stamps.
    expect(res.stdout).toBe(renderSvg(extractMeta(summarizeExample), prov));
  });

  it("exits non-zero with a clear message for a bad --view", () => {
    const res = runCli([fixture, "--view", "mermaid"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/unknown --view/i);
  });

  it("falls back to the v1-equivalent page for an exotic body, exit 0", () => {
    const res = runCli([exoticFixture]);
    expect(res.status).toBe(0);
    // No recoverable orchestration is by-design degradation, not a failure:
    // no warning, and the topology page is byte-identical to the v1 render.
    expect(res.stderr).toBe("");
    expect(res.stdout).not.toContain("agent-node");
    expect(res.stdout).toContain('class="phase-card"');
    expect(res.stdout).toBe(renderSvg(extractMeta(exoticFixture), prov));
  });

  it("--view topology falls back to the v1-equivalent page for an exotic body, exit 0", () => {
    const res = runCli([exoticFixture, "--view", "topology"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).not.toContain("agent-node");
    expect(res.stdout).toContain('class="phase-card"');
    expect(res.stdout).toBe(renderSvg(extractMeta(exoticFixture), prov));
  });

  it("warns about an unrecognized awaited primitive yet still renders (exit 0), proving the warning is independent of the hasOrchestration fallback", () => {
    const unknownFixture = join(here, "fixtures", "uses-unknown-primitive.js");
    const res = runCli([unknownFixture]);
    expect(res.status).toBe(0);
    // The softer feature-detection signal fires on `await race(...)`...
    expect(res.stderr).toMatch(/not recognized as orchestration/);
    // ...even though no orchestration was recovered, so the workflow view fell
    // back to the byte-identical v1 phases page (the warning ran before that).
    expect(res.stdout).not.toContain("agent-node");
    expect(res.stdout).toBe(renderSvg(extractMeta(unknownFixture), prov));
  });

  it("rasterizes the workflow view to a real PNG", () => {
    const out = join(workDir, "workflow.png");
    const res = runCli([summarizeExample, "--format", "png", "-o", out]);
    expect(res.status).toBe(0);
    expect([...readFileSync(out).subarray(0, 8)]).toEqual(PNG_MAGIC);
  });

  it("rasterizes the graph-only topology view to a real PNG", () => {
    const out = join(workDir, "topology.png");
    const res = runCli([summarizeExample, "--view", "topology", "--format", "png", "-o", out]);
    expect(res.status).toBe(0);
    expect([...readFileSync(out).subarray(0, 8)]).toEqual(PNG_MAGIC);
  });
});
