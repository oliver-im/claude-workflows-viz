/**
 * Wrap a standalone SVG in a minimal, self-contained HTML page for
 * `--format html` (and for `--open`-ing in a browser). No external assets: the
 * SVG is inlined verbatim — it is already SVG/XML-escaped by the renderer, and
 * inline SVG is valid HTML5 foreign content. Only `title` needs HTML escaping.
 * `background` is the page color around the diagram — the theme's page color,
 * so a dark render isn't framed in white.
 */
export function wrapSvgHtml(svg: string, title: string, background = "#f8fafc"): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8">',
    `<title>${htmlEscape(title)}</title>`,
    `<style>body{margin:0;background:${background};display:flex;justify-content:center;padding:24px}</style>`,
    "</head>",
    `<body>${svg}</body>`,
    "</html>",
    "",
  ].join("\n");
}

function htmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
