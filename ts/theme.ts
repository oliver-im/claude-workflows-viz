/**
 * Design tokens for the workflow and topology views. Every color the renderer
 * paints comes from a `Theme`, so a restyle — or a new theme — is a token edit,
 * never logic surgery. (The meta-only phases view keeps its own fixed palette:
 * it is the byte-identical v1 gate.)
 *
 * The palette follows one rule: ink follows meaning.
 *   - Model colors are the only strong color on agents, so the cost profile of a
 *     workflow reads at a glance.
 *   - Structure (edges, joins) stays neutral, so plumbing never outweighs work.
 *   - The accent marks control flow only — branches, loop frames, continue/break —
 *     the parts that make a workflow dynamic.
 * Text tokens meet WCAG AA (4.5:1) against the card they sit on.
 */

export type ThemeName = "light" | "dark";
export const THEME_NAMES: readonly ThemeName[] = ["light", "dark"];

export interface Swatch {
  fill: string;
  stroke: string;
  text: string;
}

export interface Theme {
  name: ThemeName;
  page: string;
  card: string;
  border: string;
  /** Titles. */
  ink: string;
  /** Prose: descriptions and phase details. */
  body: string;
  /** Secondary text — the floor for anything information-bearing. */
  muted: string;
  edge: string;
  join: string;
  chip: string;
  chipText: string;
  statFill: string;
  statText: string;
  /** Control-flow strokes: decision diamonds, loop frames, continue/break arcs. */
  accent: string;
  /** Control-flow text: conditions and loop headers. */
  accentInk: string;
  accentWash: string;
  accentWashOpacity: number;
  /** Known model families, matched by substring so full ids resolve. */
  models: ReadonlyArray<readonly [string, Swatch]>;
  /** An explicit model the palette doesn't know (e.g. a non-Claude id). */
  otherModel: Swatch;
  /** No `model` on the call: the agent inherits the session model. */
  session: Swatch;
}

export const LIGHT: Theme = {
  name: "light",
  page: "#f8fafc",
  card: "#ffffff",
  border: "#e2e8f0",
  ink: "#0f172a",
  body: "#475569",
  muted: "#64748b",
  edge: "#64748b",
  join: "#334155",
  chip: "#334155",
  chipText: "#ffffff",
  statFill: "#f1f5f9",
  statText: "#334155",
  accent: "#e8694a",
  accentInk: "#c2410c",
  accentWash: "#fff7ed",
  accentWashOpacity: 0.7,
  models: [
    ["opus", { fill: "#ede9fe", stroke: "#8b5cf6", text: "#4c1d95" }],
    ["sonnet", { fill: "#dcfce7", stroke: "#16a34a", text: "#14532d" }],
    ["haiku", { fill: "#dbeafe", stroke: "#3b82f6", text: "#1e3a8a" }],
    ["fable", { fill: "#fef3c7", stroke: "#d97706", text: "#78350f" }],
  ],
  otherModel: { fill: "#f1f5f9", stroke: "#64748b", text: "#334155" },
  session: { fill: "#ffffff", stroke: "#94a3b8", text: "#475569" },
};

export const DARK: Theme = {
  name: "dark",
  page: "#0d1117",
  card: "#161b22",
  border: "#30363d",
  ink: "#e6edf3",
  body: "#c9d1d9",
  muted: "#8b949e",
  edge: "#8b949e",
  join: "#c9d1d9",
  chip: "#c9d1d9",
  chipText: "#0d1117",
  statFill: "#21262d",
  statText: "#c9d1d9",
  accent: "#f0883e",
  accentInk: "#ffa657",
  accentWash: "#f0883e",
  accentWashOpacity: 0.08,
  models: [
    ["opus", { fill: "#271e4a", stroke: "#a371f7", text: "#d2a8ff" }],
    ["sonnet", { fill: "#0f2e1c", stroke: "#3fb950", text: "#aff5b4" }],
    ["haiku", { fill: "#11294a", stroke: "#58a6ff", text: "#a5d6ff" }],
    ["fable", { fill: "#33240a", stroke: "#d29922", text: "#f8e3a1" }],
  ],
  otherModel: { fill: "#21262d", stroke: "#8b949e", text: "#c9d1d9" },
  session: { fill: "#161b22", stroke: "#6e7681", text: "#8b949e" },
};

export function themeByName(name: ThemeName): Theme {
  return name === "dark" ? DARK : LIGHT;
}

/** The model families the palettes color, matched by substring. */
export const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/** The known model family a model id names ("claude-opus-5" → "opus"), if any. */
export function modelFamily(model: string): string | undefined {
  const m = model.toLowerCase();
  return MODEL_FAMILIES.find((key) => m.includes(key));
}

/** The swatch an agent card wears: its family's, another model's, or the session's. */
export function modelSwatch(theme: Theme, model: string | undefined): Swatch {
  if (model === undefined) return theme.session;
  const m = model.toLowerCase();
  for (const [key, swatch] of theme.models) if (m.includes(key)) return swatch;
  return theme.otherModel;
}
