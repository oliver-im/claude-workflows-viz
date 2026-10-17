import type { Meta } from "./model.js";
import {
  CAPTION_CODE_FONT,
  CAPTION_FONT,
  CAPTION_PREFIX,
  CARD_BASELINE,
  CARD_H1,
  CARD_LINE_STEP,
  CARD_PAD_X,
  CARD_RX,
  DECK_DEPTH,
  DECK_STEP,
  EFFORT_TIERS,
  LABEL_FONT,
  META_FONT,
  METER_SEGMENTS,
  METER_SEG_GAP,
  METER_SEG_W,
  METER_W,
  modelHidden,
} from "./node-card.js";
import {
  ARC_LANE,
  COND_FONT,
  COND_GAP,
  DIAMOND_HALF,
  ELBOW,
  FRAME_COND_FONT,
  FRAME_ICON_W,
  FRAME_KEYWORD_FONT,
  SELF_LOOP_DX,
  TERMINAL_R,
  closeLaneGaps,
  isFinalNode,
  nodeXExtent,
  reserveLaneHeights,
} from "./place-topology.js";
import { type WorkflowStats, statChips } from "./stats.js";
import { type FontSpec, MONO_STACK, SANS_STACK, fitText, textWidth, wrapText } from "./text-metrics.js";
import { LIGHT, type Swatch, type Theme, modelFamily, modelSwatch } from "./theme.js";
import type { ControlArc, GEdge, GFrame, GLane, GNode, LaneMember, Layout } from "./topo-geometry.js";
import { GAP, LEFT_COL_W, COL_GAP, MARGIN, W, escapeSvgText, round } from "./svg-primitives.js";

/**
 * The topology renderer: a positioned `Layout` → a standalone SVG string, laid
 * out as a swimlane TABLE. A header card (name, description, when-to-use, and a
 * strip of counts read off the body) sits on top; below it, one row per phase —
 * the phase LABEL (chip + title + detail + declared model) in a left cell, and
 * the phase's slice of the graph in the right cell — closed by a legend of
 * exactly the glyphs the diagram uses, so the image explains itself wherever it
 * travels.
 *
 * The visual language (see `theme.ts` for the palette rule):
 *   - an agent is a CARD: its authored label in mono (verbatim source), then its
 *     model and effort, filled with the model's color;
 *   - edges are orthogonal with rounded corners — fan-outs are rails, joins are
 *     bars, and no line crosses text;
 *   - a loop is a FRAME around the body it repeats, with the condition on top;
 *   - two voices: sans for what the author wrote as prose in `meta`, mono for
 *     anything quoted from the code.
 *
 * Every text width is measured (`text-metrics.ts`), so wrapping fills the room
 * it has. Everything is the resvg-safe SVG 1.1 subset (plain shapes/paths,
 * arrowheads as explicit filled triangles, no `<marker>`); every raw IR string
 * is escaped here, with full text behind any truncation riding along as a
 * `<title>`. Determinism: output is a pure function of the inputs.
 */
export interface RenderOptions {
  theme?: Theme;
  /** Counts for the header strip; omitted ⇒ no strip. */
  stats?: WorkflowStats;
}

export function renderTopology(layout: Layout, meta: Meta, opts: RenderOptions = {}): string {
  const t = opts.theme ?? LIGHT;

  // Build each lane's left label cell, then inflate its band to fit so the
  // label and its graph slice co-register into one row.
  const detailByTitle = new Map(
    meta.phases.filter((p) => p.detail?.trim()).map((p) => [p.title, p.detail as string]),
  );
  const cells = layout.lanes.map((l) =>
    l.members
      ? renderParallelLaneCell(t, l, layout, detailByTitle)
      : renderLaneLabelCell(t, {
          index: l.ordinal,
          title: l.title,
          detail: detailByTitle.get(l.title),
          model: l.model,
          declaredOnly: l.model !== undefined && declaredOnly(l.model, l, layout),
          empty: l.empty,
        }),
  );
  reserveLaneHeights(layout, cells.map((c) => c.height));
  closeLaneGaps(layout); // seamless table — no gaps between phase rows

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

  // Fit the graph to its real horizontal extent: its leftmost drawn element sits
  // one COL_GAP past the label column, and the page ends at its right edge. A
  // floor keeps the header readable when the graph is a thin single spine.
  const { minX, maxX } = graphContentBounds(layout, byId);
  const graphX = Math.round(MARGIN + LEFT_COL_W + COL_GAP - minX);
  const pageW = Math.max(Math.ceil(graphX + maxX + COL_GAP + MARGIN), MIN_TOPO_PAGE_W);
  const innerCardW = pageW - 2 * MARGIN;

  const header = renderHeader(t, meta, MARGIN, innerCardW, opts.stats ? statChips(opts.stats) : []);
  const yOffset = MARGIN + header.height + GAP;

  const first = layout.lanes[0];
  const last = layout.lanes[layout.lanes.length - 1];
  const tableTop = first ? first.yTop : 0;
  const tableBot = last ? last.yBot : layout.height;
  const legend = renderLegend(t, layout, MARGIN + 22, innerCardW - 44);
  const legendTop = tableBot;
  const legendH = legend.height > 0 ? legend.height + 2 * LEGEND_PAD_Y : 0;

  const tableCard = rect(MARGIN, tableTop, innerCardW, tableBot - tableTop + legendH, TABLE_RX, t.card, t.border);
  const rows = layout.lanes.map((l, i) => renderRow(t, l, i, pageW)).join("");
  const labels = layout.lanes
    .map((l, i) => `<g transform="translate(0 ${round(l.yTop)})">${cells[i].body}</g>`)
    .join("");
  const legendBlock =
    legend.height > 0
      ? hline(MARGIN, legendTop, MARGIN + innerCardW, t.border) +
        `<g class="legend" transform="translate(0 ${round(legendTop + LEGEND_PAD_Y)})">${legend.body}</g>`
      : "";
  const content =
    `<g transform="translate(0 ${round(yOffset)})">` +
    tableCard +
    rows +
    labels +
    `<g class="topology" transform="translate(${graphX} 0)">${renderGraph(t, layout, byId)}</g>` +
    legendBlock +
    `</g>`;

  const height = round(yOffset + tableBot + legendH + MARGIN);
  return svgDocument(t, pageW, height, meta, `<g transform="translate(0 ${round(MARGIN)})">${header.body}</g>\n${content}`);
}

/**
 * Graph-only topology view: the placed body topology without the workflow header
 * or phase table, with its legend below. Place it with `derivedLabels` so cards
 * name unlabeled agents by their prompt — there is no phase row beside them here.
 */
export function renderTopologyGraph(layout: Layout, opts: RenderOptions & { meta?: Meta } = {}): string {
  const t = opts.theme ?? LIGHT;
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const { minX, maxX } = graphContentBounds(layout, byId);
  const graphX = Math.round(MARGIN - minX);
  const pageW = Math.max(Math.ceil(maxX - minX + 2 * MARGIN), MIN_GRAPH_PAGE_W);
  const legend = renderLegend(t, layout, MARGIN, pageW - 2 * MARGIN);
  const graphY = MARGIN;
  const graphH = layout.height;
  const legendY = graphY + graphH + (legend.height > 0 ? LEGEND_PAD_Y : 0);

  const content =
    `<g class="topology" transform="translate(${graphX} ${round(graphY)})">${renderGraph(t, layout, byId)}</g>` +
    (legend.height > 0 ? `<g class="legend" transform="translate(0 ${round(legendY)})">${legend.body}</g>` : "");
  const height = round(legendY + legend.height + MARGIN);
  return svgDocument(t, pageW, height, opts.meta, content);
}

function svgDocument(t: Theme, width: number, height: number, meta: Meta | undefined, body: string): string {
  const a11y = meta
    ? `<title>${escapeSvgText(meta.name)}</title>\n<desc>${escapeSvgText(meta.description)}</desc>\n`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" font-family="${SANS_STACK}">\n` +
    a11y +
    `<rect width="${width}" height="${height}" fill="${t.page}"/>\n` +
    body +
    `\n</svg>\n`
  );
}

// ---------------------------------------------------------------------------
// Typography + geometry. Colors come from the theme; sizes live here.
// ---------------------------------------------------------------------------

const TABLE_RX = 12;
/** Page-width floor so a thin single-spine graph still gives the header card a
 *  comfortable measure (matches the phases-view card width). */
const MIN_TOPO_PAGE_W = W;
const MIN_GRAPH_PAGE_W = 360;

const TITLE_FONT: FontSpec = { size: 15, weight: 700 };
const DETAIL_FONT: FontSpec = { size: 12.5 };
const MODEL_FONT: FontSpec = { size: 11.5 };
const NOTE_FONT: FontSpec = { size: 11, italic: true };
const EDGE_LABEL_FONT: FontSpec = { size: 10.5 };
const LEGEND_FONT: FontSpec = { size: 10.5 };
const LEGEND_TERM_FONT: FontSpec = { size: 10.5, weight: 700 };
const BADGE_FONT: FontSpec = { size: 10, weight: 700 };
const LEGEND_PAD_Y = 13;
const LEGEND_ROW_H = 20;
const EDGE_W = 1.25;
const CORNER_R = 6;
const START_R = 5;
const ARROW_LEN = 6.5;
const ARROW_HALF_W = 3.3;

// ---------------------------------------------------------------------------
// SVG atoms
// ---------------------------------------------------------------------------

interface TextAttrs extends FontSpec {
  fill: string;
  anchor?: "start" | "middle" | "end";
  halo?: string;
}

function text(x: number, y: number, content: string, a: TextAttrs): string {
  if (content === "") return "";
  const attrs = [`x="${round(x)}"`, `y="${round(y)}"`, `font-size="${a.size}"`, `fill="${a.fill}"`];
  if (a.mono) attrs.push(`font-family="${MONO_STACK}"`);
  if (a.weight && a.weight !== 400) attrs.push(`font-weight="${a.weight}"`);
  if (a.italic) attrs.push(`font-style="italic"`);
  if (a.anchor && a.anchor !== "start") attrs.push(`text-anchor="${a.anchor}"`);
  if (a.halo) {
    attrs.push(`stroke="${a.halo}"`, `stroke-width="4"`, `stroke-linejoin="round"`, `paint-order="stroke fill"`);
  }
  return `<text ${attrs.join(" ")}>${escapeSvgText(content)}</text>`;
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  fill: string,
  stroke?: string,
  strokeW = 1,
  extra = "",
): string {
  return (
    `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${rx}" fill="${fill}"` +
    (stroke ? ` stroke="${stroke}" stroke-width="${strokeW}"` : "") +
    extra +
    `/>`
  );
}

function hline(x1: number, y: number, x2: number, stroke: string): string {
  return `<line x1="${round(x1)}" y1="${round(y)}" x2="${round(x2)}" y2="${round(y)}" stroke="${stroke}" stroke-width="1"/>`;
}

function arrowHead(tipX: number, tipY: number, angle: number, fill: string): string {
  const bx = tipX - ARROW_LEN * Math.cos(angle);
  const by = tipY - ARROW_LEN * Math.sin(angle);
  const px = -Math.sin(angle) * ARROW_HALF_W;
  const py = Math.cos(angle) * ARROW_HALF_W;
  return (
    `<polygon points="${round(tipX)},${round(tipY)} ${round(bx + px)},${round(by + py)} ` +
    `${round(bx - px)},${round(by - py)}" fill="${fill}"/>`
  );
}

/** An orthogonal polyline as a path with rounded corners. */
function roundedPath(points: ReadonlyArray<{ x: number; y: number }>, radius = CORNER_R): string {
  let d = `M ${round(points[0].x)} ${round(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const a = points[i - 1];
    const b = points[i + 1];
    const inLen = Math.hypot(p.x - a.x, p.y - a.y);
    const outLen = Math.hypot(b.x - p.x, b.y - p.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += ` L ${round(p.x)} ${round(p.y)}`;
      continue;
    }
    const sx = p.x - ((p.x - a.x) / inLen) * r;
    const sy = p.y - ((p.y - a.y) / inLen) * r;
    const ex = p.x + ((b.x - p.x) / outLen) * r;
    const ey = p.y + ((b.y - p.y) / outLen) * r;
    d += ` L ${round(sx)} ${round(sy)} Q ${round(p.x)} ${round(p.y)} ${round(ex)} ${round(ey)}`;
  }
  const end = points[points.length - 1];
  return `${d} L ${round(end.x)} ${round(end.y)}`;
}

function strokePath(d: string, stroke: string, width = EDGE_W, extra = ""): string {
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round"${extra}/>`;
}

/** The loop glyph, drawn as a path so it never depends on a font having ↻. */
function loopGlyph(cx: number, cy: number, color: string): string {
  const r = 4.6;
  const a0 = -0.12 * Math.PI;
  const a1 = 1.5 * Math.PI - 0.2;
  const sx = cx + r * Math.cos(a0);
  const sy = cy + r * Math.sin(a0);
  const ex = cx + r * Math.cos(a1);
  const ey = cy + r * Math.sin(a1);
  const tangent = a1 + Math.PI / 2;
  return (
    `<path d="M ${round(sx)} ${round(sy)} A ${r} ${r} 0 1 1 ${round(ex)} ${round(ey)}" fill="none" ` +
    `stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>` +
    arrowHead(ex + 3 * Math.cos(tangent), ey + 3 * Math.sin(tangent), tangent, color)
  );
}

// ---------------------------------------------------------------------------
// Header — name, description, when-to-use, and the counts strip.
// ---------------------------------------------------------------------------

interface Block {
  body: string;
  height: number;
}

function renderHeader(t: Theme, meta: Meta, x: number, w: number, chips: string[]): Block {
  const padX = 24;
  const inner = w - 2 * padX;
  const parts: string[] = [];
  let y = 24 + 20;
  for (const [i, line] of wrapText(meta.name, inner, { size: 22, weight: 700 }).entries()) {
    if (i > 0) y += 28;
    parts.push(text(x + padX, y, line, { size: 22, weight: 700, fill: t.ink }));
  }
  const desc = meta.description.trim();
  if (desc) {
    y += 8;
    for (const line of wrapText(desc, inner, { size: 13.5 })) {
      y += 20;
      parts.push(text(x + padX, y, line, { size: 13.5, fill: t.body }));
    }
  }
  if (meta.whenToUse?.trim()) {
    y += 6;
    for (const line of wrapText(`When to use — ${meta.whenToUse.trim()}`, inner, { size: 12.5, italic: true })) {
      y += 18;
      parts.push(text(x + padX, y, line, { size: 12.5, italic: true, fill: t.muted }));
    }
  }
  if (chips.length > 0) {
    y += 14;
    let cx = x + padX;
    for (const chip of chips) {
      const cw = Math.ceil(textWidth(chip, { size: 11 })) + 18;
      if (cx + cw > x + padX + inner && cx > x + padX) {
        cx = x + padX;
        y += 28;
      }
      parts.push(rect(cx, y, cw, 22, 11, t.statFill));
      parts.push(text(cx + 9, y + 15, chip, { size: 11, fill: t.statText }));
      cx += cw + 6;
    }
    y += 22;
  }
  const height = y + 20;
  return {
    body: `<g class="header-card">${rect(x, 0, w, height, 12, t.card, t.border)}${parts.join("")}</g>`,
    height,
  };
}

// ---------------------------------------------------------------------------
// Rows + label cells
// ---------------------------------------------------------------------------

function renderRow(t: Theme, lane: GLane, i: number, pageW: number): string {
  // The phases share ONE rounded card (drawn in renderTopology). A row only
  // contributes a full-width hairline at its top boundary — every phase but the
  // first. The class stays as a semantic hook (incl. control-only).
  const sep = i > 0 ? hline(MARGIN, lane.yTop, pageW - MARGIN, t.border) : "";
  return `<g class="${lane.empty ? "swimlane-empty" : "swimlane"}">${sep}</g>`;
}

/**
 * Whether the model a `meta` phase declares is backed by nothing in its body: no
 * agent in the lane sets that model, and none names a custom `agentType` (which
 * may pin a model of its own — the diagram can't see inside it, so it doesn't
 * accuse).
 */
function declaredOnly(model: string, lane: GLane, layout: Layout): boolean {
  const want = model.toLowerCase();
  const family = modelFamily(model);
  return !layout.nodes.some(
    (n) =>
      n.kind === "agent" &&
      n.phase === lane.phaseIndex &&
      ((n.model === undefined && (n.agentType !== undefined || modelHidden(n))) ||
        (n.model !== undefined &&
          (n.model.toLowerCase() === want || (family !== undefined && modelFamily(n.model) === family)))),
  );
}

/** The swatch a card wears: its model's; neutral slate for a custom agent type or
 *  a model the analyzer couldn't read; else the inherited session's. */
function cardSwatch(t: Theme, n: GNode): Swatch {
  if (n.model === undefined && (n.agentType !== undefined || modelHidden(n))) return t.otherModel;
  return modelSwatch(t, n.model);
}

/** The legend's name for a card's model state — the same words the card uses. */
function modelKey(n: GNode): string {
  if (n.model !== undefined) return modelFamily(n.model) ?? n.model;
  if (modelHidden(n)) return "model unread";
  return n.agentType !== undefined ? `${n.agentType} agent` : "session model";
}

interface CellSpec {
  index: number;
  title: string;
  detail: string | undefined;
  model: string | undefined;
  declaredOnly: boolean;
  empty: boolean;
  cellX?: number;
  cellW?: number;
  compact?: boolean;
}

/**
 * The left label cell for one phase row: the numbered chip, the phase title,
 * the wrapped detail, then — last and quietest — the model the phase declares:
 * a swatch dot keyed to the model's card color, then the id. When no agent in
 * the phase actually sets that model, the dot is hollow and the line says
 * "declared only" — the diagram reports the mismatch instead of hiding it. A
 * control-only (empty) lane shows the title plus a muted "control only" note.
 *
 * In `compact` mode the cell fits a sub-column of a collapsed parallel row:
 * tighter padding, a smaller chip, and the model's short family name (full id in
 * a `<title>`). The detail is never capped — it wraps in full and the row grows.
 * Drawn relative to (`cellX`, 0); the caller translates it to the lane's top.
 */
function renderLaneLabelCell(t: Theme, c: CellSpec): Block {
  const x = c.cellX ?? MARGIN;
  const colW = c.cellW ?? LEFT_COL_W;
  const compact = c.compact ?? false;
  const padX = compact ? 12 : 22;
  const padTop = compact ? 16 : 18;
  const padBottom = compact ? 14 : 18;
  const chipR = compact ? 9 : 11;
  const titleFont: FontSpec = compact ? { size: 13, weight: 700 } : TITLE_FONT;
  const detailFont: FontSpec = compact ? { size: 11 } : DETAIL_FONT;
  const modelFont: FontSpec = compact ? { size: 10.5 } : MODEL_FONT;
  const lineH = compact ? 15 : 17;

  const chipCx = x + padX + chipR;
  const chipCy = padTop + chipR;
  const textX = x + padX + 2 * chipR + (compact ? 8 : 12);
  const innerW = x + colW - padX - textX;

  const parts: string[] = [
    `<circle cx="${round(chipCx)}" cy="${round(chipCy)}" r="${chipR}" fill="${t.chip}"/>`,
    text(chipCx, chipCy + (compact ? 3.4 : 3.9), String(c.index), {
      size: compact ? 10.5 : 11.5,
      weight: 700,
      fill: t.chipText,
      anchor: "middle",
    }),
  ];

  let y = padTop + (compact ? 13 : 16);
  for (const [i, line] of wrapText(c.title, innerW, titleFont, 2).entries()) {
    if (i > 0) y += titleFont.size + 3;
    parts.push(text(textX, y, line, { ...titleFont, fill: t.ink }));
  }

  if (c.empty) {
    y += compact ? 16 : 19;
    parts.push(text(textX, y, "control only", { ...NOTE_FONT, size: compact ? 10 : 11, fill: t.muted }));
    return { body: `<g class="lane-label">${parts.join("")}</g>`, height: y + padBottom };
  }

  const detail = c.detail?.trim();
  if (detail) y += 3;
  // The explanation wraps in full and the row grows to fit via reserveLaneHeights;
  // an over-long unbreakable token breaks rather than truncating. The full text
  // also rides along in the cell's <title>.
  for (const line of detail ? wrapText(detail, innerW, detailFont) : []) {
    y += lineH;
    parts.push(text(textX, y, line, { ...detailFont, fill: t.body }));
  }
  if (c.model !== undefined) {
    y += compact ? 16 : 19;
    const sw = modelSwatch(t, c.model);
    const dotR = 4;
    const labelX = textX + 2 * dotR + 7;
    const shown = compact ? (modelFamily(c.model) ?? c.model) : `model: ${c.model}`;
    const dot = c.declaredOnly
      ? `<circle cx="${round(textX + dotR)}" cy="${round(y - 4)}" r="${dotR}" fill="${t.card}" stroke="${sw.stroke}" stroke-dasharray="2 1.6"/>`
      : `<circle cx="${round(textX + dotR)}" cy="${round(y - 4)}" r="${dotR}" fill="${sw.fill}" stroke="${sw.stroke}"/>`;
    const room = x + colW - padX - labelX;
    const label = fitText(shown, room, modelFont);
    parts.push(dot, text(labelX, y, label, { ...modelFont, fill: t.muted }));
    if (c.declaredOnly) {
      const note = compact ? "declared" : "declared only";
      const nx = labelX + textWidth(label, modelFont) + 6;
      const noteFont: FontSpec = { ...modelFont, italic: true };
      if (nx + textWidth(`· ${note}`, noteFont) <= x + colW - padX) {
        parts.push(text(nx, y, `· ${note}`, { ...noteFont, fill: t.muted }));
      }
    }
    if (compact || label !== shown) parts.push(`<title>${escapeSvgText(`model: ${c.model}`)}</title>`);
  }
  const cellTitle = detail ? `<title>${escapeSvgText(detail)}</title>` : "";
  return { body: `<g class="lane-label">${cellTitle}${parts.join("")}</g>`, height: y + padBottom };
}

/**
 * The left cell for a collapsed parallel row: its concurrent arms drawn as
 * equal-width `compact` sub-cells side by side, split by faint vertical rules —
 * so each lineage keeps its own chip, title, and model while the row as a whole
 * co-registers to the parallel block beside it.
 */
function renderParallelLaneCell(t: Theme, lane: GLane, layout: Layout, detailByTitle: Map<string, string>): Block {
  const members = lane.members as LaneMember[];
  const subW = LEFT_COL_W / members.length;
  const cells = members.map((m, i) =>
    renderLaneLabelCell(t, {
      index: m.ordinal,
      title: m.title,
      detail: detailByTitle.get(m.title),
      model: m.model,
      declaredOnly: m.model !== undefined && declaredOnly(m.model, lane, layout),
      empty: false,
      cellX: MARGIN + i * subW,
      cellW: subW,
      compact: true,
    }),
  );
  const height = cells.reduce((h, c) => Math.max(h, c.height), 0);
  const rules = members
    .slice(1)
    .map((_, i) => {
      const rx = round(MARGIN + (i + 1) * subW);
      return `<line x1="${rx}" y1="12" x2="${rx}" y2="${round(height - 6)}" stroke="${t.border}" stroke-width="1"/>`;
    })
    .join("");
  return { body: rules + cells.map((c) => c.body).join(""), height };
}

// ---------------------------------------------------------------------------
// Content bounds — the graph's real horizontal extent.
// ---------------------------------------------------------------------------

function graphContentBounds(layout: Layout, byId: Map<string, GNode>): { minX: number; maxX: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  const ext = (lo: number, hi: number): void => {
    if (lo < minX) minX = lo;
    if (hi > maxX) maxX = hi;
  };
  for (const n of layout.nodes) {
    const [lo, hi] = nodeXExtent(n);
    ext(lo, hi);
  }
  for (const e of layout.edges) {
    for (const p of e.points) ext(p.x, p.x);
    const lab = edgeLabelPlacement(e);
    if (lab) {
      const w = textWidth(lab.text, EDGE_LABEL_FONT);
      ext(lab.anchor === "end" ? lab.x - w : lab.x, lab.anchor === "end" ? lab.x : lab.x + w);
    }
  }
  for (const f of layout.frames) ext(f.x0, f.x1);
  for (const a of layout.controlArcs) {
    const x = arcLaneX(a, layout, byId);
    if (x !== undefined) ext(x - 2, x);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return { minX: 0, maxX: layout.width };
  return { minX, maxX };
}

// ---------------------------------------------------------------------------
// The graph: frames behind, then edges, nodes, control arcs, edge labels.
// ---------------------------------------------------------------------------

function renderGraph(t: Theme, layout: Layout, byId: Map<string, GNode>): string {
  const frames = [...layout.frames]
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))
    .map((f) => renderFrame(t, f))
    .join("");
  const edges = layout.edges.map((e) => renderEdge(t, e, byId)).join("");
  const entered = new Set(layout.edges.map((e) => e.to));
  const nodes = layout.nodes.map((n) => renderNode(t, n, entered)).join("");
  const arcs = layout.controlArcs.map((a) => renderControlArc(t, a, layout, byId)).join("");
  const edgeLabels = layout.edges.map((e) => renderEdgeLabel(t, e)).join("");
  return frames + edges + nodes + arcs + edgeLabels;
}

/** A fork no edge enters starts the workflow: drawn as the UML initial node. */
function isStartFork(n: GNode, entered: Set<string>): boolean {
  return n.kind === "hub" && n.fork === true && !entered.has(n.id);
}

function renderNode(t: Theme, n: GNode, entered: Set<string>): string {
  switch (n.kind) {
    case "agent":
      return renderCard(t, n);
    case "barrier":
      return rect(n.x - (n.w ?? 0) / 2, n.y - (n.h ?? 4) / 2, n.w ?? 0, n.h ?? 4, (n.h ?? 4) / 2, t.join, undefined, 1, ` class="barrier"`);
    case "decision":
      return renderDecision(t, n);
    case "control":
      return isFinalNode(n) ? renderFinal(t, n) : renderControlPill(t, n);
    case "task":
      return n.task === "workflow" ? renderSubflow(t, n) : renderOpaque(t, n);
    case "hub":
      // A bare junction: the edges meeting there are the whole picture — except
      // where a fan-out starts the workflow, which gets a visible start.
      return isStartFork(n, entered)
        ? `<circle class="start" cx="${round(n.x)}" cy="${round(n.y)}" r="${START_R}" fill="${t.join}"/>`
        : "";
  }
}

/** An agent card: stack, card, label lines, model · effort with meter, ×N badge, caption. */
function renderCard(t: Theme, n: GNode): string {
  const card = n.card;
  if (!card) return "";
  const sw = cardSwatch(t, n);
  const x = n.x - card.w / 2;
  const top = n.y - (n.h ?? card.h) / 2;
  const parts: string[] = [];
  // The prompt preview (when the analyzer kept one) and the count's source ride
  // along as the card's tooltip.
  const tip = [n.tooltip, card.caption !== undefined ? `${CAPTION_PREFIX}${card.caption}` : undefined]
    .filter((s): s is string => s !== undefined && s !== "")
    .join("\n");
  if (tip) parts.push(`<title>${escapeSvgText(tip)}</title>`);
  if (card.mult !== undefined) {
    for (let d = DECK_DEPTH; d >= 1; d--) {
      parts.push(rect(x + d * DECK_STEP, top + d * DECK_STEP, card.w, card.cardH, CARD_RX, sw.fill, sw.stroke, 1));
    }
  }
  parts.push(rect(x, top, card.w, card.cardH, CARD_RX, sw.fill, sw.stroke, 1.25));
  card.lines.forEach((line, i) => {
    const y = top + CARD_BASELINE + i * CARD_LINE_STEP;
    parts.push(text(x + CARD_PAD_X, y, line, { ...LABEL_FONT, fill: card.derived ? t.muted : t.ink }));
  });
  if (card.meta !== undefined) {
    // The model line sits on the card's last line, so it lines up across a row
    // of cards that share a height even when their labels wrap differently.
    const y = top + card.cardH - (CARD_H1 - CARD_BASELINE);
    // A lone model line (no label, no meter) centers; otherwise it reads left to right.
    const alone = card.lines.length === 0 && card.meter === undefined;
    parts.push(
      text(alone ? n.x : x + CARD_PAD_X, y, card.meta, { ...META_FONT, fill: sw.text, anchor: alone ? "middle" : "start" }),
    );
    if (card.meter !== undefined) parts.push(meter(x + card.w - CARD_PAD_X - METER_W, y - 7.5, card.meter, sw));
  }
  if (card.mult !== undefined) parts.push(countBadge(t, x + card.w + DECK_STEP * DECK_DEPTH, top, card.mult));
  if (card.caption !== undefined) {
    const cy = top + card.cardH + DECK_STEP * DECK_DEPTH + 12;
    const pw = textWidth(CAPTION_PREFIX, CAPTION_FONT);
    const total = pw + textWidth(card.caption, CAPTION_CODE_FONT);
    const cx0 = n.x - total / 2;
    parts.push(
      text(cx0, cy, CAPTION_PREFIX, { ...CAPTION_FONT, fill: t.muted }) +
        text(cx0 + pw, cy, card.caption, { ...CAPTION_CODE_FONT, fill: t.muted }),
    );
  }
  return `<g class="agent-node">${parts.join("")}</g>`;
}

function meter(x: number, y: number, level: number, sw: Swatch): string {
  let s = "";
  for (let i = 0; i < METER_SEGMENTS; i++) {
    s += rect(x + i * (METER_SEG_W + METER_SEG_GAP), y, METER_SEG_W, 8, 1, sw.stroke, undefined, 1, i < level ? "" : ` fill-opacity="0.25"`);
  }
  return s;
}

/** The count badge straddling a stack's top-right corner. */
function countBadge(t: Theme, rightX: number, cy: number, label: string): string {
  const w = Math.ceil(textWidth(label, BADGE_FONT)) + 12;
  return (
    rect(rightX - w, cy - 8, w, 16, 8, t.chip) +
    text(rightX - w / 2, cy + 3.6, label, { ...BADGE_FONT, fill: t.chipText, anchor: "middle" })
  );
}

function renderDecision(t: Theme, n: GNode): string {
  const d = DIAMOND_HALF;
  const points = `${round(n.x)},${round(n.y - d)} ${round(n.x + d)},${round(n.y)} ${round(n.x)},${round(n.y + d)} ${round(n.x - d)},${round(n.y)}`;
  const left = n.labelSide === "left";
  const cond = text(left ? n.x - d - COND_GAP : n.x + d + COND_GAP, n.y + 4, n.label, {
    ...COND_FONT,
    fill: t.accentInk,
    anchor: left ? "end" : "start",
    halo: t.card,
  });
  return (
    `<g class="decision"><title>${escapeSvgText(n.label)}</title>` +
    `<polygon points="${points}" fill="${t.card}" stroke="${t.accent}" stroke-width="1.5"/>${cond}</g>`
  );
}

/** UML final node (◉): the workflow returns, throws, or simply ends here. */
function renderFinal(t: Theme, n: GNode): string {
  const tip = n.tooltip !== undefined ? `<title>${escapeSvgText(n.tooltip)}</title>` : "";
  return (
    `<g class="control-node">${tip}` +
    `<circle cx="${round(n.x)}" cy="${round(n.y)}" r="${TERMINAL_R}" fill="${t.card}" stroke="${t.join}" stroke-width="1.5"/>` +
    `<circle cx="${round(n.x)}" cy="${round(n.y)}" r="5" fill="${t.join}"/>` +
    text(n.x + TERMINAL_R + 8, n.y + 4, n.label, { ...COND_FONT, fill: n.flow === "throw" ? t.accentInk : t.muted }) +
    `</g>`
  );
}

/** A jump no arc can carry (`continue`/`break` outside a guard), named in mono. */
function renderControlPill(t: Theme, n: GNode): string {
  const w = n.w ?? 60;
  const h = n.h ?? 24;
  const tip = n.tooltip !== undefined ? `<title>${escapeSvgText(n.tooltip)}</title>` : "";
  return (
    `<g class="control-node">${tip}` +
    rect(n.x - w / 2, n.y - h / 2, w, h, h / 2, t.card, t.accent, 1.25) +
    text(n.x, n.y + 4, fitText(n.label, w - 2 * CARD_PAD_X, COND_FONT), { ...COND_FONT, fill: t.accentInk, anchor: "middle" }) +
    `</g>`
  );
}

/** The cards behind a stacked task box, and its count badge. */
function taskStack(t: Theme, n: GNode, x: number, top: number, w: number, h: number, stroke: string, extra = ""): { behind: string; badge: string } {
  if (n.mult === undefined) return { behind: "", badge: "" };
  let behind = "";
  for (let d = DECK_DEPTH; d >= 1; d--) behind += rect(x + d * DECK_STEP, top + d * DECK_STEP, w, h, 6, t.card, stroke, 1, extra);
  return { behind, badge: countBadge(t, x + w + DECK_STEP * DECK_DEPTH, top, n.mult) };
}

/** A `workflow()` call: a card with a doubled left rule (BPMN's call-activity cue). */
function renderSubflow(t: Theme, n: GNode): string {
  const w = n.w ?? 96;
  const stackH = n.mult !== undefined ? DECK_STEP * DECK_DEPTH : 0;
  const h = (n.h ?? 40) - stackH;
  const x = n.x - w / 2;
  const top = n.y - (n.h ?? 40) / 2;
  const label = fitText(n.label, w - 2 * CARD_PAD_X - 8, LABEL_FONT);
  const stack = taskStack(t, n, x, top, w, h, t.join);
  return (
    `<g class="task-node">${label !== n.label ? `<title>${escapeSvgText(n.label)}</title>` : ""}` +
    stack.behind +
    rect(x, top, w, h, 6, t.card, t.join, 1.25) +
    `<line x1="${round(x + 6)}" y1="${round(top + 5)}" x2="${round(x + 6)}" y2="${round(top + h - 5)}" stroke="${t.join}" stroke-width="1.25"/>` +
    text(x + CARD_PAD_X + 8, top + CARD_BASELINE, label, { ...LABEL_FONT, fill: t.ink }) +
    text(x + CARD_PAD_X + 8, top + CARD_BASELINE + CARD_LINE_STEP, "sub-workflow", { ...META_FONT, fill: t.muted }) +
    stack.badge +
    `</g>`
  );
}

/** Orchestration the analyzer could not read: an honest dashed box, source verbatim. */
function renderOpaque(t: Theme, n: GNode): string {
  const w = n.w ?? 96;
  const stackH = n.mult !== undefined ? DECK_STEP * DECK_DEPTH : 0;
  const h = (n.h ?? 30) - stackH;
  const x = n.x - w / 2;
  const top = n.y - (n.h ?? 30) / 2;
  const label = fitText(n.label, w - 2 * CARD_PAD_X, LABEL_FONT);
  const dash = ` stroke-dasharray="4 3"`;
  const stack = taskStack(t, n, x, top, w, h, t.muted, dash);
  return (
    `<g class="task-node">${label !== n.label ? `<title>${escapeSvgText(n.label)}</title>` : ""}` +
    stack.behind +
    rect(x, top, w, h, 6, t.card, t.muted, 1.25, dash) +
    text(n.x, top + h / 2 + 4, label, { ...LABEL_FONT, fill: t.body, anchor: "middle" }) +
    stack.badge +
    `</g>`
  );
}

function renderFrame(t: Theme, f: GFrame): string {
  const header = f.y0 + 19;
  const kx = f.headerX + FRAME_ICON_W;
  const cx = kx + textWidth(f.keyword, FRAME_KEYWORD_FONT) + 6;
  const suffix = f.iterations !== undefined ? ` · ×${f.iterations}` : "";
  const room = f.x1 - 12 - cx;
  const cond = fitText(`${f.condition}${suffix}`, room, FRAME_COND_FONT);
  const full = `${f.keyword} ${f.tooltip ?? f.condition}${suffix}`;
  return (
    `<g class="loop-frame"><title>${escapeSvgText(full)}</title>` +
    rect(f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0, 10, t.accentWash, t.accent, 1.25, ` fill-opacity="${t.accentWashOpacity}" stroke-dasharray="5 4"`) +
    loopGlyph(f.headerX + 6, f.y0 + 15, t.accentInk) +
    text(kx, header, f.keyword, { ...FRAME_KEYWORD_FONT, fill: t.accentInk }) +
    text(cx, header, cond, { ...FRAME_COND_FONT, fill: t.accentInk }) +
    `</g>`
  );
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

function renderEdge(t: Theme, e: GEdge, byId: Map<string, GNode>): string {
  const pts = e.points;
  if (pts.length < 2) return "";
  const target = byId.get(e.to);
  const parts = [strokePath(roundedPath(pts), t.edge)];
  // An edge into a join bar or a bare junction ends there without a head: the
  // bar is the sink, and a junction's onward edge carries the arrow.
  if (e.kind !== "merge" && target?.kind !== "hub" && target?.kind !== "barrier") {
    const tip = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    parts.push(arrowHead(tip.x, tip.y, Math.atan2(tip.y - prev.y, tip.x - prev.x), t.edge));
  }
  return `<g class="edge">${parts.join("")}</g>`;
}

/** Where a branch-outcome label goes: above a first segment that runs sideways,
 *  beside one that runs down. */
function edgeLabelPlacement(e: GEdge): { x: number; y: number; text: string; anchor: "start" | "end" } | null {
  if (e.label === undefined || e.points.length < 2) return null;
  const [a, b] = e.points;
  if (Math.abs(a.y - b.y) < 0.5) {
    const right = b.x > a.x;
    return { x: a.x + (right ? 8 : -8), y: a.y - 5, text: e.label, anchor: right ? "start" : "end" };
  }
  return { x: a.x + 6, y: a.y + 13, text: e.label, anchor: "start" };
}

function renderEdgeLabel(t: Theme, e: GEdge): string {
  const p = edgeLabelPlacement(e);
  if (!p) return "";
  return text(p.x, p.y, p.text, { ...EDGE_LABEL_FONT, fill: t.muted, anchor: p.anchor, halo: t.card });
}

// ---------------------------------------------------------------------------
// Control arcs — continue back to the top of the loop body, break out of it.
// ---------------------------------------------------------------------------

/** The x of the lane a control arc runs in: tight beside the diamond for a guard
 *  that loops back to itself, else inside its frame's reserved left lane. */
function arcLaneX(a: ControlArc, layout: Layout, byId: Map<string, GNode>): number | undefined {
  const from = byId.get(a.fromId);
  if (!from) return undefined;
  if (a.fromId === a.toId) return from.x - DIAMOND_HALF - SELF_LOOP_DX;
  const frame = a.frame !== undefined ? layout.frames.find((f) => f.id === a.frame) : undefined;
  return frame ? frame.x0 + ARC_LANE / 2 + 1 : from.x - DIAMOND_HALF - ARC_LANE;
}

/**
 * Where an arc turns in toward its target: just above the target — unless the
 * target heads a loop frame the arc must enter from outside (a loop nested at
 * the top of the body a `continue` returns to, or a loop a `break` lands on),
 * where it turns above that frame instead of through its header.
 */
function arcTurnY(a: ControlArc, from: GNode, to: GNode, toTop: number, layout: Layout): number {
  const into = a.into !== undefined ? layout.frames.find((f) => f.id === a.into) : undefined;
  const inside = (f: GFrame, n: GNode): boolean => n.x > f.x0 && n.x < f.x1 && n.y > f.y0 && n.y < f.y1;
  const entered = layout.frames.filter(
    (f) => f.entry === to.id && (into ? f.id !== into.id && f.y0 > into.y0 : !inside(f, from)),
  );
  return entered.length > 0 ? Math.min(...entered.map((f) => f.y0)) - ELBOW / 2 : toTop - 11;
}

/**
 * A control-flow arc in the accent color, orthogonal like every edge: from the
 * guard's left vertex out to its frame's arc lane, then — `continue` — up and
 * back into the top of the loop body (the guard itself when it heads the body),
 * or — `break` — down, out of the frame, and into the loop's successor.
 */
function renderControlArc(t: Theme, a: ControlArc, layout: Layout, byId: Map<string, GNode>): string {
  const from = byId.get(a.fromId);
  const to = byId.get(a.toId);
  const lane = arcLaneX(a, layout, byId);
  if (!from || !to || lane === undefined) return "";
  const d = DIAMOND_HALF;
  const toTop = to.kind === "decision" ? to.y - d : to.y - (to.h ?? 2 * to.r) / 2;
  const turnY = arcTurnY(a, from, to, toTop, layout);
  const points = [
    { x: from.x - d, y: from.y },
    { x: lane, y: from.y },
    { x: lane, y: turnY },
    { x: to.x, y: turnY },
    { x: to.x, y: toTop },
  ];
  const parts = [
    strokePath(roundedPath(points), t.accent, 1.4),
    arrowHead(to.x, toTop, Math.PI / 2, t.accent),
    // The outcome that takes the jump, just under the arc where it leaves the diamond.
    text(from.x - d - 6, from.y + 13, a.outcome, { ...EDGE_LABEL_FONT, fill: t.accentInk, anchor: "end", halo: t.card }),
  ];
  return `<g class="control-arc"><title>${escapeSvgText(`${a.outcome} → ${a.flow}`)}</title>${parts.join("")}</g>`;
}

// ---------------------------------------------------------------------------
// Legend — exactly the glyphs this diagram uses, in a wrapping row.
// ---------------------------------------------------------------------------

interface LegendItem {
  glyphW: number;
  glyph: (x: number, cy: number) => string;
  term?: string;
  desc: string;
  /** Items of one group (the model swatches) sit closer together. */
  group?: string;
}

function legendItems(t: Theme, layout: Layout): LegendItem[] {
  const items: LegendItem[] = [];
  const agents = layout.nodes.filter((n) => n.kind === "agent");
  const seen = new Set<string>();
  const models: Array<{ name: string; sw: Swatch; dashed?: boolean }> = [];
  for (const n of agents) {
    const key = modelKey(n);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ name: key, sw: cardSwatch(t, n) });
  }
  // The inherited state reads last, after the explicit models.
  models.sort((a, b) => Number(a.name === "session model") - Number(b.name === "session model"));
  models.forEach((m, i) =>
    items.push({
      glyphW: 12,
      glyph: (x, cy) => rect(x, cy - 5, 10, 10, 2.5, m.sw.fill, m.sw.stroke, 1),
      ...(i === 0 ? { term: "model" } : {}),
      desc: m.name,
      group: "model",
    }),
  );
  if (agents.some((n) => n.card?.meter !== undefined)) {
    items.push({
      glyphW: METER_W + 2,
      glyph: (x, cy) => meter(x, cy - 4, 2, t.session),
      term: "effort",
      desc: EFFORT_TIERS.join(" · "),
    });
  }
  const mults = layout.nodes.map((n) => n.mult).filter((m): m is string => m !== undefined);
  if (mults.length > 0) {
    items.push({
      glyphW: 20,
      glyph: (x, cy) =>
        rect(x + 4, cy - 3, 14, 9, 2, t.card, t.muted) + rect(x + 2, cy - 5, 14, 9, 2, t.card, t.muted) + rect(x, cy - 7, 14, 9, 2, t.card, t.muted),
      term: mults.includes("×N") ? "×N" : "×k",
      desc: mults.includes("×N") ? "one per item, counted at run time" : "copies drawn as one stack",
    });
  }
  if (layout.nodes.some((n) => n.kind === "barrier")) {
    items.push({ glyphW: 22, glyph: (x, cy) => rect(x, cy - 2, 22, 4, 2, t.join), term: "join", desc: "waits for all" });
  }
  if (layout.nodes.some((n) => n.kind === "decision")) {
    items.push({
      glyphW: 12,
      glyph: (x, cy) =>
        `<polygon points="${round(x + 6)},${round(cy - 6)} ${round(x + 12)},${round(cy)} ${round(x + 6)},${round(cy + 6)} ${round(x)},${round(cy)}" fill="${t.card}" stroke="${t.accent}" stroke-width="1.2"/>`,
      desc: "decision",
    });
  }
  if (layout.frames.length > 0) {
    items.push({
      glyphW: 18,
      glyph: (x, cy) => rect(x, cy - 6, 18, 12, 3, t.accentWash, t.accent, 1, ` fill-opacity="${t.accentWashOpacity}" stroke-dasharray="3 2"`),
      term: "loop",
      desc: "repeats the framed body",
    });
  }
  const flows = (["continue", "break"] as const).filter((f) => layout.controlArcs.some((a) => a.flow === f));
  if (flows.length > 0) {
    const meaning = { continue: "loop again from the top", break: "leave the loop" } as const;
    items.push({
      glyphW: 18,
      glyph: (x, cy) => strokePath(`M ${round(x)} ${round(cy)} L ${round(x + 12)} ${round(cy)}`, t.accent, 1.4) + arrowHead(x + 18, cy, 0, t.accent),
      term: flows.join(" / "),
      desc: flows.length === 2 ? "loop again / leave the loop" : meaning[flows[0]],
    });
  }
  if (layout.nodes.some((n) => n.kind === "task" && n.task === "workflow")) {
    items.push({
      glyphW: 16,
      glyph: (x, cy) =>
        rect(x, cy - 6, 16, 12, 2, t.card, t.join) +
        `<line x1="${round(x + 3.5)}" y1="${round(cy - 4)}" x2="${round(x + 3.5)}" y2="${round(cy + 4)}" stroke="${t.join}"/>`,
      desc: "sub-workflow",
    });
  }
  if (layout.nodes.some((n) => n.kind === "task" && n.task === "opaque")) {
    items.push({
      glyphW: 16,
      glyph: (x, cy) => rect(x, cy - 6, 16, 12, 2, t.card, t.muted, 1, ` stroke-dasharray="3 2"`),
      desc: "not read statically",
    });
  }
  const entered = new Set(layout.edges.map((e) => e.to));
  if (layout.nodes.some((n) => isStartFork(n, entered))) {
    items.push({
      glyphW: 10,
      glyph: (x, cy) => `<circle cx="${round(x + 5)}" cy="${round(cy)}" r="4" fill="${t.join}"/>`,
      desc: "workflow starts",
    });
  }
  if (layout.nodes.some((n) => isFinalNode(n))) {
    items.push({
      glyphW: 12,
      glyph: (x, cy) =>
        `<circle cx="${round(x + 6)}" cy="${round(cy)}" r="5.5" fill="${t.card}" stroke="${t.join}" stroke-width="1.2"/>` +
        `<circle cx="${round(x + 6)}" cy="${round(cy)}" r="3" fill="${t.join}"/>`,
      desc: "workflow ends",
    });
  }
  return items;
}

/** The legend laid out left to right from (x, 0), wrapping at `width`. */
function renderLegend(t: Theme, layout: Layout, x: number, width: number): Block {
  const items = legendItems(t, layout);
  if (items.length === 0) return { body: "", height: 0 };
  const parts: string[] = [];
  let cx = x;
  let row = 0;
  const cy = (): number => row * LEGEND_ROW_H + 7;
  for (const [i, item] of items.entries()) {
    const termW = item.term ? textWidth(item.term, LEGEND_TERM_FONT) + 5 : 0;
    const w = termW + item.glyphW + 5 + textWidth(item.desc, LEGEND_FONT);
    if (cx + w > x + width && cx > x) {
      cx = x;
      row++;
    }
    let ix = cx;
    if (item.term) {
      parts.push(text(ix, cy() + 3.8, item.term, { ...LEGEND_TERM_FONT, fill: t.body }));
      ix += termW;
    }
    parts.push(item.glyph(ix, cy()));
    ix += item.glyphW + 5;
    parts.push(text(ix, cy() + 3.8, item.desc, { ...LEGEND_FONT, fill: t.muted }));
    const next = items[i + 1];
    cx += w + (item.group !== undefined && next?.group === item.group ? 12 : 22);
  }
  return { body: parts.join(""), height: (row + 1) * LEGEND_ROW_H - 6 };
}
