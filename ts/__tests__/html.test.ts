import { describe, expect, it } from "vitest";
import { wrapSvgHtml } from "../html.js";

describe("wrapSvgHtml", () => {
  it("inlines the SVG verbatim inside a valid HTML skeleton", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    const html = wrapSvgHtml(svg, "My workflow");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(svg); // SVG body embedded as-is (already SVG/XML-escaped)
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("HTML-escapes the title so a hostile name can't break out", () => {
    const html = wrapSvgHtml("<svg></svg>", 'A <b> & "c"');
    expect(html).toContain("<title>A &lt;b&gt; &amp; &quot;c&quot;</title>");
    expect(html).not.toContain("<b>"); // raw angle-bracket payload never reaches the markup
  });
});
