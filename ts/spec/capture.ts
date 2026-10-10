import * as acorn from "acorn";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The upstream grammar captures under `spec/upstream/`, parsed for reading.
 *
 * A capture's `workflow-tool-description.txt` is the raw *source* of the template
 * literals Claude Code composes into the Workflow tool description: escapes
 * unresolved (`\u2014`, `` \` ``) and every `${…}` interpolation verbatim. That
 * byte-exact form is what the grammar gate hashes, and it stays the authority.
 * This module reads it the way the binary does — acorn parses the whole file as
 * the one template literal it is, so nothing is evaluated — and hands back what a
 * reader needs instead: the decoded text, the values the binary fills in at
 * runtime, and the sentences it shows only under a runtime condition.
 */

export const PROSE_FILE = "workflow-tool-description.txt";
export const SCHEMA_FILE = "workflow-input-schema.d.ts";

/** One run of a capture's prose, in source order. */
export type Segment =
  /** Literal text, with the template's escapes decoded (the characters Claude sees). */
  | { kind: "text"; text: string }
  /** `${name}` — a value the binary inserts at runtime; the name is minifier output. */
  | { kind: "value"; name: string }
  /** `${test?"":"…"}` (or the mirror image) — text shown only while `test` is falsy (or truthy). */
  | { kind: "conditional"; test: string; when: "falsy" | "truthy"; text: string }
  /** Any other interpolation, kept as its verbatim source rather than guessed at. */
  | { kind: "expression"; source: string };

export interface ArtifactDigest {
  bytes: number;
  sha256: string;
}

export interface Capture {
  /** The snapshot directory name, `<YYYY-MM-DD>-cc-<version>`. */
  id: string;
  ccVersion: string;
  /** The capture date from the directory name (`YYYY-MM-DD`). */
  capturedOn: string;
  /** The raw prose artifact, byte for byte. */
  prose: string;
  /** The raw input-schema artifact, byte for byte. */
  schema: string;
  /** Per-artifact bytes and sha256, from `manifest.json`. */
  digests: Record<string, ArtifactDigest>;
  segments: Segment[];
}

const CAPTURE_DIR = /^(\d{4}-\d{2}-\d{2})-cc-(.+)$/;

/**
 * Every capture under `upstreamDir`, oldest first. Numeric collation orders the
 * ISO date prefix chronologically and the version suffix by value (cc-2.1.9
 * before cc-2.1.100) — the same order `scripts/capture-grammar.mjs` uses to find
 * the latest baseline.
 */
export function listCaptures(upstreamDir: string): Capture[] {
  if (!existsSync(upstreamDir)) return [];
  return readdirSync(upstreamDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && CAPTURE_DIR.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((id) => readCapture(join(upstreamDir, id), id));
}

function readCapture(dir: string, id: string): Capture {
  const [, capturedOn, ccVersion] = CAPTURE_DIR.exec(id)!;
  const prose = readFileSync(join(dir, PROSE_FILE), "utf8");
  const schema = readFileSync(join(dir, SCHEMA_FILE), "utf8");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  return {
    id,
    ccVersion,
    capturedOn,
    prose,
    schema,
    digests: manifest.artifacts ?? {},
    segments: parseProse(prose),
  };
}

/**
 * Parse a raw prose artifact into segments. The artifact is template-literal
 * source (since cc-2.1.267 two literals joined by a blank line, which is still
 * valid literal content), so wrapping it in backticks yields exactly one
 * template literal; anything else means the capture is not what this reader
 * assumes, and it throws rather than render a misreading.
 */
export function parseProse(raw: string): Segment[] {
  const source = `\`${raw}\``;
  const node = acorn.parseExpressionAt(source, 0, { ecmaVersion: "latest" }) as acorn.Node & {
    type: string;
    quasis?: Array<{ value: { cooked: string | null } }>;
    expressions?: acorn.Expression[];
  };
  if (node.type !== "TemplateLiteral" || node.end !== source.length) {
    throw new Error("capture prose is not a single template literal");
  }
  const segments: Segment[] = [];
  node.quasis!.forEach((quasi, i) => {
    const cooked = quasi.value.cooked;
    if (cooked === null) throw new Error("capture prose holds an invalid escape sequence");
    if (cooked) segments.push({ kind: "text", text: cooked });
    const expr = node.expressions![i];
    if (expr) segments.push(interpolation(expr, source));
  });
  return segments;
}

function interpolation(expr: acorn.Expression, source: string): Segment {
  if (expr.type === "Identifier") return { kind: "value", name: expr.name };
  if (expr.type === "ConditionalExpression" && expr.test.type === "Identifier") {
    const yes = stringLiteral(expr.consequent);
    const no = stringLiteral(expr.alternate);
    if (yes === "" && no !== undefined) {
      return { kind: "conditional", test: expr.test.name, when: "falsy", text: no };
    }
    if (no === "" && yes !== undefined) {
      return { kind: "conditional", test: expr.test.name, when: "truthy", text: yes };
    }
  }
  return { kind: "expression", source: source.slice(expr.start, expr.end) };
}

function stringLiteral(node: acorn.Expression): string | undefined {
  return node.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

/**
 * The capture's prose as one plain string, for matching quotes against: decoded
 * text, every runtime value as `${…}` (its minifier name changes between
 * releases, so a quote must not depend on it), and conditional text inline as
 * the common reading shows it. Whitespace is collapsed.
 */
export function quotableText(segments: readonly Segment[]): string {
  return segments
    .map((s) => {
      switch (s.kind) {
        case "text":
          return s.text;
        case "value":
          return "${…}";
        case "conditional":
          return s.text;
        case "expression":
          return `\${${s.source}}`;
      }
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compare two dotted Claude Code versions numerically (`2.1.9` < `2.1.100`). */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
