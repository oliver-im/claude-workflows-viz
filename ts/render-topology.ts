import type { Meta } from "./model.js";
import type { GEdge, GLane, GLoop, GNode, Layout } from "./topo-geometry.js";
import { renderHeader, renderModelBadge } from "./render-svg.js";
import {
  GAP,
  MARGIN,
  MODEL_FALLBACK,
  arrowHead,
  escapeSvgText,
  round,
  roundRect,
  strokePath,
  swatchFor,
  text,
  truncatePlain,
  truncateToWidth,
} from "./svg-primitives.js";

/**
 * The topology renderer: a positioned `Layout` → a standalone SVG string. It
 * only paints what `place-topology` already positioned — phase stripes, edges,
 * nodes, and local loop badges — in the resvg-safe SVG 1.1 subset (plain
 * shapes/paths, arrowheads as explicit filled triangles, no `<marker>`). The
 * header card reuses v1's `renderHeader`, so the page reads as one family with
 * `--view phases`. Every raw IR string is escaped here; the full text behind a
 * truncation rides along as a `<title>` (resvg ignores it, browsers tooltip it).
 *
 * Draw order is deliberate: stripe rects (faint tints) first, then edges, then
 * nodes, then loop badges, then the lane chrome (chip + title + model) on top —
 * so a cross-phase connector entering a lane never paints over its title.
 *
 * All paint and typography live in the named constants below; restyling is a
 * constant swap, never logic surgery. Determinism: output is a pure function of
 * the layout (no Date/random); arrays are drawn in their canonical order.
 */
export function renderTopology(layout: Layout, meta: Meta): string {
  const width = layout.width;
  const header = renderHeader(meta, MARGIN, width - 2 * MARGIN);
  const yOffset = MARGIN + header.height + GAP;
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

  const stripes = layout.lanes.map((l) => renderStripe(l, width)).join("");
  const edges = layout.edges.map((e) => renderEdge(e)).join("");
  const nodes = layout.nodes.map((n) => renderNode(n, width)).join("");
  const loops = layout.loops.map((l, i) => renderLoop(l, i, layout, byId, width)).join("");
  const chrome = layout.lanes.map((l) => renderChrome(l, width)).join("");
  const graph =
    `<g class="topology" transform="translate(0 ${round(yOffset)})">` +
    stripes +
    edges +
    nodes +
    loops +
    chrome +
    `</g>`;

  const height = round(yOffset + layout.height + MARGIN);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" ` +
    `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">\n` +
    `<rect width="${width}" height="${height}" fill="${PAGE_BG}"/>\n` +
    `<g transform="translate(0 ${MARGIN})">${header.body}</g>\n` +
    graph +
    `\n</svg>\n`
  );
}

// ---------------------------------------------------------------------------
// Palette + typography — control flow is coral, data is slate, stripes faint.
// ---------------------------------------------------------------------------

const PAGE_BG = "#f8fafc";
const ACCENT = "#e8694a"; // coral: barriers, decisions, loop badges
const EDGE = "#64748b";
const EDGE_LABEL = "#94a3b8";
const NODE_LABEL = "#334155";
const TITLE = "#0f172a";
const MUTED = "#94a3b8";
const HUB_FILL = "#94a3b8";
const STRIPE_STROKE = "#e8edf3";
const STRIPE_EMPTY_FILL = "#eef2f7";
const CHIP_FILL = "#334155";
const STRIPE_OPACITY = 0.55;

const STRIPE_INSET = MARGIN;
const STRIPE_RX = 10;
const CHROME_PAD = 14;
const CHIP_R = 11;
const TITLE_FONT = 15;
const LABEL_FONT = 12.5;
const MEMBER_FONT = 11;
const BADGE_FONT = 11;
const LOOP_FONT = 11;
const EDGE_W = 1.3;
const FAN_W = 1.1;
const NODE_STROKE_W = 1.25;

const laneWidth = (width: number): number => width - 2 * STRIPE_INSET;

// ---------------------------------------------------------------------------
// Lanes — a faint tinted stripe (rect) drawn behind, chrome drawn on top.
// ---------------------------------------------------------------------------

function renderStripe(lane: GLane, width: number): string {
  const x = STRIPE_INSET;
  const w = round(laneWidth(width));
  const h = round(lane.yBot - lane.yTop);
  if (lane.empty) {
    return (
      `<rect class="swimlane-empty" x="${x}" y="${round(lane.yTop)}" width="${w}" height="${h}" ` +
      `rx="${STRIPE_RX}" fill="${STRIPE_EMPTY_FILL}" stroke="${STRIPE_STROKE}" stroke-width="1" stroke-dasharray="4 3"/>`
    );
  }
  const swatch = lane.model !== undefined ? swatchFor(lane.model) : MODEL_FALLBACK;
  return (
    `<rect class="swimlane" x="${x}" y="${round(lane.yTop)}" width="${w}" height="${h}" ` +
    `rx="${STRIPE_RX}" fill="${swatch.fill}" fill-opacity="${STRIPE_OPACITY}" stroke="${STRIPE_STROKE}" stroke-width="1"/>`
  );
}

/** The lane's chip, title, and model badge (and the "control only" hint for an
 *  empty strip), drawn on top of everything so connectors can't occlude them. */
function renderChrome(lane: GLane, width: number): string {
  const x = STRIPE_INSET;
  const chromeTop = lane.empty
    ? lane.yTop + Math.max(0, (lane.yBot - lane.yTop - 2 * CHIP_R) / 2)
    : lane.yTop + CHROME_PAD;
  const chipCx = x + CHROME_PAD + CHIP_R;
  const chipCy = chromeTop + CHIP_R;
  const textX = x + CHROME_PAD + 2 * CHIP_R + 12;
  const rightX = x + laneWidth(width) - CHROME_PAD;

  const parts: string[] = [
    `<circle cx="${round(chipCx)}" cy="${round(chipCy)}" r="${CHIP_R}" fill="${CHIP_FILL}"/>`,
    text(chipCx, chipCy + 3.7, String(lane.phaseIndex + 1), {
      size: 11.5,
      weight: 700,
      fill: "#ffffff",
      anchor: "middle",
    }),
  ];

  if (lane.empty) {
    const title = truncateToWidth(lane.title, rightX - textX - 86, TITLE_FONT - 1);
    parts.push(
      text(textX, chipCy + 4.5, title, { size: TITLE_FONT - 1, weight: 600, fill: TITLE }),
      text(rightX, chipCy + 4.5, "control only", {
        size: 11,
        style: "italic",
        fill: MUTED,
        anchor: "end",
      }),
    );
    return `<g class="lane-chrome">${parts.join("")}</g>`;
  }

  let badge = "";
  let badgeW = 0;
  if (lane.model !== undefined) {
    const rendered = renderModelBadge(lane.model, rightX, chromeTop);
    badge = rendered.svg;
    badgeW = rendered.width;
  }
  const titleW = (badge ? rightX - badgeW - 10 : rightX) - textX;
  parts.push(
    text(textX, chromeTop + 15, truncateToWidth(lane.title, titleW, TITLE_FONT), {
      size: TITLE_FONT,
      weight: 700,
      fill: TITLE,
    }),
    badge,
  );
  return `<g class="lane-chrome">${parts.join("")}</g>`;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function renderNode(n: GNode, width: number): string {
  switch (n.kind) {
    case "agent":
      return renderAgent(n, width);
    case "barrier":
      return renderBarrier(n);
    case "decision":
      return renderDecision(n);
    case "task":
      return renderTask(n);
    case "hub":
      return `<circle class="hub" cx="${round(n.x)}" cy="${round(n.y)}" r="${n.r}" fill="${HUB_FILL}"/>`;
  }
}

function renderAgent(n: GNode, width: number): string {
  const swatch = n.model !== undefined ? swatchFor(n.model) : MODEL_FALLBACK;
  const parts: string[] = [];
  if (n.tooltip !== undefined) parts.push(`<title>${escapeSvgText(n.tooltip)}</title>`);
  // ×N stack hint: a second circle peeking down-right behind the main one.
  if (n.mult !== undefined) {
    parts.push(
      `<circle cx="${round(n.x + 2)}" cy="${round(n.y + 2)}" r="${n.r}" ` +
        `fill="${swatch.fill}" stroke="${swatch.stroke}" stroke-width="1"/>`,
    );
  }
  parts.push(
    `<circle cx="${round(n.x)}" cy="${round(n.y)}" r="${n.r}" ` +
      `fill="${swatch.fill}" stroke="${swatch.stroke}" stroke-width="${NODE_STROKE_W}"/>`,
  );
  parts.push(...nodeLabel(n, width));
  if (n.mult !== undefined) {
    parts.push(
      `<text x="${round(n.x + n.r + 1)}" y="${round(n.y - n.r + 2)}" font-size="${BADGE_FONT}" ` +
        `font-weight="700" fill="${ACCENT}">${escapeSvgText(n.mult)}</text>`,
    );
  }
  return `<g class="agent-node">${parts.join("")}</g>`;
}

function renderBarrier(n: GNode): string {
  const w = n.w ?? 2 * n.r;
  const h = n.h ?? 6;
  return (
    `<rect class="barrier" x="${round(n.x - w / 2)}" y="${round(n.y - h / 2)}" ` +
    `width="${round(w)}" height="${round(h)}" rx="${round(h / 2)}" fill="${ACCENT}"/>`
  );
}

function renderDecision(n: GNode): string {
  const d = n.r;
  const points = [
    `${round(n.x)},${round(n.y - d)}`,
    `${round(n.x + d)},${round(n.y)}`,
    `${round(n.x)},${round(n.y + d)}`,
    `${round(n.x - d)},${round(n.y)}`,
  ].join(" ");
  const cond = truncatePlain(n.label, 36);
  const parts = [
    `<title>${escapeSvgText(n.label)}</title>`,
    `<polygon points="${points}" fill="#ffffff" stroke="${ACCENT}" stroke-width="1.4"/>`,
    // Condition kept quiet: a muted label to the right, full text in <title>.
    text(n.x + d + 6, n.y + 4, cond, { size: MEMBER_FONT, style: "italic", fill: MUTED }),
  ];
  return `<g class="decision">${parts.join("")}</g>`;
}

function renderTask(n: GNode): string {
  const w = n.w ?? 96;
  const h = n.h ?? 30;
  const parts = [
    ...(n.tooltip !== undefined ? [`<title>${escapeSvgText(n.tooltip)}</title>`] : []),
    roundRect(n.x - w / 2, n.y - h / 2, w, h, 6, MODEL_FALLBACK.fill, MODEL_FALLBACK.stroke),
    text(n.x, n.y + 4, truncateToWidth(n.label, w - 14, LABEL_FONT - 0.5), {
      size: LABEL_FONT - 0.5,
      fill: NODE_LABEL,
      anchor: "middle",
    }),
  ];
  return `<g class="task-node">${parts.join("")}</g>`;
}

/** A node's label: BELOW and centered for a row/grid member or off-spine arm
 *  (placement flags these), to the RIGHT otherwise — where the vertical flow
 *  exits the node's bottom and leaves the side clear. */
function nodeLabel(n: GNode, width: number): string[] {
  if (!n.label) return [];
  if (n.labelBelow === true) {
    return [
      text(n.x, n.y + n.r + 12, truncateToWidth(n.label, 150, MEMBER_FONT), {
        size: MEMBER_FONT,
        fill: NODE_LABEL,
        anchor: "middle",
      }),
    ];
  }
  const maxW = width - MARGIN - (n.x + n.r + 8);
  return [
    text(n.x + n.r + 8, n.y + 4, truncateToWidth(n.label, maxW, LABEL_FONT), {
      size: LABEL_FONT,
      fill: NODE_LABEL,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Edges + loop badges
// ---------------------------------------------------------------------------

function renderEdge(e: GEdge): string {
  const pts = e.points;
  if (pts.length < 2) return "";
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)} ${round(p.y)}`).join(" ");
  const thin = e.kind === "fan" || e.kind === "merge";
  const parts = [strokePath(d, EDGE, { width: thin ? FAN_W : EDGE_W })];
  const tip = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  parts.push(arrowHead(tip.x, tip.y, Math.atan2(tip.y - prev.y, tip.x - prev.x), EDGE));
  if (e.label !== undefined) {
    const mx = (prev.x + tip.x) / 2;
    const my = (prev.y + tip.y) / 2;
    parts.push(text(mx + 5, my, e.label, { size: 10.5, fill: EDGE_LABEL }));
  }
  return `<g class="edge">${parts.join("")}</g>`;
}

function renderLoop(loop: GLoop, i: number, layout: Layout, byId: Map<string, GNode>, width: number): string {
  const node = byId.get(loop.onNode);
  if (!node) return "";
  // Stack multiple badges on one node (nested loops), inner-first, below the
  // node's right-side label so neither the label nor the downward edge collides.
  const rank = layout.loops.slice(0, i).filter((l) => l.onNode === loop.onNode).length;
  const x = node.x + node.r + 8;
  const y = node.y + node.r + 6 + rank * (LOOP_FONT + 3);
  const maxW = width - MARGIN - x;
  return `<g class="loop-badge">${text(x, y, truncateToWidth(`↻ ${loop.label}`, maxW, LOOP_FONT), {
    size: LOOP_FONT,
    weight: 600,
    fill: ACCENT,
  })}</g>`;
}
