/**
 * Wrap a standalone SVG in a minimal, self-contained HTML page for
 * `--format html` (and for `--open`-ing in a browser). No external assets: the
 * SVG is inlined verbatim — it is already SVG/XML-escaped by the renderer, and
 * inline SVG is valid HTML5 foreign content. Only `title` needs HTML escaping.
 */
export function wrapSvgHtml(svg: string, title: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8">',
    `<title>${htmlEscape(title)}</title>`,
    "<style>body{margin:0;background:#f8fafc;display:flex;justify-content:center;padding:24px}</style>",
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
