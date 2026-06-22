import type { Meta } from "./model.js";
import type { GEdge, GLane, GLoop, GNode, Layout } from "./topo-geometry.js";
import { renderHeader } from "./render-svg.js";
import { closeLaneGaps, reserveLaneHeights } from "./place-topology.js";
import {
  type Block,
  GAP,
  GRAPH_X,
  LEFT_COL_W,
  MARGIN,
  MODEL_FALLBACK,
  TOPO_PAGE_W,
  arrowHead,
  escapeSvgText,
  round,
  roundRect,
  strokePath,
  swatchFor,
  text,
  truncatePlain,
  truncateToWidth,
  wrapToWidth,
} from "./svg-primitives.js";

/**
 * The topology renderer: a positioned `Layout` → a standalone SVG string, laid
 * out as a swimlane TABLE. A full-width header banner (v1's `renderHeader`, so
 * the page reads as one family with `--view phases`) sits on top; below it, one
 * model-tinted row per phase — the phase LABEL (chip + title + model badge +
 * detail) in a left cell, and the phase's slice of the graph in the right cell.
 * The graph is the same positioned `Layout` `place-topology` produced, drawn in
 * its own coordinate frame (`layout.width` == `W`) and translated right by
 * `GRAPH_X` into the graph column — so placement is byte-identical to before;
 * only the page gains a left label column and goes landscape.
 *
 * Because the labels now live beside the graph, the in-graph chrome (the old
 * per-stripe chip/title/badge) is GONE — the graph cell is pure topology. Each
 * row is co-registered to `max(graph band height, label cell height)` via
 * `reserveLaneHeights`, so a label and its graph slice always share one row.
 *
 * Everything is the resvg-safe SVG 1.1 subset (plain shapes/paths, arrowheads
 * as explicit filled triangles, no `<marker>`); every raw IR string is escaped
 * here, with the full pre-truncation text riding along as a `<title>`. All
 * paint and typography live in the named constants below. Determinism: output
 * is a pure function of the layout; arrays are drawn in canonical order.
 */
export function renderTopology(layout: Layout, meta: Meta): string {
  const gw = layout.width; // the graph's own frame width (== W), unchanged
  const header = renderHeader(meta, MARGIN, TOPO_PAGE_W - 2 * MARGIN);
  const yOffset = MARGIN + header.height + GAP;

  // Build each lane's left label cell, then inflate its band to fit so the
  // label and its graph slice co-register into one row.
  const detailByTitle = new Map(
    meta.phases.filter((p) => p.detail?.trim()).map((p) => [p.title, p.detail as string]),
  );
  const cells = layout.lanes.map((l) =>
    renderLaneLabelCell(l.phaseIndex + 1, l.title, detailByTitle.get(l.title), l.model, l.empty),
  );
  reserveLaneHeights(layout, cells.map((c) => c.height));
  closeLaneGaps(layout); // seamless table — no gaps between phase rows

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const rows = layout.lanes.map(renderRow).join("");
  const labels = layout.lanes
    .map((l, i) => `<g transform="translate(0 ${round(l.yTop)})">${cells[i].body}</g>`)
    .join("");
  const edges = layout.edges.map((e) => renderEdge(e)).join("");
  const nodes = layout.nodes.map((n) => renderNode(n, gw)).join("");
  const loops = layout.loops.map((l, i) => renderLoop(l, i, layout, byId, gw)).join("");
  // Tints behind, then labels, then the graph translated into its column.
  const content =
    `<g transform="translate(0 ${round(yOffset)})">` +
    rows +
    labels +
    `<g class="topology" transform="translate(${round(GRAPH_X)} 0)">${edges}${nodes}${loops}</g>` +
    `</g>`;

  const width = TOPO_PAGE_W;
  const height = round(yOffset + layout.height + MARGIN);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" ` +
    `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">\n` +
    `<rect width="${width}" height="${height}" fill="${PAGE_BG}"/>\n` +
    `<g transform="translate(0 ${round(MARGIN)})">${header.body}</g>\n` +
    content +
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
const DETAIL = "#475569"; // label-cell detail text (matches the phases-view card)
const MUTED = "#94a3b8";
const CONTROL_FILL = "#fff7ed";
const CONTROL_STROKE = "#fb923c";
const HUB_FILL = "#94a3b8";
const STRIPE_STROKE = "#e8edf3";
const STRIPE_EMPTY_FILL = "#eef2f7";
const CHIP_FILL = "#334155";
const STRIPE_OPACITY = 0.55;

const STRIPE_RX = 10;
const CHIP_R = 11;
const TITLE_FONT = 15;
const LABEL_FONT = 12.5;
const MEMBER_FONT = 11;
const BADGE_FONT = 11;
const LOOP_FONT = 11;
const EDGE_W = 1.3;
const FAN_W = 1.1;
const NODE_STROKE_W = 1.25;

// ---------------------------------------------------------------------------
// Rows — a full-width, model-tinted band per phase, spanning BOTH columns; the
// left label cell and the right graph slice sit inside it.
// ---------------------------------------------------------------------------

function renderRow(lane: GLane): string {
  const x = MARGIN;
  const w = round(TOPO_PAGE_W - 2 * MARGIN);
  const y = round(lane.yTop);
  const h = round(lane.yBot - lane.yTop);
  if (lane.empty) {
    return (
      `<rect class="swimlane-empty" x="${x}" y="${y}" width="${w}" height="${h}" ` +
      `rx="${STRIPE_RX}" fill="${STRIPE_EMPTY_FILL}" stroke="${STRIPE_STROKE}" stroke-width="1" stroke-dasharray="4 3"/>`
    );
  }
  const swatch = lane.model !== undefined ? swatchFor(lane.model) : MODEL_FALLBACK;
  return (
    `<rect class="swimlane" x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `rx="${STRIPE_RX}" fill="${swatch.fill}" fill-opacity="${STRIPE_OPACITY}" stroke="${STRIPE_STROKE}" stroke-width="1"/>`
  );
}

/**
 * The left label cell for one phase row: the numbered chip, the phase title,
 * the model badge on its OWN row beneath the title (the narrow column can't fit
 * a top-right badge beside a long title without collision), then the wrapped
 * detail. A control-only (empty) lane shows the title plus a muted "control
 * only" note instead of a badge/detail. Drawn relative to (`X`, 0); the caller
 * translates it to the lane's top. Returns its measured height so the row can
 * be co-registered to fit it.
 */
function renderLaneLabelCell(
  index: number,
  title: string,
  detail: string | undefined,
  model: string | undefined,
  empty: boolean,
): Block {
  const x = MARGIN;
  const pad = 16;
  const chipCx = x + pad + CHIP_R;
  const chipCy = pad + CHIP_R;
  const textX = x + pad + 2 * CHIP_R + 12;
  const innerW = x + LEFT_COL_W - pad - textX;

  const parts: string[] = [
    `<circle cx="${round(chipCx)}" cy="${round(chipCy)}" r="${CHIP_R}" fill="${CHIP_FILL}"/>`,
    text(chipCx, chipCy + 3.7, String(index), {
      size: 11.5,
      weight: 700,
      fill: "#ffffff",
      anchor: "middle",
    }),
  ];

  const titleBaseline = pad + 15;
  parts.push(
    text(textX, titleBaseline, truncateToWidth(title, innerW, TITLE_FONT), {
      size: TITLE_FONT,
      weight: 700,
      fill: TITLE,
    }),
  );

  if (empty) {
    parts.push(
      text(textX, titleBaseline + 19, "control only", { size: 11, style: "italic", fill: MUTED }),
    );
    return { body: `<g class="lane-label">${parts.join("")}</g>`, height: titleBaseline + 19 + 12 };
  }

  let y = titleBaseline;
  if (model !== undefined) {
    const badge = modelBadgeLeft(model, textX, y + 9);
    parts.push(badge.svg);
    y = y + 9 + badge.height;
  }
  const detailLines = detail?.trim() ? wrapToWidth(detail.trim(), innerW, 12.5, 3) : [];
  for (const line of detailLines) {
    y += 17;
    parts.push(text(textX, y, line, { size: 12.5, fill: DETAIL }));
  }
  return { body: `<g class="lane-label">${parts.join("")}</g>`, height: y + pad };
}

/** A left-aligned model badge pill at (`x`, `yTop`) — the right-aligned
 *  `renderModelBadge` pins to a card's top-right corner, but the label cell
 *  stacks the badge under the title, so it needs a left-anchored variant. */
function modelBadgeLeft(model: string, x: number, yTop: number): { svg: string; height: number } {
  const swatch = swatchFor(model);
  const label = truncatePlain(model, 28);
  const font = 11;
  const h = 19;
  const w = Math.ceil(label.length * font * 0.62) + 16;
  const svg =
    roundRect(x, yTop, w, h, 9, swatch.fill, swatch.stroke) +
    text(x + w / 2, yTop + 13, label, {
      size: font,
      weight: 600,
      fill: swatch.text,
      anchor: "middle",
    });
  return { svg, height: h };
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
    case "control":
      return renderControl(n);
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

function renderControl(n: GNode): string {
  const w = n.w ?? 96;
  const h = n.h ?? 30;
  const parts = [
    ...(n.tooltip !== undefined ? [`<title>${escapeSvgText(n.tooltip)}</title>`] : []),
    `<rect class="control-box" x="${round(n.x - w / 2)}" y="${round(n.y - h / 2)}" ` +
      `width="${round(w)}" height="${round(h)}" rx="8" fill="${CONTROL_FILL}" ` +
      `stroke="${CONTROL_STROKE}" stroke-width="1.2" stroke-dasharray="4 3"/>`,
    text(n.x, n.y + 4, truncateToWidth(n.label, w - 14, LABEL_FONT - 0.5), {
      size: LABEL_FONT - 0.5,
      fill: "#9a3412",
      weight: 600,
      anchor: "middle",
    }),
  ];
  return `<g class="control-node">${parts.join("")}</g>`;
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
  return `<g class="loop-badge"><title>${escapeSvgText(loop.tooltip ?? loop.label)}</title>${text(x, y, truncateToWidth(`↻ ${loop.label}`, maxW, LOOP_FONT), {
    size: LOOP_FONT,
    weight: 600,
    fill: ACCENT,
  })}</g>`;
}
