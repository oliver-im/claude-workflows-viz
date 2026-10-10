import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { levelAt } from "../grammar.js";
import { listCaptures, parseProse } from "./capture.js";
import { type CaptureDiff, diffCaptures, type Excerpt } from "./diff.js";
import { type CaptureRow, capturesTable, changesPage, readablePage } from "./markdown.js";

/**
 * The readable side of `spec/` — everything `npm run spec` writes, derived from
 * the raw captures in `spec/upstream/` and never edited by hand:
 *
 *   - `spec/upstream/<capture>/workflow-tool-description.md` — each capture's
 *     prose, decoded and laid out as Markdown, words unchanged;
 *   - `spec/upstream/<capture>/CHANGES.md` — what changed against the capture
 *     before it, runtime-value renames set aside, word by word;
 *   - `spec/workflow-tool-description.md` — the newest capture's page again, at a
 *     path that never moves, for linking;
 *   - the captures table inside `spec/README.md`, between its markers.
 *
 * `ts/__tests__/spec.test.ts` regenerates all of it and fails on any difference
 * from what is committed, the same way the example renders are held to the code.
 */

export const TABLE_START = "<!-- captures:start -->";
export const TABLE_END = "<!-- captures:end -->";

export interface SpecFile {
  /** Repo-relative path. */
  path: string;
  content: string;
}

/** Every generated file, computed in memory from the captures on disk. */
export function generateSpec(root: string): SpecFile[] {
  const captures = listCaptures(join(root, "spec", "upstream"));
  if (captures.length === 0) throw new Error("no captures under spec/upstream/ — run `npm run capture-grammar`");
  const files: SpecFile[] = [];
  const rows: CaptureRow[] = [];
  captures.forEach((capture, i) => {
    const prev = captures[i - 1];
    const level = levelAt(capture.ccVersion);
    const minted = prev !== undefined && levelAt(prev.ccVersion) !== level;
    const diff = prev ? diffCaptures(prev, capture) : null;
    const dir = `spec/upstream/${capture.id}`;
    files.push({
      path: `${dir}/workflow-tool-description.md`,
      content: readablePage(capture, { toSpec: "../../", toCapture: "" }, { newest: false, hasChanges: !!prev }),
    });
    if (prev && diff) {
      files.push({
        path: `${dir}/CHANGES.md`,
        content: changesPage(prev, capture, diff, { before: levelAt(prev.ccVersion), after: level, minted }),
      });
    }
    rows.push({ capture, level, minted, diff });
  });

  const newest = captures[captures.length - 1];
  files.push({
    path: "spec/workflow-tool-description.md",
    content: readablePage(
      newest,
      { toSpec: "", toCapture: `upstream/${newest.id}/` },
      { newest: true, hasChanges: captures.length > 1 },
    ),
  });

  const readme = join(root, "spec", "README.md");
  if (existsSync(readme)) {
    files.push({
      path: "spec/README.md",
      content: splice(readFileSync(readme, "utf8"), capturesTable([...rows].reverse())),
    });
  }
  return files;
}

/** Replace what sits between the captures-table markers. */
function splice(doc: string, table: string): string {
  const start = doc.indexOf(TABLE_START);
  const end = doc.indexOf(TABLE_END);
  if (start < 0 || end < start) {
    throw new Error(`spec/README.md is missing the ${TABLE_START} … ${TABLE_END} markers`);
  }
  return `${doc.slice(0, start + TABLE_START.length)}\n${table}\n${doc.slice(end)}`;
}

/** Write every generated file whose content changed; returns the paths written. */
export function writeSpec(root: string): string[] {
  const written: string[] = [];
  for (const file of generateSpec(root)) {
    const abs = join(root, file.path);
    if (existsSync(abs) && readFileSync(abs, "utf8") === file.content) continue;
    writeFileSync(abs, file.content);
    written.push(file.path);
  }
  return written;
}

/**
 * How a freshly captured prose artifact differs from a baseline — for the drift
 * check, which passes the first three kinds and fails the last two:
 *
 *   - `same` — byte-identical;
 *   - `encoding` — the decoded text is identical; only how the source spells it
 *     differs (an escape written out, a quote style, line endings);
 *   - `renames` — identical apart from runtime-value names that form a consistent
 *     one-to-one minifier renaming (listed);
 *   - `values` — names moved in a way no renaming explains, so a runtime value
 *     moved (each reason in `nameProblems`);
 *   - `wording` — the text changed, spacing included (shown as excerpts).
 */
export interface ProseDrift {
  kind: "same" | "encoding" | "renames" | "values" | "wording";
  renames: Array<[string, string]>;
  nameProblems: string[];
  excerpts: Excerpt[];
  /** Lines where only spacing changed. */
  spacingOnly: number[];
  wordsAdded: number;
  wordsRemoved: number;
}

/** Classify the drift between two raw prose artifacts (schemas are compared by the caller). */
export function classifyProseDrift(baselineRaw: string, currentRaw: string): ProseDrift {
  const empty = { renames: [], nameProblems: [], excerpts: [], spacingOnly: [], wordsAdded: 0, wordsRemoved: 0 };
  if (baselineRaw === currentRaw) return { kind: "same", ...empty };
  const d: CaptureDiff = diffCaptures(
    { segments: parseProse(baselineRaw), schema: "" },
    { segments: parseProse(currentRaw), schema: "" },
  );
  const kind =
    d.excerpts.length > 0 || d.spacingOnly.length > 0
      ? "wording"
      : d.nameProblems.length > 0
        ? "values"
        : d.renames.length > 0
          ? "renames"
          : "encoding";
  return {
    kind,
    renames: d.renames,
    nameProblems: d.nameProblems,
    excerpts: d.excerpts,
    spacingOnly: d.spacingOnly,
    wordsAdded: d.wordsAdded,
    wordsRemoved: d.wordsRemoved,
  };
}

/** An excerpt in the terminal's notation, `[-removed-]{+added+}` (git's word-diff style). */
export function plainExcerpt(ex: Excerpt): string {
  const body = ex.pieces
    .map((p) => (p.op === "=" ? p.text : p.op === "-" ? `[-${p.text}-]` : `{+${p.text}+}`))
    .join("")
    .replace(/\n/g, "↵ ");
  return `line ${ex.line}: ${ex.clippedStart ? "… " : ""}${body}${ex.clippedEnd ? " …" : ""}`;
}

export { generateSite } from "./site.js";
