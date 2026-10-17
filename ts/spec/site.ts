import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Marked, type Tokens } from "marked";
import { levelAt } from "../grammar.js";
import { listCaptures } from "./capture.js";
import { generateSpec } from "./index.js";

/**
 * The readable `spec/` as one HTML page: the language reference, the newest
 * capture's text, and every change page, rendered from the very Markdown
 * `npm run spec` writes (plus the hand-written reference) — so the page has no
 * content of its own and cannot disagree with the files on GitHub. What it adds
 * is presentation GitHub can't give: colored word diffs, a dark mode in the
 * diagrams' palette, and one place to read it all.
 *
 * Links between the included documents become in-page anchors; links to the rest
 * of the repo point at it on GitHub. The output is deterministic (no dates), and
 * self-contained: one file, no scripts, no external requests.
 */

export const REPO_URL = "https://github.com/oliver-im/claude-workflows-viz";

interface Doc {
  /** Repo-relative path of the Markdown source. */
  path: string;
  /** Id prefix for this document's headings and its in-page anchor. */
  id: string;
  /** Short label for the navigation. */
  nav: string;
  markdown: string;
  /** Levels to demote this document's headings by on the page. */
  demote: number;
  /** Drop the document's own H1 (the page header already says it). */
  hideTitle?: boolean;
}

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, "")
    .replace(/\s/g, "-");
}

const stripTags = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Render one document, demoting its headings a level and rewriting its links. */
function renderDoc(doc: Doc, byPath: Map<string, Doc>): { html: string; headings: Array<{ id: string; text: string }> } {
  const headings: Array<{ id: string; text: string }> = [];
  const seen = new Map<string, number>();
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth === 1 && doc.hideTitle) return "";
        let id = doc.id;
        if (token.depth > 1) {
          const base = `${doc.id}-${slug(stripTags(inner))}`;
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          id = n === 0 ? base : `${base}-${n}`;
        }
        if (token.depth === 2) headings.push({ id, text: stripTags(inner) });
        const level = Math.min(6, token.depth + doc.demote);
        return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${level}>\n`;
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        const href = resolveHref(token.href, doc, byPath);
        const external = /^https?:/.test(href) && !href.startsWith("#");
        return `<a href="${escapeAttr(href)}"${external ? ' rel="noopener"' : ""}>${inner}</a>`;
      },
    },
  });
  return { html: md.parse(doc.markdown) as string, headings };
}

/** Where a link in `doc` should go on the page: an anchor if it targets an included document, GitHub otherwise. */
function resolveHref(href: string, doc: Doc, byPath: Map<string, Doc>): string {
  if (/^[a-z]+:/i.test(href)) return href;
  if (href.startsWith("#")) return `#${doc.id}-${href.slice(1)}`;
  const [pathPart, hash] = href.split("#") as [string, string | undefined];
  const resolved = posix.normalize(posix.join(posix.dirname(doc.path), pathPart));
  const target = byPath.get(resolved);
  if (target) return hash ? `#${target.id}-${hash}` : `#${target.id}`;
  const kind = pathPart.endsWith("/") || pathPart === "" ? "tree" : "blob";
  return `${REPO_URL}/${kind}/main/${resolved.replace(/\/$/, "")}${pathPart.endsWith("/") ? "/" : ""}${hash ? `#${hash}` : ""}`;
}

/** The whole page. */
export function generateSite(root: string): string {
  const captures = listCaptures(join(root, "spec", "upstream"));
  const newest = captures[captures.length - 1];
  const generated = new Map(generateSpec(root).map((f) => [f.path, f.content]));
  const read = (path: string) => generated.get(path) ?? readFileSync(join(root, path), "utf8");

  const docs: Doc[] = [
    { path: "spec/README.md", id: "reference", nav: "Reference", markdown: read("spec/README.md"), demote: 1, hideTitle: true },
    {
      path: "spec/workflow-tool-description.md",
      id: "tool-description",
      nav: `Tool description · cc-${newest.ccVersion}`,
      markdown: read("spec/workflow-tool-description.md"),
      demote: 1,
    },
    ...captures
      .slice(1)
      .reverse()
      .map((c) => ({
        path: `spec/upstream/${c.id}/CHANGES.md`,
        id: `changes-${c.ccVersion.replace(/\./g, "-")}`,
        nav: `cc-${c.ccVersion}`,
        markdown: read(`spec/upstream/${c.id}/CHANGES.md`),
        demote: 2,
      })),
  ];
  const byPath = new Map(docs.map((d) => [d.path, d]));
  // The newest capture's own page is the same text as the fixed-path copy.
  byPath.set(`spec/upstream/${newest.id}/workflow-tool-description.md`, docs[1]);

  const rendered = docs.map((d) => ({ doc: d, ...renderDoc(d, byPath) }));
  const [reference, description, ...changes] = rendered;

  const nav = [
    `<p class="nav-head"><a href="#reference">Reference</a></p>`,
    `<ul>${reference.headings.map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join("")}</ul>`,
    `<p class="nav-head"><a href="#tool-description">${escapeHtml(description.doc.nav)}</a></p>`,
    `<p class="nav-head"><a href="#changes">What changed</a></p>`,
    `<ul>${changes.map((c) => `<li><a href="#${c.doc.id}">${escapeHtml(c.doc.nav)}</a></li>`).join("")}</ul>`,
  ].join("\n");

  const main = [
    `<section class="doc" id="reference">${reference.html}</section>`,
    `<section class="doc">${description.html}</section>`,
    `<section class="doc" id="changes"><h2 class="part">What changed, capture by capture</h2>${changes
      .map((c) => `<div class="change">${c.html}</div>`)
      .join("\n")}</section>`,
  ].join("\n");

  return page({
    title: "The workflow language",
    subtitle:
      `An unofficial reference for Claude Code dynamic workflows, quoted from the Workflow tool description. ` +
      `Newest capture: cc-${newest.ccVersion} (${newest.capturedOn}), grammar level ${levelAt(newest.ccVersion)}.`,
    nav,
    main,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function page(p: { title: string; subtitle: string; nav: string; main: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(p.title)}</title>
<meta name="description" content="${escapeAttr(p.subtitle)}">
<style>
${CSS}
</style>
</head>
<body>
<header class="top">
  <div class="top-inner">
    <h1><a href="#reference">${escapeHtml(p.title)}</a></h1>
    <p>${escapeHtml(p.subtitle)}</p>
    <p class="repo"><a href="${REPO_URL}/tree/main/spec" rel="noopener">Source on GitHub</a> · Not an Anthropic document</p>
  </div>
</header>
<div class="layout">
<nav class="toc" aria-label="Contents">
${p.nav}
</nav>
<main>
${p.main}
<footer>Generated by <code>npm run spec:site</code> from the captures in <code>spec/upstream/</code>, which stay the authority. Not affiliated with Anthropic.</footer>
</main>
</div>
</body>
</html>
`;
}

/**
 * The palette follows the diagrams (`theme.ts` on the renderer side): slate ink on
 * a near-white page, GitHub's dark surfaces in dark mode, and a single warm accent.
 * In a change excerpt, removed text (`~~…~~`) is red and struck through and added
 * text (`**…**`) green and bold — the one place color carries meaning here.
 */
const CSS = `
:root {
  --page: #f8fafc; --card: #ffffff; --border: #e2e8f0; --ink: #0f172a; --body: #334155;
  --muted: #64748b; --accent: #c2410c; --code-bg: #f1f5f9; --quote: #cbd5e1;
  --del-bg: #fee2e2; --del-ink: #991b1b; --ins-bg: #dcfce7; --ins-ink: #166534;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --mono: Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d1117; --card: #161b22; --border: #30363d; --ink: #e6edf3; --body: #c9d1d9;
    --muted: #8b949e; --accent: #f0883e; --code-bg: #1f2630; --quote: #3d444d;
    --del-bg: #4a1d1f; --del-ink: #ffb4ad; --ins-bg: #173b25; --ins-ink: #9be9a8;
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 16px; }
body { margin: 0; background: var(--page); color: var(--body); font: 15px/1.65 var(--sans); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.top { border-bottom: 1px solid var(--border); background: var(--card); }
.top-inner { max-width: 1160px; margin: 0 auto; padding: 28px 24px 20px; }
.top h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.01em; }
.top h1 a { color: var(--ink); }
.top p { margin: 0; max-width: 760px; color: var(--muted); }
.top .repo { margin-top: 8px; font-size: 13px; }
.layout { max-width: 1160px; margin: 0 auto; display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 32px; padding: 0 24px; }
.toc { position: sticky; top: 0; align-self: start; max-height: 100vh; overflow-y: auto; padding: 24px 0; font-size: 13.5px; }
.toc ul { list-style: none; margin: 4px 0 14px; padding: 0 0 0 10px; border-left: 1px solid var(--border); }
.toc li { margin: 2px 0; }
.toc li a { color: var(--body); }
.toc .nav-head { margin: 0; font-weight: 600; }
.toc .nav-head a { color: var(--ink); }
main { min-width: 0; padding: 8px 0 48px; }
.doc { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 8px 32px 24px; margin: 24px 0; }
.change { border-top: 1px solid var(--border); margin-top: 24px; }
.change:first-of-type { border-top: 0; margin-top: 0; }
h2, h3, h4, h5 { color: var(--ink); line-height: 1.3; position: relative; }
h2 { font-size: 24px; margin: 28px 0 12px; }
h3 { font-size: 19px; margin: 32px 0 10px; padding-top: 4px; }
h4 { font-size: 16px; margin: 24px 0 8px; }
h2.part { font-size: 24px; }
.anchor { position: absolute; left: -18px; color: var(--muted); opacity: 0; font-weight: 400; }
h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { opacity: 1; }
p, li { max-width: 78ch; }
code { font-family: var(--mono); font-size: 0.88em; background: var(--code-bg); border-radius: 4px; padding: 0.1em 0.35em; }
pre { background: var(--code-bg); border-radius: 8px; padding: 14px 16px; overflow-x: auto; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
pre code { background: none; padding: 0; font-size: 13px; }
blockquote { margin: 12px 0; padding: 2px 0 2px 16px; border-left: 3px solid var(--quote); color: var(--body); }
table { border-collapse: collapse; margin: 14px 0; display: block; overflow-x: auto; max-width: 100%; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--code-bg); color: var(--ink); font-weight: 600; }
.change blockquote del { background: var(--del-bg); color: var(--del-ink); text-decoration: line-through; border-radius: 3px; padding: 0 2px; }
.change blockquote strong { background: var(--ins-bg); color: var(--ins-ink); border-radius: 3px; padding: 0 2px; }
hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
footer { color: var(--muted); font-size: 13px; padding: 8px 4px; }
@media (max-width: 900px) {
  .layout { display: block; padding: 0 16px; }
  .toc { position: static; max-height: none; padding: 16px 0 0; }
  .doc { padding: 4px 18px 18px; }
  .top-inner { padding: 22px 16px 16px; }
  .anchor { display: none; }
}
`;
