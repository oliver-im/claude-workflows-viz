import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMetaFromProgram, parseWorkflowSource } from "../extract-meta.js";
import { buildShareArtifacts } from "../share-artifacts.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "full.js");
const source = readFileSync(fixture, "utf8");
const program = parseWorkflowSource(source);
const meta = extractMetaFromProgram(program);

describe("buildShareArtifacts", () => {
  it("builds an SVG for the selected topology view without source by default", () => {
    const artifacts = buildShareArtifacts({
      meta,
      program,
      src: source,
      format: "svg",
      includeSource: false,
      view: "topology",
    });

    expect(artifacts.image.filename).toBe("workflow.svg");
    expect(artifacts.image.data).toContain('class="topology"');
    expect(artifacts.image.data).not.toContain('class="header-card"');
    expect(artifacts.source).toBeUndefined();
  });

  it("uses the phases renderer for the phases view", () => {
    const artifacts = buildShareArtifacts({
      meta,
      program,
      src: source,
      format: "svg",
      includeSource: true,
      view: "phases",
    });

    expect(artifacts.image.filename).toBe("workflow.svg");
    expect(artifacts.image.data).toContain('class="phase-card"');
    expect(artifacts.image.data).not.toContain('class="agent-node"');
    expect(artifacts.source).toBe(source);
  });

  it("builds a PNG when the share format is png", () => {
    const artifacts = buildShareArtifacts({
      meta,
      program,
      src: source,
      format: "png",
      includeSource: false,
      view: "workflow",
    });

    expect(artifacts.image.filename).toBe("workflow.png");
    expect(Buffer.isBuffer(artifacts.image.data)).toBe(true);
    expect((artifacts.image.data as Buffer).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});
