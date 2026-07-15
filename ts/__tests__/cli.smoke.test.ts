import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { extractMeta } from "../extract-meta.js";
import { renderSvg } from "../render-svg.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const cli = join(root, "dist", "cli.js");
const fixture = join(here, "fixtures", "full.js");
const exoticFixture = join(here, "fixtures", "exotic-body.js");
const summarizeExample = join(root, "examples", "level-1", "summarize-codebase.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

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
    expect(res.stdout).toContain("--share");
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

  it("shares the selected SVG view and includes source only when requested", () => {
    const fakeGhDir = mkdtempSync(join(tmpdir(), "cwv-fake-gh-"));
    const fakeGhScript = join(fakeGhDir, "fake-gh.cjs");
    const capture = join(fakeGhDir, "capture.json");
    const script = [
      'const { readFileSync, writeFileSync } = require("node:fs");',
      'const { basename } = require("node:path");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "auth") process.exit(0);',
      "const files = args.slice(3);",
      "writeFileSync(process.env.CWV_SHARE_CAPTURE, JSON.stringify({ names: files.map((file) => basename(file)), image: readFileSync(files[0], 'utf8'), source: files[1] ? readFileSync(files[1], 'utf8') : null }));",
      'console.log("https://ghe.example/gists/cli-test");',
    ].join("\n");
    writeFileSync(fakeGhScript, `#!/usr/bin/env node\n${script}\n`);
    if (process.platform !== "win32") chmodSync(fakeGhScript, 0o755);
    const commandPath =
      process.platform === "win32" ? join(fakeGhDir, "gh.cmd") : join(fakeGhDir, "gh");
    if (process.platform === "win32") {
      writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${fakeGhScript}" %*\r\n`);
    } else {
      // A small shell wrapper keeps the command name exactly `gh` while the
      // script remains a normal temporary test fixture.
      writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeGhScript}" "$@"\n`);
      chmodSync(commandPath, 0o755);
    }

    const previousPath = process.env.PATH;
    const previousCapture = process.env.CWV_SHARE_CAPTURE;
    process.env.PATH = `${fakeGhDir}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
    process.env.CWV_SHARE_CAPTURE = capture;
    try {
      const res = runCli([summarizeExample, "--share", "--view", "topology"]);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).toContain("Shared workflow: https://ghe.example/gists/cli-test");
      const sharedWithoutSource = JSON.parse(readFileSync(capture, "utf8"));
      expect(sharedWithoutSource.names).toEqual(["workflow.svg"]);
      expect(sharedWithoutSource.image).toContain('class="topology"');
      expect(sharedWithoutSource.source).toBeNull();

      const sourceRes = runCli([summarizeExample, "--share", "--include-source"]);
      expect(sourceRes.status, sourceRes.stderr).toBe(0);
      const sharedWithSource = JSON.parse(readFileSync(capture, "utf8"));
      expect(sharedWithSource.names).toEqual(["workflow.svg", "workflow.js"]);
      expect(sharedWithSource.source).toBe(readFileSync(summarizeExample, "utf8"));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCapture === undefined) delete process.env.CWV_SHARE_CAPTURE;
      else process.env.CWV_SHARE_CAPTURE = previousCapture;
      rmSync(fakeGhDir, { recursive: true, force: true });
    }
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

  it("rejects combining --share with --out before invoking GitHub CLI", () => {
    const out = join(workDir, "share.svg");
    const res = runCli([fixture, "--share", "-o", out]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/cannot be combined with --out/i);
  });

  it("rejects a non-image format for --share", () => {
    const res = runCli([fixture, "--share", "--format", "json"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/uploads an image/i);
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

  it("never paints the tool version onto the rendered diagram", () => {
    const res = runCli([summarizeExample]);
    expect(res.status).toBe(0);
    // The version is knowable via `--version`, but a render is a pure function of
    // its `.js` input — no tool-version footer, no "vX.Y.Z" stamped into the image.
    expect(res.stdout).not.toContain('class="provenance"');
    expect(res.stdout).not.toContain(`v${pkg.version}`);
  });

  it("--view phases renders the byte-stable v1 page", () => {
    const res = runCli([summarizeExample, "--view", "phases"]);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("agent-node");
    // Byte-for-byte the v1 renderer's output (itself pinned by its snapshot
    // suite) — the permanent regression surface for the old view, now including
    // the provenance footer the CLI stamps.
    expect(res.stdout).toBe(renderSvg(extractMeta(summarizeExample)));
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
    expect(res.stdout).toBe(renderSvg(extractMeta(exoticFixture)));
  });

  it("--view topology falls back to the v1-equivalent page for an exotic body, exit 0", () => {
    const res = runCli([exoticFixture, "--view", "topology"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).not.toContain("agent-node");
    expect(res.stdout).toContain('class="phase-card"');
    expect(res.stdout).toBe(renderSvg(extractMeta(exoticFixture)));
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
    expect(res.stdout).toBe(renderSvg(extractMeta(unknownFixture)));
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
