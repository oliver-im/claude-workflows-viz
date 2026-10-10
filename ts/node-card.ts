import { type FontSpec, fitText, textWidth, wrapText } from "./text-metrics.js";

/**
 * The agent card: the one node shape for an `agent()` call. Placement sizes every
 * card from this module and the renderer draws it from the same spec, so the two
 * always agree on what fits.
 *
 *   ┌──────────────────────┐
 *   │ review:correctness   │  label — mono, verbatim from the source
 *   │ sonnet · medium ▮▮▯▯▯│  model · effort, with a five-step effort meter
 *   └──────────────────────┘
 *
 * The label line shows only an AUTHORED label (`opts.label`) in the workflow view —
 * a prompt-sliced one restates the phase row beside it — so an unlabeled agent is
 * a one-line card naming its model. The model line names the explicit model; else
 * the custom agent type (`codex agent`), which may pin its own; else "model
 * unread" when the analyzer could not read the options; else "session model" —
 * the call inherits. A `×N` card is a stack
 * of cards with a count badge, captioned with the expression the count comes from.
 */

export const CARD_PAD_X = 10;
export const CARD_MIN_W = 64;
export const CARD_MAX_W = 188;
/** One content line; each further line adds `CARD_LINE_STEP`. */
export const CARD_H1 = 26;
export const CARD_LINE_STEP = 14;
/** Baseline of the first content line, from the card top. */
export const CARD_BASELINE = 16.5;
export const CARD_RX = 7;
export const LABEL_FONT: FontSpec = { size: 11, mono: true };
export const META_FONT: FontSpec = { size: 10 };
export const CAPTION_FONT: FontSpec = { size: 10 };
export const CAPTION_CODE_FONT: FontSpec = { size: 10, mono: true };
export const CAPTION_PREFIX = "N from ";
/** Offset of each card drawn behind a `×N` stack, and how many there are. */
export const DECK_STEP = 3;
export const DECK_DEPTH = 2;
export const CAPTION_H = 15;
export const METER_SEGMENTS = 5;
export const METER_SEG_W = 4;
export const METER_SEG_GAP = 1.5;
export const METER_W = METER_SEGMENTS * METER_SEG_W + (METER_SEGMENTS - 1) * METER_SEG_GAP;
const METER_GAP = 8;
const MAX_LABEL_LINES = 2;

/** The documented effort tiers, lowest first — the meter's scale. */
export const EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface CardInput {
  /** The label to show, if any (authored, or derived where the view shows it). */
  label?: string;
  /** True when `label` was sliced from the prompt rather than authored. */
  derived?: boolean;
  /** Explicit `opts.model`, verbatim. */
  model?: string;
  /** Short display name for `model` (its family), when the palette knows it. */
  modelShort?: string;
  /** `opts.agentType` — names the card's model line when no `model` is set,
   *  since a custom agent type may pin its own model. */
  agentType?: string;
  effort?: string;
  /** Options that may be set but could not be read statically. */
  unread?: ReadonlyArray<"model" | "effort" | "agentType">;
  /** Multiplicity badge, e.g. "×N" or "×4". */
  mult?: string;
  /** Source expression an unknown count comes from (shown as "N from …"). */
  hint?: string;
}

export interface CardSpec {
  w: number;
  /** Height of the drawn card itself. */
  cardH: number;
  /** Layout height: the card plus its stack and caption, if any. */
  h: number;
  lines: string[];
  derived: boolean;
  meta?: string;
  /** Filled meter segments (1–5) when the effort is a documented tier. */
  meter?: number;
  mult?: string;
  /** The count's source expression, drawn mono after `CAPTION_PREFIX`. */
  caption?: string;
}

/** No literal model, and the model may still be set: an unread `model`, or an
 *  unread `agentType` (a custom agent type can pin one). */
export function modelHidden(a: { model?: string; agentType?: string; unread?: ReadonlyArray<string> }): boolean {
  if (a.model !== undefined) return false;
  const unread = a.unread ?? [];
  return unread.includes("model") || (a.agentType === undefined && unread.includes("agentType"));
}

function metaText(input: CardInput): string | undefined {
  const hidden = modelHidden(input);
  const model =
    input.model !== undefined
      ? (input.modelShort ?? input.model)
      : hidden
        ? "model unread"
        : input.agentType !== undefined
          ? `${input.agentType} agent`
          : "session model";
  const effort = input.effort ?? ((input.unread ?? []).includes("effort") ? "effort unread" : undefined);
  const showModel =
    input.model !== undefined || input.agentType !== undefined || hidden || input.label === undefined || effort !== undefined;
  if (!showModel) return undefined;
  return effort !== undefined ? `${model} · ${effort}` : model;
}

function meterLevel(effort: string | undefined): number | undefined {
  if (effort === undefined) return undefined;
  const i = (EFFORT_TIERS as readonly string[]).indexOf(effort);
  return i === -1 ? undefined : i + 1;
}

function captionWidth(code: string): number {
  return textWidth(CAPTION_PREFIX, CAPTION_FONT) + textWidth(code, CAPTION_CODE_FONT);
}

/** The caption under a `×N` stack may overhang the card by its padding, no more. */
function fitCaption(code: string, w: number): string {
  const room = w + 2 * CARD_PAD_X - textWidth(CAPTION_PREFIX, CAPTION_FONT);
  return fitText(code, room, CAPTION_CODE_FONT);
}

/** The width a card wants with its label on one line (capped at `CARD_MAX_W`). */
function naturalWidth(input: CardInput): number {
  const meta = metaText(input);
  const level = meterLevel(input.effort);
  const metaW = meta === undefined ? 0 : textWidth(meta, META_FONT) + (level !== undefined ? METER_GAP + METER_W : 0);
  const labelW = input.label === undefined ? 0 : textWidth(input.label, LABEL_FONT);
  const captionW = input.mult !== undefined && input.hint !== undefined ? captionWidth(input.hint) : 0;
  const want = Math.max(labelW, metaW, captionW - 2 * CARD_PAD_X) + 2 * CARD_PAD_X;
  return Math.ceil(Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, want)));
}

/** Lay out a card at exactly width `w`: wrap the label, fit the model line. */
export function cardAtWidth(input: CardInput, w: number): CardSpec {
  const inner = w - 2 * CARD_PAD_X;
  const lines = input.label === undefined ? [] : wrapText(input.label, inner, LABEL_FONT, MAX_LABEL_LINES);
  let meta = metaText(input);
  let meter = meterLevel(input.effort);
  if (meta !== undefined) {
    if (meter !== undefined && textWidth(meta, META_FONT) + METER_GAP + METER_W > inner) meter = undefined;
    meta = fitText(meta, inner, META_FONT);
  }
  const contentLines = lines.length + (meta !== undefined ? 1 : 0);
  const cardH = CARD_H1 + CARD_LINE_STEP * Math.max(0, contentLines - 1);
  const caption = input.mult !== undefined && input.hint !== undefined ? fitCaption(input.hint, w) : undefined;
  const h = cardH + (input.mult !== undefined ? DECK_STEP * DECK_DEPTH : 0) + (caption !== undefined ? CAPTION_H : 0);
  return {
    w,
    cardH,
    h,
    lines,
    derived: input.derived === true,
    ...(meta !== undefined ? { meta } : {}),
    ...(meter !== undefined ? { meter } : {}),
    ...(input.mult !== undefined ? { mult: input.mult } : {}),
    ...(caption !== undefined ? { caption } : {}),
  };
}

/** A card at its natural width, label wrapped onto a second line only past the cap. */
export function agentCard(input: CardInput): CardSpec {
  return cardAtWidth(input, naturalWidth(input));
}

/** Give every card in a row the same drawn height — the tallest one's — so the
 *  row reads as a row; the text stays top-aligned in each card. */
export function equalizeHeights(specs: CardSpec[]): CardSpec[] {
  const cardH = specs.reduce((m, s) => Math.max(m, s.cardH), 0);
  return specs.map((s) => ({ ...s, cardH, h: s.h - s.cardH + cardH }));
}

/**
 * One uniform width for a row of cards (fan-out members, pipeline columns) that
 * fits `n` across in `maxRowW`: the widest natural card when that fits, else the
 * widest that does — provided every label still wraps into two lines untruncated.
 * `undefined` means the row cannot be drawn honestly at any width, so the caller
 * collapses it to a single ×N card.
 */
export function rowCardWidth(inputs: CardInput[], n: number, maxRowW: number, gap: number): number | undefined {
  const natural = inputs.reduce((m, input) => Math.max(m, naturalWidth(input)), CARD_MIN_W);
  if (n * natural + (n - 1) * gap <= maxRowW) return natural;
  const fit = Math.floor((maxRowW - (n - 1) * gap) / n);
  if (fit < CARD_MIN_W) return undefined;
  const inner = fit - 2 * CARD_PAD_X;
  const ok = inputs.every((input) => {
    if (input.label !== undefined && wrapText(input.label, inner, LABEL_FONT).length > MAX_LABEL_LINES) return false;
    const meta = metaText(input);
    return meta === undefined || textWidth(meta, META_FONT) <= inner;
  });
  return ok ? fit : undefined;
}
