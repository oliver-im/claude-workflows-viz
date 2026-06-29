import type { Meta } from "./model.js";
import type { ControlArc, GEdge, GLane, GLoop, GNode, LaneMember, Layout } from "./topo-geometry.js";
import { type Provenance, renderFooter, renderHeader } from "./render-svg.js";
import { closeLaneGaps, reserveLaneHeights } from "./place-topology.js";
import {
  type Block,
  COL_GAP,
  GAP,
  LEFT_COL_W,
  MARGIN,
  MODEL_FALLBACK,
  type TextOpts,
  W,
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
 * its own coordinate frame (`layout.width` == `W`) and translated right into the
 * graph column — so placement is byte-identical to before; only the page gains a
 * left label column and goes landscape. The graph's x-translate and the page
 * width are NOT fixed: they are fit to the graph's actual horizontal content
 * extent (`graphContentBounds`), so its leftmost drawn element hugs the label
 * column and the page ends at its real right edge — no wide right void, no gap
 * from a spine pinned at 0.4·W inside an over-wide frame.
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
export function renderTopology(layout: Layout, meta: Meta, prov?: Provenance): string {
  const gw = layout.width; // the graph's own frame width (== W)

  // Build each lane's left label cell, then inflate its band to fit so the
  // label and its graph slice co-register into one row.
  const detailByTitle = new Map(
    meta.phases.filter((p) => p.detail?.trim()).map((p) => [p.title, p.detail as string]),
  );
  const cells = layout.lanes.map((l) =>
    l.members
      ? renderParallelLaneCell(l.members, detailByTitle)
      : renderLaneLabelCell(l.ordinal, l.title, detailByTitle.get(l.title), l.model, l.empty),
  );
  reserveLaneHeights(layout, cells.map((c) => c.height));
  closeLaneGaps(layout); // seamless table — no gaps between phase rows

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

  // Fit the graph to its real horizontal extent: anchor its leftmost drawn
  // element one COL_GAP past the label column, and end the page at its right
  // edge. This packs the graph against the labels and trims the right void that
  // a fixed W-wide frame (spine pinned at 0.4·W) used to leave. A floor keeps the
  // header readable when the graph is a thin single spine.
  const { minX, maxX } = graphContentBounds(layout, byId, gw, { showDerivedLabels: false });
  const graphX = Math.round(MARGIN + LEFT_COL_W + COL_GAP - minX);
  const pageW = Math.max(Math.ceil(graphX + maxX + MARGIN), MIN_TOPO_PAGE_W);
  const innerCardW = pageW - 2 * MARGIN;

  const header = renderHeader(meta, MARGIN, innerCardW);
  const yOffset = MARGIN + header.height + GAP;

  // One rounded white card behind every phase — same radius/border/fill as the
  // header card, so the table reads as the same kind of surface.
  const first = layout.lanes[0];
  const last = layout.lanes[layout.lanes.length - 1];
  const tableTop = first ? first.yTop : 0;
  const tableBot = last ? last.yBot : layout.height;
  const tableCard = roundRect(
    MARGIN,
    tableTop,
    innerCardW,
    tableBot - tableTop,
    TABLE_RX,
    ROW_BG,
    ROW_SEP,
  );
  const rows = layout.lanes.map((l, i) => renderRow(l, i, pageW)).join("");
  const labels = layout.lanes
    .map((l, i) => `<g transform="translate(0 ${round(l.yTop)})">${cells[i].body}</g>`)
    .join("");
  const edges = layout.edges.map((e) => renderEdge(e)).join("");
  const nodes = layout.nodes.map((n) => renderNode(n, gw, { showDerivedLabels: false })).join("");
  const arcs = layout.controlArcs.map((a) => renderControlArc(a, byId)).join("");
  const loops = layout.loops.map((l, i) => renderLoop(l, i, layout, byId, gw)).join("");
  // Card behind, then phase separators, then labels, then the graph column. Arcs
  // sit above the nodes so a loop-back arrowhead reads on top of its gate.
  const content =
    `<g transform="translate(0 ${round(yOffset)})">` +
    tableCard +
    rows +
    labels +
    `<g class="topology" transform="translate(${graphX} 0)">${edges}${nodes}${arcs}${loops}</g>` +
    `</g>`;

  const width = pageW;
  let height = round(yOffset + layout.height + MARGIN);

  let footer = "";
  if (prov) {
    const f = renderFooter(prov, pageW, height);
    footer = f.body;
    height = round(height + f.height);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" ` +
    `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">\n` +
    `<rect width="${width}" height="${height}" fill="${PAGE_BG}"/>\n` +
    `<g transform="translate(0 ${round(MARGIN)})">${header.body}</g>\n` +
    content +
    (footer ? `\n${footer}` : "") +
    `\n</svg>\n`
  );
}

/**
 * Graph-only topology view: draw the placed body topology without the workflow
 * header or phase table. Unlike the full workflow view, derived agent labels are
 * shown here because there is no phase row beside the node to name it.
 */
export function renderTopologyGraph(layout: Layout, prov?: Provenance): string {
  const gw = layout.width;
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const { minX, maxX } = graphContentBounds(layout, byId, gw, { showDerivedLabels: true });
  const graphX = Math.round(MARGIN - minX);
  const pageW = Math.max(Math.ceil(maxX - minX + 2 * MARGIN), MIN_GRAPH_PAGE_W);
  const graphY = MARGIN;
  const graphH = layout.height;

  const edges = layout.edges.map((e) => renderEdge(e)).join("");
  const nodes = layout.nodes.map((n) => renderNode(n, gw, { showDerivedLabels: true })).join("");
  const arcs = layout.controlArcs.map((a) => renderControlArc(a, byId)).join("");
  const loops = layout.loops.map((l, i) => renderLoop(l, i, layout, byId, gw)).join("");

  const content =
    `<g class="topology" transform="translate(${graphX} ${round(graphY)})">` +
    `${edges}${nodes}${arcs}${loops}</g>`;

  const width = pageW;
  let height = round(graphY + graphH + MARGIN);

  let footer = "";
  if (prov) {
    const f = renderFooter(prov, pageW, height);
    footer = f.body;
    height = round(height + f.height);
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" ` +
    `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">\n` +
    `<rect width="${width}" height="${height}" fill="${PAGE_BG}"/>\n` +
    content +
    (footer ? `\n${footer}` : "") +
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
const ROW_BG = "#ffffff"; // the phases sit on one plain white card — no model tint
const ROW_SEP = "#e2e8f0"; // card border + hairline between phases (matches the header card)
const KNOCKOUT_FILL = ROW_BG; // label knockout plate — the white card the graph sits on
const TABLE_RX = 12; // table card corner radius — same as the header card above it
const CHIP_FILL = "#334155";

/** Page-width floor so a thin single-spine graph still gives the header card a
 *  comfortable measure (matches the phases-view card width). */
const MIN_TOPO_PAGE_W = W;
const MIN_GRAPH_PAGE_W = 360;

const DETAIL_MAX_LINES = 99; // effectively uncapped — the phase detail wraps in full
const CHIP_R = 11;
const TITLE_FONT = 15;
const LABEL_FONT = 12.5;
const MEMBER_FONT = 11;
const BADGE_FONT = 11;
const LOOP_FONT = 11;
const EDGE_W = 1.3;
const FAN_W = 1.1;
const NODE_STROKE_W = 1.25;
/** How far a continue loop-back arc bulges left past the guard diamond. */
const ARC_BULGE = 15;
const ARC_W = 1.4;

// ---------------------------------------------------------------------------
// Rows — a full-width, model-tinted band per phase, spanning BOTH columns; the
// left label cell and the right graph slice sit inside it.
// ---------------------------------------------------------------------------

function renderRow(lane: GLane, i: number, pageW: number): string {
  // The phases share ONE rounded white card (drawn once in renderTopology, like
  // the header card above). A row only contributes a full-width hairline at its
  // top boundary — every phase but the first — so phases still read as a table
  // without any tint. The class stays as a semantic hook (incl. control-only).
  const x = MARGIN;
  const w = round(pageW - 2 * MARGIN);
  const sep =
    i > 0
      ? `<line x1="${x}" y1="${round(lane.yTop)}" x2="${round(x + w)}" y2="${round(lane.yTop)}" ` +
        `stroke="${ROW_SEP}" stroke-width="1"/>`
      : "";
  return `<g class="${lane.empty ? "swimlane-empty" : "swimlane"}">${sep}</g>`;
}

/** Sizing for one label cell — full-width (`MARGIN`/`LEFT_COL_W`) by default, or
 *  a narrow `compact` sub-cell when several share a row (a collapsed parallel). */
interface CellOpts {
  cellX?: number;
  cellW?: number;
  compact?: boolean;
}

/**
 * The left label cell for one phase row: the numbered chip, the phase title,
 * the wrapped detail, then — last and quietest — a `model: xx` footnote. The
 * model stays secondary, but is set apart from a control-only note (both used to
 * be the same muted italic): a small swatch dot keyed to the model — the same
 * hue its agent nodes carry in the graph — then the id upright in slate. A
 * control-only (empty) lane shows the title plus a muted italic "control only"
 * note instead. Padding is harmonized with the header card (`renderHeader`) so
 * the cell reads as the same surface and its content aligns down the left edge.
 *
 * In `compact` mode the cell shrinks to fit a sub-column of a collapsed
 * parallel row: tighter padding, a smaller chip, the title wraps to two lines
 * instead of truncating, and the model shows its short family name (full id in
 * a `<title>`) so a long id doesn't blow the column. The detail is NOT capped —
 * it wraps in full like a full-width cell, and the row grows to fit it.
 *
 * Drawn relative to (`cellX`, 0); the caller translates it to the lane's top.
 * Returns its measured height so the row can be co-registered to fit it.
 */
function renderLaneLabelCell(
  index: number,
  title: string,
  detail: string | undefined,
  model: string | undefined,
  empty: boolean,
  opts: CellOpts = {},
): Block {
  const x = opts.cellX ?? MARGIN;
  const colW = opts.cellW ?? LEFT_COL_W;
  const compact = opts.compact ?? false;
  const padX = compact ? 12 : 22; // full-width matches the header card's left rule
  const padTop = compact ? 16 : 18;
  const padBottom = compact ? 14 : 18;
  const chipR = compact ? 9 : CHIP_R;
  const titleFont = compact ? 13 : TITLE_FONT;
  const detailFont = compact ? 11 : 12.5;
  const modelFont = compact ? 10.5 : 11.5;
  const lineH = compact ? 15 : 17;

  const chipCx = x + padX + chipR;
  const chipCy = padTop + chipR;
  const textX = x + padX + 2 * chipR + (compact ? 8 : 12);
  const innerW = x + colW - padX - textX;

  const parts: string[] = [
    `<circle cx="${round(chipCx)}" cy="${round(chipCy)}" r="${chipR}" fill="${CHIP_FILL}"/>`,
    text(chipCx, chipCy + (compact ? 3.4 : 3.7), String(index), {
      size: compact ? 10.5 : 11.5,
      weight: 700,
      fill: "#ffffff",
      anchor: "middle",
    }),
  ];

  // One line (truncated) normally; up to two wrapped lines when compact, so a
  // long phase name still fits a narrow side-by-side sub-cell.
  const titleLines = compact
    ? wrapToWidth(title, innerW, titleFont, 2)
    : [truncateToWidth(title, innerW, titleFont)];
  let y = padTop + (compact ? 13 : 16);
  titleLines.forEach((line, i) => {
    if (i > 0) y += titleFont + 2;
    parts.push(text(textX, y, line, { size: titleFont, weight: 700, fill: TITLE }));
  });

  if (empty) {
    y += compact ? 16 : 20;
    parts.push(text(textX, y, "control only", { size: compact ? 10 : 11, style: "italic", fill: MUTED }));
    return { body: `<g class="lane-label">${parts.join("")}</g>`, height: y + padBottom };
  }

  // A small breath under the title before the detail, echoing the header card.
  if (detail?.trim()) y += 3;
  // The explanation wraps in full and the row grows to fit via reserveLaneHeights
  // (full-width and compact cells alike); an over-long unbreakable token hard-
  // wraps rather than truncating. The only residual clip is the DETAIL_MAX_LINES
  // backstop, and the full text rides along in the cell's <title> regardless — so
  // the explanation is never silently lost.
  const detailLines = detail?.trim() ? wrapToWidth(detail.trim(), innerW, detailFont, DETAIL_MAX_LINES) : [];
  for (const line of detailLines) {
    y += lineH;
    parts.push(text(textX, y, line, { size: detailFont, fill: DETAIL }));
  }
  // The model footnote: a swatch dot (a miniature of the agent node it tints in
  // the graph) then the id upright in slate — quiet, but a clearly different
  // category from the muted italic "control only" note above. Compact drops the
  // "model:" prefix and shows the short family (full id in a <title>).
  if (model !== undefined) {
    y += compact ? 16 : 19;
    const sw = swatchFor(model);
    const dotR = 4;
    const labelX = textX + 2 * dotR + 7;
    const label = compact ? shortModel(model) : `model: ${model}`;
    const labelEl = text(labelX, y, truncateToWidth(label, x + colW - padX - labelX, modelFont), {
      size: modelFont,
      fill: EDGE,
    });
    parts.push(
      `<circle cx="${round(textX + dotR)}" cy="${round(y - 4)}" r="${dotR}" ` +
        `fill="${sw.fill}" stroke="${sw.stroke}" stroke-width="1"/>`,
      compact ? `<g><title>${escapeSvgText(`model: ${model}`)}</title>${labelEl}</g>` : labelEl,
    );
  }
  // Safety net: the full, untruncated explanation rides along as the cell's
  // <title>, so even the DETAIL_MAX_LINES backstop can't make it unrecoverable.
  const cellTitle = detail?.trim() ? `<title>${escapeSvgText(detail.trim())}</title>` : "";
  return { body: `<g class="lane-label">${cellTitle}${parts.join("")}</g>`, height: y + padBottom };
}

/**
 * The left cell for a collapsed parallel row: its concurrent arms drawn as
 * equal-width `compact` sub-cells side by side, split by faint vertical rules —
 * so each lineage keeps its own chip, title, and model badge while the row as a
 * whole co-registers to the parallel block beside it. Height is the tallest
 * sub-cell; the rules span that height.
 */
function renderParallelLaneCell(members: LaneMember[], detailByTitle: Map<string, string>): Block {
  const subW = LEFT_COL_W / members.length;
  const cells = members.map((m, i) =>
    renderLaneLabelCell(m.ordinal, m.title, detailByTitle.get(m.title), m.model, false, {
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
      return `<line x1="${rx}" y1="12" x2="${rx}" y2="${round(height - 6)}" stroke="${ROW_SEP}" stroke-width="1"/>`;
    })
    .join("");
  return { body: rules + cells.map((c) => c.body).join(""), height };
}

/** A model's short family name for a cramped sub-cell ("claude-opus-4-8" →
 *  "opus"); an unrecognized id is returned verbatim (the caller truncates). */
function shortModel(model: string): string {
  const m = model.toLowerCase();
  for (const key of ["opus", "sonnet", "haiku"]) if (m.includes(key)) return key;
  return model;
}

// ---------------------------------------------------------------------------
// Content bounds — the graph's real horizontal extent, so the page can pack to
// it instead of the fixed W frame.
// ---------------------------------------------------------------------------

/** Conservative drawn-text width — mirrors the 0.58em glyph the text fitters
 *  (`fitChars`) assume, so a bound built from it never under-fits a label. */
function estTextW(s: string, size: number): number {
  return s.length * size * 0.58;
}

// Knockout padding around the glyphs — a hair of breathing room so the plate
// clears the text's own ink without growing big enough to bite a neighbour.
const KNOCKOUT_PAD_X = 3;
const KNOCKOUT_PAD_Y = 1.5;

/**
 * In-graph text drawn over an opaque plate in the card background colour, so an
 * edge running behind the text is OCCLUDED where the glyphs sit and the label
 * always reads cleanly. This is the layout-independent guarantee against
 * edge-over-text: it does not depend on any gap, label width, or member count
 * working out — wherever an edge and a label share a coordinate channel (the
 * fan-out's vertical member→barrier drops are the guaranteed case), the plate
 * breaks the line behind the text instead of letting it cut through the ink.
 *
 * The plate is painted in the SAME group as the text, immediately before it, so
 * it inherits that text's place in the paint order — and since all graph labels
 * live in the node/loop layers (drawn AFTER the edge layer in `renderTopology`),
 * the plate always lands on top of the edges it needs to hide. Sized to the
 * (already-truncated) `content` via the same 0.58em metric the fitters use;
 * `anchor` mirrors the text's so the plate centres when the text is centred.
 */
function knockoutText(x: number, y: number, content: string, o: TextOpts): string {
  if (content === "") return "";
  const w = estTextW(content, o.size) + 2 * KNOCKOUT_PAD_X;
  const h = o.size + 2 * KNOCKOUT_PAD_Y;
  const anchor = o.anchor ?? "start";
  const left = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w + KNOCKOUT_PAD_X : x - KNOCKOUT_PAD_X;
  // Baseline at `y`: the plate spans from above the cap height to below the
  // descender, so ascenders and descenders both clear.
  const top = y - o.size * 0.8 - KNOCKOUT_PAD_Y;
  const plate =
    `<rect x="${round(left)}" y="${round(top)}" width="${round(w)}" height="${round(h)}" fill="${KNOCKOUT_FILL}"/>`;
  return plate + text(x, y, content, o);
}

/**
 * The graph's horizontal content extent in its own (untranslated) frame: every
 * shape body PLUS every label/badge that sticks out past it — below-set and
 * right-side node labels, the ×N peek circle + badge, the decision condition,
 * and the loop badge — and the edge points for good measure. Computed with the
 * exact draw math the `render*` functions use (same fonts, same truncations,
 * the same `gw`-derived clamps), so the page packs to content without ever
 * clipping a label. Falls back to the full `gw` frame for a graph with no nodes.
 */
function graphContentBounds(
  layout: Layout,
  byId: Map<string, GNode>,
  gw: number,
  opts: { showDerivedLabels: boolean },
): { minX: number; maxX: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  const ext = (lo: number, hi: number): void => {
    if (lo < minX) minX = lo;
    if (hi > maxX) maxX = hi;
  };
  for (const n of layout.nodes) {
    if (n.kind === "barrier" || n.kind === "task" || n.kind === "control") {
      const w = n.w ?? 2 * n.r;
      ext(n.x - w / 2, n.x + w / 2);
      continue;
    }
    if (n.kind === "decision") {
      ext(n.x - n.r, n.x + n.r);
      ext(n.x, n.x + n.r + 6 + estTextW(truncatePlain(n.label, 36), MEMBER_FONT));
      continue;
    }
    // agent / hub — the circle, plus the ×N peek circle + badge and the label.
    ext(n.x - n.r, n.x + n.r + (n.mult !== undefined ? 2 : 0));
    if (n.mult !== undefined) ext(n.x, n.x + n.r + 1 + estTextW(n.mult, BADGE_FONT));
    if (n.label && (opts.showDerivedLabels || n.labelExplicit !== false)) {
      if (n.labelBelow === true) {
        const w = estTextW(truncateToWidth(n.label, 150, MEMBER_FONT), MEMBER_FONT);
        ext(n.x - w / 2, n.x + w / 2);
      } else {
        const lx = n.x + n.r + 8;
        const w = estTextW(truncateToWidth(n.label, gw - MARGIN - lx, LABEL_FONT), LABEL_FONT);
        ext(lx, lx + w);
      }
    }
  }
  for (const e of layout.edges) {
    for (const p of e.points) ext(p.x, p.x);
    if (e.label !== undefined && e.points.length >= 2) {
      const tip = e.points[e.points.length - 1];
      const prev = e.points[e.points.length - 2];
      const mx = (prev.x + tip.x) / 2 + 5;
      ext(mx, mx + estTextW(e.label, 10.5));
    }
  }
  for (const l of layout.loops) {
    const node = byId.get(l.onNode);
    if (!node) continue;
    const lx = node.x + node.r + 8;
    const w = estTextW(truncateToWidth(`↻ ${l.label}`, gw - MARGIN - lx, LOOP_FONT), LOOP_FONT);
    ext(lx, lx + w);
  }
  // A continue arc bows left of its gate, its outcome label further left still.
  // Mirror renderControlArc: a self-loop reaches its ↺ circle's left edge (cx − r);
  // a spanning arc bows out by ARC_BULGE.
  for (const a of layout.controlArcs) {
    const from = byId.get(a.fromId);
    if (!from) continue;
    const r = from.r + 2;
    const leftmost =
      a.fromId === a.toId ? from.x - from.r - r * 0.45 - r : from.x - from.r - ARC_BULGE;
    ext(leftmost - 4 - estTextW(a.outcome, MEMBER_FONT), from.x);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return { minX: 0, maxX: gw };
  return { minX, maxX };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function renderNode(n: GNode, width: number, opts: { showDerivedLabels: boolean }): string {
  switch (n.kind) {
    case "agent":
      return renderAgent(n, width, opts);
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

function renderAgent(n: GNode, width: number, opts: { showDerivedLabels: boolean }): string {
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
  parts.push(...nodeLabel(n, width, opts));
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
    knockoutText(n.x + d + 6, n.y + 4, cond, { size: MEMBER_FONT, style: "italic", fill: MUTED }),
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
function nodeLabel(n: GNode, width: number, opts: { showDerivedLabels: boolean }): string[] {
  if (!n.label) return [];
  // Derived (prompt-sliced) labels are redundant with the phase row that groups
  // the node — drop the text and let the row name it. Authored labels stay. The
  // prompt still rides along as the node's <title> (renderAgent), so nothing is
  // lost; the JSON read contract keeps the full label either way.
  if (!opts.showDerivedLabels && n.labelExplicit === false) return [];
  if (n.labelBelow === true) {
    return [
      knockoutText(n.x, n.y + n.r + 12, truncateToWidth(n.label, 150, MEMBER_FONT), {
        size: MEMBER_FONT,
        fill: NODE_LABEL,
        anchor: "middle",
      }),
    ];
  }
  const maxW = width - MARGIN - (n.x + n.r + 8);
  return [
    knockoutText(n.x + n.r + 8, n.y + 4, truncateToWidth(n.label, maxW, LABEL_FONT), {
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
  // A merge edge fans INTO the coral join bar — the bar is the sink, so an
  // arrowhead diving into it is redundant clutter (and, sitting below the
  // member label, reads as a free-floating arrow). The line alone meets the bar.
  if (e.kind !== "merge") {
    parts.push(arrowHead(tip.x, tip.y, Math.atan2(tip.y - prev.y, tip.x - prev.x), EDGE));
  }
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
  // Stack multiple badges on one node (nested loops), inner-first. A decision
  // head stacks UPWARD — its lower-right is taken by the yes/no branch labels and
  // its own condition, so the badges ride above the diamond (matching the row
  // placement reserved above it). Every other head stacks DOWN, below its
  // right-side label, where neither the label nor the downward edge collides.
  const rank = layout.loops.slice(0, i).filter((l) => l.onNode === loop.onNode).length;
  const x = node.x + node.r + 8;
  const step = LOOP_FONT + 3;
  const y =
    node.kind === "decision"
      ? node.y - node.r - 6 - rank * step
      : node.y + node.r + 6 + rank * step;
  const maxW = width - MARGIN - x;
  return `<g class="loop-badge"><title>${escapeSvgText(loop.tooltip ?? loop.label)}</title>${knockoutText(x, y, truncateToWidth(`↻ ${loop.label}`, maxW, LOOP_FONT), {
    size: LOOP_FONT,
    weight: 600,
    fill: ACCENT,
  })}</g>`;
}

/**
 * A control-flow arc (`ControlArc`), the standard CFG jump the downward flow can't
 * carry. `continue` is the back-edge: a coral stroke returning to the loop head —
 * a circular ↺ tucked against the gate when the guard IS the head, else a smooth
 * curve climbing the left margin up to the head above. `break` is its forward
 * mirror: the SAME smooth curve, but the target sits BELOW (the loop's successor),
 * so it reads as a drop out of the loop. Direction tells them apart; both replace
 * a heavy "continue loop"/"break loop" box with one quiet glyph.
 */
function renderControlArc(arc: ControlArc, byId: Map<string, GNode>): string {
  const from = byId.get(arc.fromId);
  const to = byId.get(arc.toId);
  if (!from || !to) return "";

  const d = from.r; // diamond half-diagonal
  if (arc.flow === "continue" && from.id === to.id) {
    // Self-loop: a near-full circular ↺ tucked against the gate's left, its gap
    // facing the diamond and its arrowhead sweeping back into it.
    const r = d + 2;
    const cx = from.x - d - r * 0.45;
    const cy = from.y;
    const a0 = 0.62 * Math.PI; // start lower-right of the circle
    const a1 = -0.62 * Math.PI; // end upper-right, leaving the gap toward the gate
    const sx = cx + r * Math.cos(a0);
    const sy = cy + r * Math.sin(a0);
    const tipX = cx + r * Math.cos(a1);
    const tipY = cy + r * Math.sin(a1);
    const stroke = strokePath(
      `M ${round(sx)} ${round(sy)} A ${round(r)} ${round(r)} 0 1 1 ${round(tipX)} ${round(tipY)}`,
      ACCENT,
      { width: ARC_W },
    );
    // tangent at the end of a clockwise sweep, pointing back into the gate
    return arcGroup(stroke, tipX, tipY, a1 - Math.PI / 2, cx - r, from.y, arc.outcome);
  }

  // Spanning: a smooth coral curve from the gate's lower-left up the margin to the
  // head node's left.
  const xL = Math.min(from.x - d, to.x - to.r) - ARC_BULGE;
  const sx = from.x - 0.55 * d;
  const sy = from.y + 0.45 * d;
  const tipX = to.x - to.r - 2;
  const tipY = to.y;
  const stroke = strokePath(
    `M ${round(sx)} ${round(sy)} C ${round(xL)} ${round(from.y)} ${round(xL)} ${round(to.y)} ${round(tipX)} ${round(tipY)}`,
    ACCENT,
    { width: ARC_W },
  );
  return arcGroup(stroke, tipX, tipY, 0, from.x - d - ARC_BULGE, from.y, arc.outcome);
}

/** The arc stroke element + arrowhead + the quiet outcome label set just left of it. */
function arcGroup(
  strokeEl: string,
  tipX: number,
  tipY: number,
  tipAngle: number,
  labelRightX: number,
  labelY: number,
  outcome: string,
): string {
  const parts = [
    strokeEl,
    arrowHead(tipX, tipY, tipAngle, ACCENT),
    knockoutText(labelRightX - 4, labelY + 3.5, outcome, {
      size: MEMBER_FONT,
      style: "italic",
      fill: MUTED,
      anchor: "end",
    }),
  ];
  return `<g class="control-arc">${parts.join("")}</g>`;
}
