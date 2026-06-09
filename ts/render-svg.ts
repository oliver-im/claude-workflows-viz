import type { Meta, Phase } from "./model.js";

/**
 * Render a workflow `Meta` as a standalone SVG string: a header card
 * (name + description + optional "when to use"), then a vertical stack of
 * phase cards — each an index chip, a single-line title, wrapped detail text,
 * and a model-colored badge. Pure layout: every coordinate is computed here,
 * with no external layout engine (phases are already ordered, so the flow is
 * a deliberate vertical stack — dependency layering is out of scope for v1).
 */
export function renderSvg(meta: Meta): string {
  const blocks: Block[] = [renderHeader(meta)];
  meta.phases.forEach((phase, i) => blocks.push(renderPhaseCard(phase, i + 1)));

  let y = MARGIN;
  const placed: string[] = [];
  for (const block of blocks) {
    placed.push(`<g transform="translate(0 ${y})">${block.body}</g>`);
    y += block.height + GAP;
  }
  const height = y - GAP + MARGIN;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" ` +
    `viewBox="0 0 ${W} ${height}" ` +
    `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">\n` +
    `<rect width="${W}" height="${height}" fill="#f8fafc"/>\n` +
    placed.join("\n") +
    `\n</svg>\n`
  );
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const W = 760;
const MARGIN = 24;
const GAP = 16;
const CARD_X = MARGIN;
const CARD_W = W - 2 * MARGIN;

interface Block {
  body: string;
  height: number;
}

// ---------------------------------------------------------------------------
// Model → color, adapted from planview's mermaid classDefs. Matched by
// substring so a full model id (e.g. "claude-opus-4-8") still resolves; an
// unrecognized model falls back to a neutral slate swatch.
// ---------------------------------------------------------------------------

interface Swatch {
  fill: string;
  stroke: string;
  text: string;
}

const MODEL_SWATCHES: ReadonlyArray<readonly [string, Swatch]> = [
  ["opus", { fill: "#ede9fe", stroke: "#8b5cf6", text: "#3b0764" }],
  ["sonnet", { fill: "#dcfce7", stroke: "#22c55e", text: "#14532d" }],
  ["haiku", { fill: "#dbeafe", stroke: "#3b82f6", text: "#1e3a5f" }],
];
const MODEL_FALLBACK: Swatch = {
  fill: "#f1f5f9",
  stroke: "#94a3b8",
  text: "#334155",
};

function swatchFor(model: string): Swatch {
  const m = model.toLowerCase();
  for (const [key, swatch] of MODEL_SWATCHES) {
    if (m.includes(key)) return swatch;
  }
  return MODEL_FALLBACK;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function renderHeader(meta: Meta): Block {
  const padX = 22;
  const padTop = 26;
  const padBottom = 22;
  const x = CARD_X + padX;
  const innerW = CARD_W - 2 * padX;

  const name = truncateToWidth(meta.name, innerW, 22);
  const descLines = wrapToWidth(meta.description, innerW, 13.5, 3);
  const whenLines = meta.whenToUse
    ? wrapToWidth(`When to use — ${meta.whenToUse}`, innerW, 12.5, 2)
    : [];

  const parts: string[] = [];
  let baseline = padTop + 22;
  parts.push(text(x, baseline, name, { size: 22, weight: 700, fill: "#0f172a" }));

  if (descLines.length > 0) {
    baseline += 10;
    for (const line of descLines) {
      baseline += 19;
      parts.push(text(x, baseline, line, { size: 13.5, fill: "#475569" }));
    }
  }
  if (whenLines.length > 0) {
    baseline += 12;
    for (const line of whenLines) {
      baseline += 17;
      parts.push(
        text(x, baseline, line, { size: 12.5, style: "italic", fill: "#64748b" }),
      );
    }
  }

  const height = baseline + padBottom;
  const card = roundRect(CARD_X, 0, CARD_W, height, 12, "#ffffff", "#e2e8f0");
  return { body: `<g class="header-card">${card}${parts.join("")}</g>`, height };
}

function renderPhaseCard(phase: Phase, index: number): Block {
  const padX = 18;
  const padTop = 16;
  const padBottom = 16;
  const chipR = 13;
  const chipCx = CARD_X + padX + chipR;
  const textX = CARD_X + padX + 2 * chipR + 14;
  const rightX = CARD_X + CARD_W - padX;

  // Optional model badge, sized to its label and pinned to the card's top-right.
  const model = phase.model?.trim();
  let badge = "";
  let badgeWidth = 0;
  if (model) {
    const swatch = swatchFor(model);
    // Cap the displayed label so a pathologically long model string can't size
    // the badge past the card's left edge into the chip/title. Color still keys
    // off the full model (substring match). 28 fits real ids (e.g.
    // "claude-3-5-sonnet-20241022").
    const label = truncatePlain(model, 28);
    const font = 11.5;
    const badgeH = 20;
    badgeWidth = Math.ceil(label.length * font * 0.62) + 18;
    const bx = rightX - badgeWidth;
    const by = padTop + (22 - badgeH) / 2;
    badge =
      roundRect(bx, by, badgeWidth, badgeH, 10, swatch.fill, swatch.stroke) +
      text(bx + badgeWidth / 2, by + 14, label, {
        size: font,
        weight: 600,
        fill: swatch.text,
        anchor: "middle",
      });
  }

  // Single-line title, fit to the room left of the badge; wrapped detail below.
  const titleWidth = (model ? rightX - badgeWidth - 10 : rightX) - textX;
  const title = truncateToWidth(phase.title, titleWidth, 16);
  const detail = phase.detail?.trim();
  const detailLines = detail ? wrapToWidth(detail, rightX - textX, 13, 3) : [];

  const titleBaseline = padTop + 16;
  const detailEls: string[] = [];
  let baseline = titleBaseline;
  for (const line of detailLines) {
    baseline += 18;
    detailEls.push(text(textX, baseline, line, { size: 13, fill: "#475569" }));
  }
  const height = (detailLines.length > 0 ? baseline : titleBaseline) + padBottom;

  const chipCy = padTop + chipR;
  const parts = [
    roundRect(CARD_X, 0, CARD_W, height, 10, "#ffffff", "#e2e8f0"),
    `<circle cx="${chipCx}" cy="${chipCy}" r="${chipR}" fill="#334155"/>`,
    text(chipCx, chipCy + 4, String(index), {
      size: 12.5,
      weight: 700,
      fill: "#ffffff",
      anchor: "middle",
    }),
    text(textX, titleBaseline, title, { size: 16, weight: 700, fill: "#0f172a" }),
    badge,
    ...detailEls,
  ];
  return { body: `<g class="phase-card">${parts.join("")}</g>`, height };
}

// ---------------------------------------------------------------------------
// SVG primitives + text fitting
// ---------------------------------------------------------------------------

interface TextOpts {
  size: number;
  fill: string;
  weight?: number;
  style?: string;
  anchor?: string;
}

function text(x: number, y: number, content: string, o: TextOpts): string {
  const attrs = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `font-size="${o.size}"`,
    `fill="${o.fill}"`,
  ];
  if (o.weight) attrs.push(`font-weight="${o.weight}"`);
  if (o.style) attrs.push(`font-style="${o.style}"`);
  if (o.anchor) attrs.push(`text-anchor="${o.anchor}"`);
  return `<text ${attrs.join(" ")}>${escapeSvgText(content)}</text>`;
}

function roundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  stroke: string,
): string {
  return (
    `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" ` +
    `rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Escape text for safe embedding in SVG element content and attributes. */
export function escapeSvgText(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Rough average glyph width (≈0.58em) — deliberately conservative so fitted
// text stays inside its card rather than risking overflow.
function fitChars(width: number, size: number): number {
  return Math.max(1, Math.floor(width / (size * 0.58)));
}

function truncatePlain(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function truncateToWidth(s: string, width: number, size: number): string {
  return truncatePlain(s, fitChars(width, size));
}

function wrapToWidth(
  s: string,
  width: number,
  size: number,
  maxLines: number,
): string[] {
  const max = fitChars(width, size);
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= max) {
      cur = candidate;
      continue;
    }
    // Hitting the line cap: fold everything left into the final line, truncated.
    if (lines.length === maxLines - 1) {
      const rest = cur ? `${cur} ${words.slice(i).join(" ")}` : words.slice(i).join(" ");
      lines.push(truncatePlain(rest, max));
      return lines;
    }
    if (cur) lines.push(cur);
    cur = w.length <= max ? w : truncatePlain(w, max);
  }
  if (cur) lines.push(cur);
  return lines;
}
