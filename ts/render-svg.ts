import type { Meta, Phase } from "./model.js";
import {
  type Block,
  GAP,
  MARGIN,
  W,
  roundRect,
  swatchFor,
  text,
  truncatePlain,
  truncateToWidth,
  wrapToWidth,
} from "./svg-primitives.js";

/**
 * Render a workflow `Meta` as a standalone SVG string: a header card
 * (name + description + optional "when to use"), then a vertical stack of
 * phase cards — each an index chip, a single-line title, wrapped detail text,
 * and a model-colored badge. Pure layout: every coordinate is computed here,
 * with no external layout engine (phases are already ordered, so the flow is
 * a deliberate vertical stack — dependency layering is out of scope for v1).
 */
export function renderSvg(meta: Meta): string {
  const blocks: Block[] = [renderHeader(meta, CARD_X, CARD_W)];
  meta.phases.forEach((phase, i) =>
    blocks.push(renderPhaseCard(phase, i + 1, CARD_X, CARD_W)),
  );

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

const CARD_X = MARGIN;
const CARD_W = W - 2 * MARGIN;

// ---------------------------------------------------------------------------
// Cards — (x, w)-parameterized so the topology renderer can shift them right
// when a loop gutter reserves page width; `renderSvg` always passes the full
// CARD_X/CARD_W, so v1 output is unchanged.
// ---------------------------------------------------------------------------

export function renderHeader(meta: Meta, x: number, w: number): Block {
  const padX = 22;
  const padTop = 26;
  const padBottom = 22;
  const textX = x + padX;
  const innerW = w - 2 * padX;

  const name = truncateToWidth(meta.name, innerW, 22);
  const descLines = wrapToWidth(meta.description, innerW, 13.5, 3);
  const whenLines = meta.whenToUse
    ? wrapToWidth(`When to use — ${meta.whenToUse}`, innerW, 12.5, 2)
    : [];

  const parts: string[] = [];
  let baseline = padTop + 22;
  parts.push(text(textX, baseline, name, { size: 22, weight: 700, fill: "#0f172a" }));

  if (descLines.length > 0) {
    baseline += 10;
    for (const line of descLines) {
      baseline += 19;
      parts.push(text(textX, baseline, line, { size: 13.5, fill: "#475569" }));
    }
  }
  if (whenLines.length > 0) {
    baseline += 12;
    for (const line of whenLines) {
      baseline += 17;
      parts.push(
        text(textX, baseline, line, { size: 12.5, style: "italic", fill: "#64748b" }),
      );
    }
  }

  const height = baseline + padBottom;
  const card = roundRect(x, 0, w, height, 12, "#ffffff", "#e2e8f0");
  return { body: `<g class="header-card">${card}${parts.join("")}</g>`, height };
}

/**
 * The model badge shared by v1 phase cards and v2 graph-band chrome: a
 * swatch-colored pill pinned with its right edge at `rightX`, vertically
 * centered on the title row that starts at `padTop`. The displayed label is
 * capped so a pathologically long model string can't size the badge past the
 * card's left edge into the chip/title; color still keys off the full model
 * (substring match). 28 fits real ids (e.g. "claude-3-5-sonnet-20241022").
 */
export function renderModelBadge(
  model: string,
  rightX: number,
  padTop: number,
): { svg: string; width: number } {
  const swatch = swatchFor(model);
  const label = truncatePlain(model, 28);
  const font = 11.5;
  const badgeH = 20;
  const width = Math.ceil(label.length * font * 0.62) + 18;
  const bx = rightX - width;
  const by = padTop + (22 - badgeH) / 2;
  const svg =
    roundRect(bx, by, width, badgeH, 10, swatch.fill, swatch.stroke) +
    text(bx + width / 2, by + 14, label, {
      size: font,
      weight: 600,
      fill: swatch.text,
      anchor: "middle",
    });
  return { svg, width };
}

export function renderPhaseCard(
  phase: Phase,
  index: number,
  x: number,
  w: number,
): Block {
  const padX = 18;
  const padTop = 16;
  const padBottom = 16;
  const chipR = 13;
  const chipCx = x + padX + chipR;
  const textX = x + padX + 2 * chipR + 14;
  const rightX = x + w - padX;

  // Optional model badge, sized to its label and pinned to the card's top-right.
  const model = phase.model?.trim();
  let badge = "";
  let badgeWidth = 0;
  if (model) {
    const rendered = renderModelBadge(model, rightX, padTop);
    badge = rendered.svg;
    badgeWidth = rendered.width;
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
    roundRect(x, 0, w, height, 10, "#ffffff", "#e2e8f0"),
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
