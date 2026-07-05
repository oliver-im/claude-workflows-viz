import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { losslessCompressPngSync, pngQuantizeSync } from "@napi-rs/image";
import { Resvg } from "@resvg/resvg-js";

/**
 * Draw a hand-placed "anatomy" annotation layer over the committed review-pr
 * render: a thin coral highlight box on each region + a small lettered pin, with
 * the prose kept in a single "Anatomy" legend card in an added right-hand gutter
 * (the keyed-callout + legend convention — keeps the diagram itself clean, scales
 * past a few labels).
 *
 * Pins A–K fall in two families (documented in docs/glossary.md §D), listed in one
 * card with a thin divider between them:
 *   - META (A–G): the declarative header + phase table — what the `meta` block says.
 *   - BODY (H–K): the graph analyze-body read out of the imperative half —
 *     node / shape / label / multiplicity.
 *
 * Coordinates are LITERAL (tuned by eye against the base SVG), not computed: keep
 * it dumb, re-tune when the base render moves. The topology boxes live in the
 * PAGE frame; the base draws its graph in a `translate(350 0)` group nested in a
 * `translate(0 204)` group, so a graph-local (x,y) lands at page (x+350, y+204).
 * This is a docs-asset generator, not part of the renderer — it reads the
 * committed base SVG and writes a *separate* annotated SVG + PNG, leaving the
 * clean hero untouched.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = join(root, "examples/level-1/review-pr.svg");
const outSvg = join(root, "examples/level-1/review-pr.annotated.svg");
const outPng = join(root, "examples/level-1/review-pr.annotated.png");

const ACCENT = "#e8694a";
const INK = "#0f172a";
const MUTED = "#475569";
const LEGEND_W = 258; // Anatomy card width
const LEGEND_PULL = 8; // px the card reaches back over the base's empty right padding (content ends ~x841, canvas is wider)
const LEGEND_MARGIN = 16; // whitespace to the right of the card

/** A gray section header printed ABOVE a pin group in the legend (headers scope
 * forward to the rows below them), keyed by `group`. */
const GROUP_HEADER = { meta: "Defined via workflow" };

/**
 * Literal callout boxes over the base render, in reading order (pin letters are
 * assigned by array index: A, B, C…). `label` names the region; `sub` is an
 * optional gray one-liner shown under it in the legend. `group` picks the legend
 * card ("meta" header/table vs "topo" body graph). Tune x/y/w/h by eye.
 */
const annotations = [
  // Meta anatomy (A–G) — the header card + phase table (page frame). Boxes hug the
  // measured text bbox + ~7px pad (rendered-pixel extents, not eyeballed): so B/C stop
  // at the real line end (~600), E clears G's right edge, phases (G) is wide enough that
  // the E marker sits inside it.
  { group: "meta", x: 40, y: 49, w: 238, h: 30, label: "name", pinAt: "l" },
  { group: "meta", x: 40, y: 85, w: 567, h: 40, label: "description", pinAt: "l" },
  { group: "meta", x: 40, y: 133, w: 573, h: 38, label: "whenToUse", pinAt: "l" },
  { group: "meta", x: 74, y: 236, w: 98, h: 18, label: "title", pinAt: "r" },
  { group: "meta", x: 73, y: 257, w: 293, h: 51, label: "detail", pinAt: "r" },
  { group: "meta", x: 76, y: 312, w: 88, h: 14, label: "model", pinAt: "r" },
  { group: "meta", x: 38, y: 228, w: 358, h: 500, label: "phases", pinAt: "l" },

  // Body anatomy (H–K) — the graph (page frame = graph-local + (350,204)). In reading
  // order down the graph: node / shape / label / multiplicity — its whole vocabulary at
  // one altitude. Each label names the general concept; the gray sub is the instance
  // shown here (shape→fan-out, multiplicity→the ×N/unknown case). `stage` is NOT pinned:
  // in review-pr each pipeline stage lines up 1:1 with a phase (glossary §D).
  { group: "topo", x: 636, y: 249, w: 36, h: 36, label: "node", pinAt: "t", sub: "one agent() call" },
  { group: "topo", x: 606, y: 372, w: 96, h: 28, label: "shape", pinAt: "l", sub: "orchestration strategies such as fan-out, branches, loop" },
  { group: "topo", x: 470, y: 432, w: 110, h: 17, label: "label", pinAt: "l" },
  { group: "topo", x: 661, y: 509, w: 28, h: 22, label: "multiplicity", pinAt: "r", sub: "count unknown until runtime" },
];

const PIN_NUDGE = 20; // how far a side-anchored pin sits outside its box, in whitespace

/**
 * Where the pin sits relative to its box. Corners `tl`/`tr`/`bl`/`br` land on the
 * box; sides `l`/`r`/`t`/`b` sit centered and nudged *outside* the box (into
 * whitespace), so a pin never covers the content it points at.
 */
function pinXY(a) {
  if (a.pinX !== undefined && a.pinY !== undefined) return [a.pinX, a.pinY];
  const at = a.pinAt || "tl";
  const midX = a.x + a.w / 2;
  const midY = a.y + a.h / 2;
  switch (at) {
    case "l":
      return [a.x - PIN_NUDGE, midY];
    case "r":
      return [a.x + a.w + PIN_NUDGE, midY];
    case "t":
      return [midX, a.y - PIN_NUDGE];
    case "b":
      return [midX, a.y + a.h + PIN_NUDGE];
    default:
      return [at.includes("r") ? a.x + a.w : a.x, at.includes("b") ? a.y + a.h : a.y];
  }
}

/** The keyed pin label for annotation `i`: letters A, B, C… (letters, not numbers,
 * so anatomy pins never read as the diagram's own navy phase chips 1–4). */
const key = (i) => String.fromCharCode(65 + i);

/** A lettered coral pin — used both on the diagram and in the legend. */
function pin(cx, cy, k, r = 10) {
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ACCENT}"/>` +
    `<text x="${cx}" y="${cy + r * 0.4}" font-size="${r + 2}" fill="#ffffff" ` +
    `font-weight="700" text-anchor="middle">${k}</text>`
  );
}

/** Thin highlight boxes + pins over the diagram (largest first so a big box
 * never paints over the pin of a small one nested inside it). */
function boxLayer(items) {
  const parts = [];
  const drawOrder = items
    .map((a, i) => ({ a, i }))
    .sort((left, right) => right.a.w * right.a.h - left.a.w * left.a.h);
  drawOrder.forEach(({ a, i }) => {
    parts.push(
      `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="6" ` +
        `fill="none" stroke="${ACCENT}" stroke-width="1.25"/>`,
    );
    const [px, py] = pinXY(a);
    parts.push(pin(px, py, key(i)));
  });
  return parts.join("");
}

/** Greedy word-wrap for a legend sub-line: split into lines of at most `max`
 * characters (approximate — the legend font is not measured). */
function wrapSub(s, max = 34) {
  const lines = [];
  let cur = "";
  for (const word of s.split(" ")) {
    if (cur && `${cur} ${word}`.length > max) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * The gutter's single "Anatomy" card: title + one keyed row per annotation
 * (pin + label + optional wrapped gray sub), A–K in one list, with a thin divider
 * where the meta group gives way to the body group. Auto-sizes to its rows; the
 * array index is the pin letter, so legend and on-diagram boxes always match.
 */
function legendLayer(items, baseW) {
  const x = baseW - LEGEND_PULL;
  const w = LEGEND_W;
  const pad = 18;
  const yTop = 24;
  const body = [];
  let y = yTop + 56; // baseline of the first header/row
  let prevGroup = null;
  items.forEach((a, i) => {
    if (a.group !== prevGroup) {
      if (prevGroup !== null) {
        y += 8;
        body.push(`<line x1="${x + pad}" y1="${y}" x2="${x + w - pad}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>`);
        y += 24;
      }
      if (GROUP_HEADER[a.group]) {
        body.push(`<text x="${x + pad}" y="${y}" font-size="12" fill="${MUTED}" font-weight="600">${GROUP_HEADER[a.group]}</text>`);
        y += 26;
      }
    }
    prevGroup = a.group;
    body.push(pin(x + 24, y, key(i), 9));
    body.push(`<text x="${x + 40}" y="${y + 4}" font-size="13" fill="${INK}" font-weight="600">${a.label}</text>`);
    if (a.sub) {
      wrapSub(a.sub).forEach((line, li) => {
        y += li === 0 ? 17 : 15;
        body.push(`<text x="${x + 40}" y="${y + 4}" font-size="11.5" fill="${MUTED}">${line}</text>`);
      });
    }
    y += 30;
  });
  const cardH = y - 8 - yTop;
  return (
    `<g class="legend-card">` +
    `<rect x="${x}" y="${yTop}" width="${w}" height="${cardH}" rx="10" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>` +
    `<text x="${x + pad}" y="${yTop + 28}" font-size="15" fill="${INK}" font-weight="700">Anatomy</text>` +
    body.join("") +
    `</g>`
  );
}

const svg = readFileSync(base, "utf8");
const vb = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
if (!vb) throw new Error(`base SVG missing a numeric viewBox: ${base}`);
const baseW = Number(vb[1]);
const baseH = Number(vb[2]);
const newW = baseW - LEGEND_PULL + LEGEND_W + LEGEND_MARGIN;

const layer = `<g class="anatomy">${boxLayer(annotations)}${legendLayer(annotations, baseW)}</g>`;
const annotated = svg
  .replaceAll(`width="${baseW}"`, `width="${newW}"`)
  .replace(`viewBox="0 0 ${baseW} ${baseH}"`, `viewBox="0 0 ${newW} ${baseH}"`)
  .replace("</svg>", `${layer}</svg>`);
writeFileSync(outSvg, annotated);

const raw = new Resvg(annotated, { fitTo: { mode: "zoom", value: 2 } }).render().asPng();
let quantized;
try {
  quantized = pngQuantizeSync(raw, { maxQuality: 100, speed: 1 });
} catch {
  quantized = raw;
}
writeFileSync(outPng, losslessCompressPngSync(quantized, { strip: true }));

console.log(`Wrote ${outSvg} + ${outPng}`);
