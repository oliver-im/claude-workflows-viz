/**
 * Shared SVG building blocks: text/shape emitters, text fitting, the model
 * color swatches, and the page geometry constants — extracted verbatim from
 * `render-svg.ts` so the phase-card renderer (v1) and the topology renderer
 * (v2) draw from one toolbox. Also home to the generic path helpers
 * (stroked paths, rounded elbows, arrowheads) the topology renderer routes
 * edges and loop arcs with.
 *
 * Styling note: ALL paint and geometry constants live here or in the
 * renderer-specific constant blocks — never inlined at point of use — so a
 * restyle is a constant swap, not logic surgery.
 */

// ---------------------------------------------------------------------------
// Page geometry
// ---------------------------------------------------------------------------

export const W = 760;
export const MARGIN = 24;
export const GAP = 16;

export interface Block {
  body: string;
  height: number;
}

// ---------------------------------------------------------------------------
// Model → color, adapted from planview's mermaid classDefs. Matched by
// substring so a full model id (e.g. "claude-opus-4-8") still resolves; an
// unrecognized model falls back to a neutral slate swatch.
// ---------------------------------------------------------------------------

export interface Swatch {
  fill: string;
  stroke: string;
  text: string;
}

export const MODEL_SWATCHES: ReadonlyArray<readonly [string, Swatch]> = [
  ["opus", { fill: "#ede9fe", stroke: "#8b5cf6", text: "#3b0764" }],
  ["sonnet", { fill: "#dcfce7", stroke: "#22c55e", text: "#14532d" }],
  ["haiku", { fill: "#dbeafe", stroke: "#3b82f6", text: "#1e3a5f" }],
];
export const MODEL_FALLBACK: Swatch = {
  fill: "#f1f5f9",
  stroke: "#94a3b8",
  text: "#334155",
};

export function swatchFor(model: string): Swatch {
  const m = model.toLowerCase();
  for (const [key, swatch] of MODEL_SWATCHES) {
    if (m.includes(key)) return swatch;
  }
  return MODEL_FALLBACK;
}

// ---------------------------------------------------------------------------
// SVG primitives + text fitting
// ---------------------------------------------------------------------------

export interface TextOpts {
  size: number;
  fill: string;
  weight?: number;
  style?: string;
  anchor?: string;
}

export function text(x: number, y: number, content: string, o: TextOpts): string {
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

export function roundRect(
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

export function round(n: number): number {
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
export function fitChars(width: number, size: number): number {
  return Math.max(1, Math.floor(width / (size * 0.58)));
}

export function truncatePlain(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

export function truncateToWidth(s: string, width: number, size: number): string {
  return truncatePlain(s, fitChars(width, size));
}

export function wrapToWidth(
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

// ---------------------------------------------------------------------------
// Path helpers (topology edges, loop arcs, arrowheads). Everything emits the
// resvg-safe SVG 1.1 subset: plain paths/polygons, arrowheads as explicit
// filled triangles — no <marker>.
// ---------------------------------------------------------------------------

export interface StrokeOpts {
  width?: number;
  fill?: string;
  dasharray?: string;
  linecap?: string;
}

export function strokePath(d: string, stroke: string, o: StrokeOpts = {}): string {
  const attrs = [
    `d="${d}"`,
    `fill="${o.fill ?? "none"}"`,
    `stroke="${stroke}"`,
    `stroke-width="${o.width ?? 1}"`,
  ];
  if (o.dasharray) attrs.push(`stroke-dasharray="${o.dasharray}"`);
  if (o.linecap) attrs.push(`stroke-linecap="${o.linecap}"`);
  return `<path ${attrs.join(" ")}/>`;
}

export type Point = readonly [number, number];

/**
 * A polyline whose every segment is axis-aligned (horizontal or vertical),
 * drawn with quarter-arc corners of radius `r` — the loop-arc/gutter routing
 * shape. The radius is clamped per corner to half of each adjacent segment so
 * short runs degrade to tighter corners instead of overshooting. Non-axis-
 * aligned input is a programming error; the helper falls back to sharp
 * corners for such a pair rather than emitting a wrong arc.
 */
export function roundedElbowPath(
  pts: readonly Point[],
  r: number,
  stroke: string,
  width?: number,
  dasharray?: string,
): string {
  if (pts.length < 2) return "";
  const d: string[] = [`M ${round(pts[0][0])} ${round(pts[0][1])}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const inDx = Math.sign(cx - px);
    const inDy = Math.sign(cy - py);
    const outDx = Math.sign(nx - cx);
    const outDy = Math.sign(ny - cy);
    const axisAligned =
      (inDx === 0) !== (inDy === 0) && (outDx === 0) !== (outDy === 0);
    const isTurn = axisAligned && (inDx === 0) !== (outDx === 0);
    if (!isTurn) {
      // Straight-through or degenerate vertex: no arc to draw.
      d.push(`L ${round(cx)} ${round(cy)}`);
      continue;
    }
    const inLen = Math.abs(cx - px) + Math.abs(cy - py);
    const outLen = Math.abs(nx - cx) + Math.abs(ny - cy);
    const cr = Math.min(r, inLen / 2, outLen / 2);
    const ax = cx - inDx * cr;
    const ay = cy - inDy * cr;
    const bx = cx + outDx * cr;
    const by = cy + outDy * cr;
    // Sweep = 1 for a clockwise turn (in screen coords, y-down): the cross
    // product of the incoming and outgoing directions decides.
    const sweep = inDx * outDy - inDy * outDx > 0 ? 1 : 0;
    d.push(`L ${round(ax)} ${round(ay)}`);
    d.push(`A ${round(cr)} ${round(cr)} 0 0 ${sweep} ${round(bx)} ${round(by)}`);
  }
  const [lx, ly] = pts[pts.length - 1];
  d.push(`L ${round(lx)} ${round(ly)}`);
  return strokePath(d.join(" "), stroke, { width, dasharray });
}

const ARROW_LEN = 7;
const ARROW_HALF_W = 3.5;

/**
 * A filled triangular arrowhead with its tip at (tipX, tipY), pointing in the
 * direction of `angle` (radians, screen coords — 0 points right, π/2 down).
 */
export function arrowHead(tipX: number, tipY: number, angle: number, fill: string): string {
  const bx = tipX - ARROW_LEN * Math.cos(angle);
  const by = tipY - ARROW_LEN * Math.sin(angle);
  const px = -Math.sin(angle) * ARROW_HALF_W;
  const py = Math.cos(angle) * ARROW_HALF_W;
  const points = [
    `${round(tipX)},${round(tipY)}`,
    `${round(bx + px)},${round(by + py)}`,
    `${round(bx - px)},${round(by - py)}`,
  ].join(" ");
  return `<polygon points="${points}" fill="${fill}"/>`;
}
