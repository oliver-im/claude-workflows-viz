import { MONO_ADVANCE, SANS_BOLD, SANS_ITALIC, SANS_REGULAR } from "./text-metrics-data.js";

/**
 * Measured text for the workflow and topology views. Every wrap, truncation,
 * card width, and content bound is computed from real advance widths, not a
 * per-character guess, so text fills the room it is given and never overflows it.
 *
 * The font stacks are chosen to make that measurement hold in practice: the sans
 * stack names Helvetica, Arial, and Liberation Sans — three faces with the same
 * advance widths — so macOS, Windows, and Linux viewers all draw the widths
 * measured here; the mono stack's faces are all ~0.6 em per glyph. The tables come
 * from `scripts/gen-text-metrics.mjs`.
 *
 * (The meta-only phases view keeps its original 0.58 em heuristic in
 * `svg-primitives.ts` — it is the byte-identical v1 gate, so it is left alone.)
 */

export const SANS_STACK = "Helvetica, Arial, 'Liberation Sans', sans-serif";
export const MONO_STACK = "Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

export interface FontSpec {
  size: number;
  weight?: number;
  italic?: boolean;
  mono?: boolean;
}

/** East Asian wide ranges and emoji — drawn about one em wide by any fallback face. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}]/u;
const COMBINING = /[̀-ͯ]/;
/** A glyph the table lacks: wider than the average letter, so a guess never under-fits. */
const FALLBACK_UNITS = 600;

function glyphUnits(c: string, table: Readonly<Record<string, number>>): number {
  const known = table[c];
  if (known !== undefined) return known;
  if (COMBINING.test(c)) return 0;
  if (WIDE.test(c)) return 1000;
  const base = c.normalize("NFD")[0];
  if (base !== undefined && base !== c && table[base] !== undefined) return table[base];
  return FALLBACK_UNITS;
}

/** Drawn width of `s` in px. */
export function textWidth(s: string, f: FontSpec): number {
  let units = 0;
  if (f.mono) {
    for (const c of s) units += COMBINING.test(c) ? 0 : WIDE.test(c) ? 2 * MONO_ADVANCE : MONO_ADVANCE;
  } else {
    const table = (f.weight ?? 400) >= 600 ? SANS_BOLD : f.italic ? SANS_ITALIC : SANS_REGULAR;
    for (const c of s) units += glyphUnits(c, table);
  }
  return (units * f.size) / 1000;
}

/** `s` cut to fit `width`, ending in "…" when anything was dropped. */
export function fitText(s: string, width: number, f: FontSpec): string {
  if (textWidth(s, f) <= width) return s;
  const chars = Array.from(s);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${chars.slice(0, mid).join("").trimEnd()}…`, f) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join("").trimEnd()}…`;
}

/** Characters a long code token may break after (`review:correctness` → `review:` / `correctness`). */
const SOFT_BREAK = /[:/\-_.,]/;

/**
 * Split one token wider than `width` into pieces that fit: prefer breaking just
 * after a soft-break character, else hard-break between characters.
 */
function breakToken(token: string, width: number, f: FontSpec): string[] {
  const out: string[] = [];
  let rest = Array.from(token);
  while (rest.length > 0 && textWidth(rest.join(""), f) > width) {
    let fit = 0;
    while (fit < rest.length && textWidth(rest.slice(0, fit + 1).join(""), f) <= width) fit++;
    fit = Math.max(1, fit);
    let cut = fit;
    for (let i = fit; i > 0; i--) {
      if (SOFT_BREAK.test(rest[i - 1])) {
        cut = i;
        break;
      }
    }
    out.push(rest.slice(0, cut).join(""));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest.join(""));
  return out;
}

/**
 * Greedy word wrap into lines no wider than `width`. A token too wide for any
 * line is broken (soft break first), never dropped. Only `maxLines` can clip: the
 * last allowed line then carries the remainder, truncated with "…" — so callers
 * that must not lose text pass no cap, or carry the full string in a `<title>`.
 */
export function wrapText(s: string, width: number, f: FontSpec, maxLines = Number.POSITIVE_INFINITY): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  const push = (line: string): boolean => {
    lines.push(line);
    return lines.length >= maxLines;
  };
  for (let i = 0; i < words.length; i++) {
    const cand = cur ? `${cur} ${words[i]}` : words[i];
    if (textWidth(cand, f) <= width) {
      cur = cand;
      continue;
    }
    if (cur) {
      if (lines.length === maxLines - 1) return [...lines, fitText(`${cur} ${words.slice(i).join(" ")}`, width, f)];
      if (push(cur)) return lines;
      cur = "";
    }
    const pieces = textWidth(words[i], f) <= width ? [words[i]] : breakToken(words[i], width, f);
    for (let k = 0; k < pieces.length - 1; k++) {
      if (lines.length === maxLines - 1) {
        return [...lines, fitText([pieces.slice(k).join(""), ...words.slice(i + 1)].join(" "), width, f)];
      }
      if (push(pieces[k])) return lines;
    }
    cur = pieces[pieces.length - 1];
  }
  if (cur) lines.push(cur);
  return lines;
}
