import { describe, expect, it } from "vitest";
import { renderSvg } from "../render-svg.js";
import type { Meta } from "../model.js";

const meta = (over: Partial<Meta> = {}): Meta => ({
  name: "Find flaky tests",
  description: "Detect and fix flaky tests across the suite.",
  phases: [],
  ...over,
});

describe("renderSvg", () => {
  it("produces a well-formed svg root with integer dimensions", () => {
    const svg = renderSvg(meta());
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toMatch(/width="\d+" height="\d+"/);
    // Every <g> is closed — a cheap balance check on the structure.
    const opens = svg.match(/<g\b/g)?.length ?? 0;
    const closes = svg.match(/<\/g>/g)?.length ?? 0;
    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThan(0);
  });

  it("emits one card group per phase, badged with the model's color", () => {
    const svg = renderSvg(
      meta({
        phases: [
          { title: "Scan", detail: "Grep CI logs", model: "haiku" },
          { title: "Triage", detail: "Cluster failures", model: "sonnet" },
          { title: "Fix", detail: "Patch and verify", model: "claude-opus-4-8" },
        ],
      }),
    );
    expect(svg.match(/class="phase-card"/g)?.length).toBe(3);
    expect(svg).toContain("#dbeafe"); // haiku fill
    expect(svg).toContain("#dcfce7"); // sonnet fill
    expect(svg).toContain("#ede9fe"); // opus fill, matched via substring on the full id
    expect(svg).toContain("claude-opus-4-8"); // badge keeps the full label
  });

  it("renders just the header for the no-phases case", () => {
    const svg = renderSvg(meta());
    expect(svg).toContain('class="header-card"');
    expect(svg).not.toContain('class="phase-card"');
    expect(svg).toContain("Find flaky tests");
  });

  it("renders a phase with no detail (title + chip + badge only)", () => {
    const svg = renderSvg(meta({ phases: [{ title: "Just a title", model: "opus" }] }));
    expect(svg.match(/class="phase-card"/g)?.length).toBe(1);
    expect(svg).toContain("Just a title");
  });

  it("falls back to a neutral badge for an unknown model", () => {
    const svg = renderSvg(meta({ phases: [{ title: "X", model: "gpt-5" }] }));
    expect(svg).toContain("#f1f5f9"); // fallback fill
    expect(svg).toContain("gpt-5");
  });

  it("escapes <, >, &, and \" in every label (name, description, whenToUse, title, detail, model)", () => {
    const svg = renderSvg(
      meta({
        name: 'A <b> & "c"',
        description: "1 < 2 & 3 > 0",
        whenToUse: 'use when x < y & "z"',
        phases: [{ title: 'P <x> & "y"', detail: 'd <z> & "w"', model: 'm<o>&"d"' }],
      }),
    );
    expect(svg).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(svg).toContain("1 &lt; 2 &amp; 3 &gt; 0");
    expect(svg).toContain("use when x &lt; y &amp; &quot;z&quot;");
    expect(svg).toContain("P &lt;x&gt; &amp; &quot;y&quot;");
    expect(svg).toContain("d &lt;z&gt; &amp; &quot;w&quot;");
    expect(svg).toContain('m&lt;o&gt;&amp;&quot;d&quot;'); // model badge label
    // No raw angle-bracket payloads leaked into the markup.
    for (const raw of ["<b>", "<x>", "<y>", "<z>", "<o>"]) {
      expect(svg).not.toContain(raw);
    }
  });

  it("caps an overlong model label so the badge can't blow out the card", () => {
    const longModel = "x".repeat(120);
    const svg = renderSvg(meta({ phases: [{ title: "T", model: longModel }] }));
    expect(svg).not.toContain(longModel); // full label never emitted
    expect(svg).toContain("…"); // truncated with an ellipsis
    expect(svg.match(/class="phase-card"/g)?.length).toBe(1);
  });

  it("is deterministic for the same input", () => {
    const m = meta({ phases: [{ title: "A", detail: "b", model: "opus" }] });
    expect(renderSvg(m)).toBe(renderSvg(m));
  });

  it("matches the representative snapshot", () => {
    const svg = renderSvg(
      meta({
        whenToUse: "When CI is intermittently red",
        phases: [
          { title: "Scan", detail: "Grep CI logs for retry markers", model: "haiku" },
          { title: "Triage", detail: "Cluster failures by root cause", model: "sonnet" },
          { title: "Fix", detail: "Patch each flaky test and re-run", model: "opus" },
        ],
      }),
    );
    expect(svg).toMatchSnapshot();
  });
});
