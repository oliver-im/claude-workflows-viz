import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { losslessCompressPngSync, pngQuantizeSync } from "@napi-rs/image";
import { Resvg } from "@resvg/resvg-js";

/**
 * Draw a hand-placed "anatomy" annotation layer over the committed review-pr
 * render: a thin coral highlight box on each region + a small lettered pin, with
 * the prose kept in a single two-column "Anatomy" legend card in a band added
 * below the render (the keyed-callout + legend convention — keeps the diagram
 * itself clean, scales past a few labels). The band grows the image's *height*,
 * not its width, so the base render stays full-width (legible when embedded) and
 * the legend gets the whole canvas width to breathe.
 *
 * Pins A–L fall in two families (documented in docs/glossary.md §D), listed in one
 * card with a thin divider between them:
 *   - META (A–G): the declarative header + phase table — what the `meta` block says.
 *   - BODY (H–L): the graph analyze-body read out of the imperative half —
 *     node / shape / label / multiplicity / effort.
 *
 * Coordinates are LITERAL (tuned by eye against the base SVG), not computed: keep
 * it dumb, re-tune when the base render moves. The topology boxes live in the
 * PAGE frame; the base currently draws its graph in a `translate(344 0)` group
 * nested in a `translate(0 192)` group, so graph-local coordinates carry both
 * offsets. Re-tune these literals whenever the base render moves.
 * This is a docs-asset generator, not part of the renderer — it reads the
 * committed base SVG and writes a *separate* annotated SVG + PNG, leaving the
 * clean hero untouched.
 *
 * Because the pins are hand-tuned, a moved base silently misaligns them — and
 * simply re-running this script would not help: it would just redraw the same
 * literals over different content. So the base is PINNED by hash below, and both
 * this script and `ts/__tests__/anatomy-hero.test.ts` refuse a mismatch. That is
 * deliberately a human checkpoint, not an auto-fix: only eyes can confirm a pin
 * still points at the thing it names. (It is also why this script is not wired
 * into `regen-examples` — a hard stop there would block ordinary render work.)
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = join(root, "examples/level-2/review-pr.svg");
const outSvg = join(root, "examples/level-2/review-pr.annotated.svg");
const outPng = join(root, "examples/level-2/review-pr.annotated.png");

/**
 * sha256 of the base SVG the pin literals below were last tuned against. This is
 * a HUMAN assertion — "I looked at the output and every pin still points at the
 * thing it names" — so it is updated by hand, never by the script. Bumping it
 * without re-checking the pins defeats the entire guard.
 *
 * Re-tuning loop when the base moves: run `node scripts/annotate-anatomy.mjs
 * --retune` (which skips this check and prints the new hash), look at the PNG,
 * adjust the literals until the pins land, then paste the printed hash here.
 */
const TUNED_AGAINST_BASE_SHA256 = "865a7abc061efca652825e00009e7a8efef25371e64c610a9d4c6b13d15a0b69";

const ACCENT = "#c94f32";
const INK = "#0f172a";
const MUTED = "#475569";
const BAND_GAP = 16; // leaves room for the dashed boundary below the base render
const BAND_SIDE = 16; // left/right inset of the band card within the canvas width
const BAND_BOTTOM = 16; // whitespace below the band card

/** A gray section header printed ABOVE a pin group in the legend (headers scope
 * forward to the rows below them), keyed by `group`. */
const GROUP_HEADER = {
  meta: "Declared by the workflow",
  topo: "Repo terms, inferred from workflow",
};

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
  { group: "meta", x: 32, y: 41, w: 238, h: 30, label: "name", pinAt: "l" },
  { group: "meta", x: 32, y: 77, w: 567, h: 40, label: "description", pinAt: "l" },
  { group: "meta", x: 32, y: 125, w: 573, h: 38, label: "whenToUse", pinAt: "l" },
  { group: "meta", x: 66, y: 212, w: 98, h: 18, label: "title", pinAt: "r" },
  { group: "meta", x: 65, y: 233, w: 293, h: 51, label: "detail", pinAt: "r" },
  { group: "meta", x: 68, y: 288, w: 88, h: 14, label: "model", pinAt: "r" },
  { group: "meta", x: 30, y: 204, w: 394, h: 500, label: "phases", pinAt: "l" },

  // Body anatomy (H–K) — the graph (page frame = graph-local + (344,192)). In reading
  // order down the graph: node / shape / label / multiplicity — its whole vocabulary at
  // one altitude. Each label names the general concept; the gray sub is the instance
  // shown here (shape→fan-out, multiplicity→the ×N/unknown case). `stage` is NOT pinned:
  // in review-pr each pipeline stage lines up 1:1 with a phase (glossary §D).
  { group: "topo", x: 630, y: 225, w: 36, h: 36, label: "node", pinAt: "t", sub: "one agent() call" },
  // Pinned on the RIGHT: the left gutter of the fan is where the outer member's
  // effort badge sits, and a left pin lands on top of it.
  { group: "topo", x: 504, y: 350, w: 288, h: 58, label: "shape", pinAt: "r", sub: "orchestration strategies such as fan-out, branches, loop" },
  { group: "topo", x: 464, y: 408, w: 110, h: 17, label: "label", pinAt: "l" },
  { group: "topo", x: 655, y: 485, w: 28, h: 22, label: "multiplicity", pinAt: "r", sub: "count unknown until runtime" },
  // The badge left of the LAST node, not the first: the first node's badge sits
  // inside H's box, and the bottom of the graph is the only place a left-side pin
  // has clear canvas. Box stops at x=634 — the badge's own right edge — so it
  // never bites into the circle that starts at 635.
  { group: "topo", x: 610, y: 618, w: 24, h: 16, label: "effort", pinAt: "l", sub: "reasoning tier for this agent() call" },
];

const PIN_NUDGE = 12; // clears the box without pushing left-side pins outside the canvas

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

/** Quietly marks where the generated workflow PNG ends and the explanatory
 * anatomy band begins. No label: the change in card content supplies the meaning. */
function outputBoundary(baseW, baseH) {
  return `<line x1="${BAND_SIDE}" y1="${baseH}" x2="${baseW - BAND_SIDE}" y2="${baseH}" ` +
    `stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4 5" stroke-linecap="round"/>`;
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
 * The bottom "Anatomy" band: a full-width card below the base render, laid out as
 * two columns — the meta family (A–G) on the left, the body family (H–K) on the
 * right — each under its own gray header. Wider columns + larger type than a side
 * gutter allows, and it grows the image's height (not its width), so the embedded
 * render stays wide and legible. The array index is the pin letter, so band rows
 * and on-diagram boxes always match. Returns the card SVG plus its height (so the
 * caller can size the canvas to fit).
 */
function legendBand(items, baseW, baseH) {
  const x = BAND_SIDE;
  const w = baseW - BAND_SIDE * 2;
  const y = baseH + BAND_GAP;
  const pad = 24;
  const innerW = w - 2 * pad;
  const rightColX = x + pad + innerW / 2;

  // Group items in array order (each group is a contiguous run), keeping the pin
  // letter = array index. One column is laid out per group, left to right.
  const groups = [];
  items.forEach((a, i) => {
    let g = groups[groups.length - 1];
    if (!g || g.group !== a.group) {
      g = { group: a.group, rows: [] };
      groups.push(g);
    }
    g.rows.push({ a, i });
  });

  const colTop = y + 62; // first header baseline, below the "Anatomy" title
  const body = [];
  let maxY = colTop;
  groups.forEach((g, gi) => {
    const cx = gi === 0 ? x + pad : rightColX;
    let cy = colTop;
    if (GROUP_HEADER[g.group]) {
      body.push(`<text x="${cx}" y="${cy}" font-size="14" fill="${MUTED}" font-weight="600">${GROUP_HEADER[g.group]}</text>`);
      cy += 28;
    }
    g.rows.forEach(({ a, i }) => {
      body.push(pin(cx + 11, cy, key(i), 10));
      body.push(`<text x="${cx + 32}" y="${cy + 5}" font-size="14.5" fill="${INK}" font-weight="600">${a.label}</text>`);
      if (a.sub) {
        const subX = cx + 16;
        wrapSub(a.sub, 60).forEach((line, li) => {
          cy += li === 0 ? 18 : 16;
          body.push(`<text x="${subX}" y="${cy + 5}" font-size="12" fill="${MUTED}">${line}</text>`);
        });
      }
      cy += 28;
    });
    maxY = Math.max(maxY, cy);
  });

  const cardH = maxY - y + 4;
  return {
    svg:
      `<g class="legend-card">` +
      `<rect x="${x}" y="${y}" width="${w}" height="${cardH}" rx="12" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>` +
      `<text x="${x + pad}" y="${y + 36}" font-size="18" fill="${INK}" font-weight="700">Anatomy</text>` +
      body.join("") +
      `</g>`,
    height: cardH,
  };
}

const svg = readFileSync(base, "utf8");

// Guard: the pins are literals tuned against ONE base render. If the base moved,
// regenerating would draw them over different content — so stop, unless the
// caller is explicitly in the re-tuning loop.
const baseSha = createHash("sha256").update(svg).digest("hex");
const retune = process.argv.includes("--retune");
if (baseSha !== TUNED_AGAINST_BASE_SHA256) {
  const detail =
    `  tuned against ${TUNED_AGAINST_BASE_SHA256}\n` + `  base is now   ${baseSha}`;
  if (!retune) {
    throw new Error(
      `${base} has changed since the anatomy pins were tuned, so they may no longer\n` +
        `point at what they name.\n${detail}\n` +
        "  Re-run with --retune, check every pin in the output PNG, then paste the new\n" +
        "  hash into TUNED_AGAINST_BASE_SHA256 (and update docs/glossary.md §D if a pin moved).",
    );
  }
  console.warn(`Base render moved — regenerating anyway (--retune).\n${detail}`);
}

const vb = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
if (!vb) throw new Error(`base SVG missing a numeric viewBox: ${base}`);
const baseW = Number(vb[1]);
const baseH = Number(vb[2]);
const band = legendBand(annotations, baseW, baseH);
const newH = baseH + BAND_GAP + band.height + BAND_BOTTOM;

const layer = `<g class="anatomy">${boxLayer(annotations)}${outputBoundary(baseW, baseH)}${band.svg}</g>`;
const annotated = svg
  // Grow the canvas downward (width stays baseW); the on-diagram boxes are anchored
  // to base content and don't move. Extend the page-background rect to match.
  .replace(`width="${baseW}" height="${baseH}" viewBox`, `width="${baseW}" height="${newH}" viewBox`)
  .replace(`viewBox="0 0 ${baseW} ${baseH}"`, `viewBox="0 0 ${baseW} ${newH}"`)
  .replace(`<rect width="${baseW}" height="${baseH}" fill=`, `<rect width="${baseW}" height="${newH}" fill=`)
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
if (retune) {
  console.log(
    `\nOnce every pin still points at what it names, set\n` +
      `  TUNED_AGAINST_BASE_SHA256 = "${baseSha}"`,
  );
}

console.log(`Wrote ${outSvg} + ${outPng}`);
