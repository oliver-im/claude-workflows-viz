import type { Meta } from "./model.js";
import type { TopologyIR } from "./topology-ir.js";
import {
  MARGIN,
  MODEL_FALLBACK,
  arrowHead,
  escapeSvgText,
  round,
  roundRect,
  roundedElbowPath,
  strokePath,
  swatchFor,
  text,
  truncateToWidth,
} from "./svg-primitives.js";
import { renderHeader, renderModelBadge, renderPhaseCard } from "./render-svg.js";
import {
  BARRIER_W,
  CHIP_R,
  CHROME_H,
  CHROME_PAD_TOP,
  CHROME_PAD_X,
  DIAMOND_HALF,
  ELBOW_R,
  F_CAPTION,
  HUB_R,
  LABEL_LINE_H,
  NODE_R,
  TASK_H,
  layoutTopology,
  type GraphBand,
  type SceneEdge,
  type SceneLabel,
  type SceneNode,
  type SceneRoute,
  type TopoScene,
} from "./layout-topology.js";

/**
 * The topology renderer: `(meta, ir, bandTitles)` → a standalone SVG string.
 * All geometry comes from `layoutTopology`; this module only turns the scene
 * into the resvg-safe SVG 1.1 subset (plain shapes, explicit triangle
 * arrowheads, no <marker>). Page skeleton — shell, background, header card,
 * stacked cards — mirrors v1's `renderSvg` byte-for-byte, so an EMPTY_IR
 * render (every band falls back to a v1 phase card) is byte-identical to the
 * v1 output. Every string goes through `escapeSvgText`; the full text behind
 * any truncation rides along as an escaped `<title>` (resvg ignores it,
 * browsers tooltip it).
 */

// ---------------------------------------------------------------------------
// Palette — control flow is coral, data labels are slate.
// ---------------------------------------------------------------------------

export const ACCENT = "#e8694a";
export const EDGE = "#475569";
export const EDGE_UNTAKEN = "#cbd5e1";
export const UNTAKEN_DASH = "4 3";
export const LABEL = "#334155";
export const LABEL_MUTED = "#94a3b8";
export const CAPTION_COLOR = "#64748b";

const CARD_FILL = "#ffffff";
const CARD_STROKE = "#e2e8f0";
const CHIP_FILL = "#334155";
const TITLE_COLOR = "#0f172a";
const DECISION_FILL = "#ffffff";
const EDGE_WIDTH = 1.2;
const ROUTE_WIDTH = 1.3;
const NODE_STROKE_WIDTH = 1.25;

export function renderTopologySvg(
  meta: Meta,
  ir: TopologyIR,
  bandTitles: readonly string[],
): string {
  const scene = layoutTopology(meta, ir, bandTitles);
  const placed: string[] = [];
  const header = renderHeader(meta, scene.cardX, scene.cardW);
  placed.push(`<g transform="translate(0 ${MARGIN})">${header.body}</g>`);
  for (const band of scene.bands) {
    const body =
      band.kind === "fallback"
        ? renderPhaseCard(band.phase, band.index + 1, scene.cardX, scene.cardW).body
        : renderGraphBand(band, scene);
    placed.push(`<g transform="translate(0 ${round(band.y)})">${body}</g>`);
  }
  // Cross-band overlay last, so routes draw over card chrome. Omitted when
  // empty — this keeps the EMPTY_IR page byte-identical to v1.
  if (scene.routes.length > 0) {
    placed.push(
      `<g class="xband-overlay">${scene.routes.map(renderRoute).join("")}</g>`,
    );
  }
  const height = round(scene.height);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${height}" ` +
    `viewBox="0 0 ${scene.width} ${height}" ` +
    `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">\n` +
    `<rect width="${scene.width}" height="${height}" fill="#f8fafc"/>\n` +
    placed.join("\n") +
    `\n</svg>\n`
  );
}

// ---------------------------------------------------------------------------
// Graph bands
// ---------------------------------------------------------------------------

function renderGraphBand(band: GraphBand, scene: TopoScene): string {
  const parts: string[] = [];
  // <title> first (SVG convention): the band's full detail when the caption
  // truncated it away.
  if (band.tooltip !== undefined) {
    parts.push(`<title>${escapeSvgText(band.tooltip)}</title>`);
  }
  parts.push(roundRect(scene.cardX, 0, scene.cardW, band.height, 10, CARD_FILL, CARD_STROKE));

  // Chrome — mirrors the v1 phase card (chip, title, model badge).
  const chipCx = scene.cardX + CHROME_PAD_X + CHIP_R;
  const chipCy = CHROME_PAD_TOP + CHIP_R;
  const textX = scene.cardX + CHROME_PAD_X + 2 * CHIP_R + 14;
  const rightX = scene.cardX + scene.cardW - CHROME_PAD_X;
  let badge = "";
  let badgeWidth = 0;
  const model = band.model?.trim();
  if (model) {
    const rendered = renderModelBadge(model, rightX, CHROME_PAD_TOP);
    badge = rendered.svg;
    badgeWidth = rendered.width;
  }
  const titleWidth = (model ? rightX - badgeWidth - 10 : rightX) - textX;
  parts.push(
    `<circle cx="${round(chipCx)}" cy="${round(chipCy)}" r="${CHIP_R}" fill="${CHIP_FILL}"/>`,
    text(chipCx, chipCy + 4, String(band.index + 1), {
      size: 12.5,
      weight: 700,
      fill: "#ffffff",
      anchor: "middle",
    }),
    text(textX, CHROME_PAD_TOP + 16, truncateToWidth(band.title, titleWidth, 16), {
      size: 16,
      weight: 700,
      fill: TITLE_COLOR,
    }),
    badge,
  );
  if (band.caption !== undefined) {
    parts.push(
      text(scene.cardX + CHROME_PAD_X, CHROME_H + 12, band.caption, {
        size: F_CAPTION,
        fill: CAPTION_COLOR,
      }),
    );
  }

  for (const edge of band.edges) parts.push(renderIntraEdge(edge));
  for (const node of band.nodes) parts.push(renderNode(node));
  return `<g class="graph-band">${parts.join("")}</g>`;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function renderNode(n: SceneNode): string {
  switch (n.kind) {
    case "agent":
      return renderAgent(n);
    case "hub":
      return (
        `<circle class="hub" cx="${round(n.cx)}" cy="${round(n.cy)}" ` +
        `r="${HUB_R}" fill="${EDGE}"/>`
      );
    case "barrier":
      return (
        `<rect class="barrier" x="${round(n.cx - BARRIER_W / 2)}" y="${round(n.cy - n.h / 2)}" ` +
        `width="${BARRIER_W}" height="${round(n.h)}" rx="2" fill="${ACCENT}"/>`
      );
    case "decision": {
      const d = DIAMOND_HALF;
      const points = [
        `${round(n.cx)},${round(n.cy - d)}`,
        `${round(n.cx + d)},${round(n.cy)}`,
        `${round(n.cx)},${round(n.cy + d)}`,
        `${round(n.cx - d)},${round(n.cy)}`,
      ].join(" ");
      const parts = [
        `<polygon points="${points}" fill="${DECISION_FILL}" stroke="${ACCENT}" stroke-width="1.4"/>`,
        ...labelEls(n.label),
      ];
      return wrapNode("decision", n, parts);
    }
    case "task": {
      const parts = [
        roundRect(n.cx - n.w / 2, n.cy - TASK_H / 2, n.w, TASK_H, 6, MODEL_FALLBACK.fill, MODEL_FALLBACK.stroke),
        ...labelEls(n.label),
        ...badgeEls(n),
      ];
      return wrapNode("task-node", n, parts);
    }
  }
}

function renderAgent(n: SceneNode): string {
  const swatch = n.model !== undefined ? swatchFor(n.model) : MODEL_FALLBACK;
  const parts: string[] = [];
  for (const row of n.rows) {
    if (n.echo) {
      // The ×n / ×N stack hint: a second circle peeking out down-right.
      parts.push(
        `<circle cx="${round(n.cx + 1.5)}" cy="${round(row.cy + 1.5)}" r="${NODE_R}" ` +
          `fill="${swatch.fill}" stroke="${swatch.stroke}" stroke-width="1"/>`,
        `<circle cx="${round(n.cx - 1.5)}" cy="${round(row.cy - 1.5)}" r="${NODE_R}" ` +
          `fill="${swatch.fill}" stroke="${swatch.stroke}" stroke-width="${NODE_STROKE_WIDTH}"/>`,
      );
    } else if (row.dashed) {
      // The "+n more" overflow row.
      parts.push(
        `<circle cx="${round(n.cx)}" cy="${round(row.cy)}" r="${NODE_R}" ` +
          `fill="${CARD_FILL}" stroke="${swatch.stroke}" stroke-width="1" stroke-dasharray="3 2.5"/>`,
      );
    } else {
      parts.push(
        `<circle cx="${round(n.cx)}" cy="${round(row.cy)}" r="${NODE_R}" ` +
          `fill="${swatch.fill}" stroke="${swatch.stroke}" stroke-width="${NODE_STROKE_WIDTH}"/>`,
      );
    }
    if (row.label) parts.push(...labelEls(row.label));
  }
  parts.push(...labelEls(n.label), ...badgeEls(n));
  return wrapNode("agent-node", n, parts);
}

function wrapNode(cls: string, n: SceneNode, parts: string[]): string {
  const title =
    n.tooltip !== undefined ? `<title>${escapeSvgText(n.tooltip)}</title>` : "";
  return `<g class="${cls}">${title}${parts.join("")}</g>`;
}

function badgeEls(n: SceneNode): string[] {
  if (!n.badge) return [];
  return [
    `<text class="xn-badge" x="${round(n.badge.x)}" y="${round(n.badge.y)}" ` +
      `font-size="11" font-weight="700" fill="${ACCENT}">${escapeSvgText(n.badge.text)}</text>`,
  ];
}

function labelEls(label: SceneLabel | undefined): string[] {
  if (!label) return [];
  const fill =
    label.tone === "accent" ? ACCENT : label.tone === "muted" ? LABEL_MUTED : LABEL;
  return label.lines.map((line, i) =>
    text(label.x, label.y + i * (label.lineH ?? LABEL_LINE_H), line, {
      size: label.size,
      fill,
      ...(label.italic ? { style: "italic" } : {}),
      ...(label.anchor !== "start" ? { anchor: label.anchor } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Edges & routes
// ---------------------------------------------------------------------------

function renderIntraEdge(e: SceneEdge): string {
  const [[x1, y1], [x2, y2]] = e.pts;
  const stroke = e.untaken ? EDGE_UNTAKEN : EDGE;
  const parts = [
    strokePath(`M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}`, stroke, {
      width: EDGE_WIDTH,
      ...(e.untaken ? { dasharray: UNTAKEN_DASH } : {}),
    }),
  ];
  if (e.arrow) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    parts.push(`<g class="arrowhead">${arrowHead(x2, y2, angle, stroke)}</g>`);
  }
  parts.push(...labelEls(e.label));
  return parts.join("");
}

function renderRoute(r: SceneRoute): string {
  const loop = r.kind === "loop";
  const stroke = loop ? ACCENT : r.untaken ? EDGE_UNTAKEN : EDGE;
  const dash = !loop && r.untaken ? UNTAKEN_DASH : undefined;
  const parts = [roundedElbowPath(r.pts, ELBOW_R, stroke, ROUTE_WIDTH, dash)];
  // Routes always arrive pointing straight down into the target's top.
  const [tx, ty] = r.pts[r.pts.length - 1];
  parts.push(`<g class="arrowhead">${arrowHead(tx, ty, Math.PI / 2, stroke)}</g>`);
  parts.push(...labelEls(r.label));
  return `<g class="${loop ? "loop-path" : "xband-edge"}">${parts.join("")}</g>`;
}
