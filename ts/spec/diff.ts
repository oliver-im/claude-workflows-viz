import type { Capture, Segment } from "./capture.js";

/**
 * What changed between two captures, as a reader wants it: placeholder renames
 * set aside, and every real change shown word by word inside its sentence.
 *
 * The minifier renames the runtime values (`${PP}` → `${tN}`) on most releases,
 * which moves the hash while the wording stands still. So both texts are compared
 * with every value's name collapsed out; the names are then read back off the
 * aligned tokens, and they count as a mere rename only when they form a
 * consistent one-to-one mapping that reuses no old name for a different value.
 * The comparison runs line by line first (the prose is one paragraph per line),
 * then word by word inside each changed run of lines.
 */

export type TokenKind = "word" | "space" | "break" | "value" | "expression" | "open" | "close";

/** One token of a capture's prose: a word with its trailing spaces, a lone whitespace run, a runtime value, … */
export interface Token {
  kind: TokenKind;
  /**
   * The word-level comparison key, tagged with the token's kind so that literal
   * text can never equal an interpolation. A runtime value's minifier name is
   * collapsed out of it, and so is spacing — a word compares equal however much
   * space follows it — so a sentence that only moved a space reads as unchanged.
   */
  key: string;
  /** Like `key`, but keeping the exact spacing: the line-level key is built from it. */
  exact: string;
  /** What to display: the text itself, or the value's real `${name}`. */
  shown: string;
  /** On runtime values and conditional markers: the minifier name, for rename detection. */
  name?: string;
}

const LINE_BREAK: Token = { kind: "break", key: "b", exact: "b", shown: "\n" };

/** Split a capture's segments into lines of tokens. */
export function tokenLines(segments: readonly Segment[]): Token[][] {
  const lines: Token[][] = [[]];
  const line = () => lines[lines.length - 1];
  const pushText = (text: string) => {
    text.split("\n").forEach((part, i) => {
      if (i > 0) lines.push([]);
      for (const m of part.matchAll(/\S+\s*|\s+/g)) {
        const word = m[0].trimEnd();
        line().push(
          word
            ? { kind: "word", key: `w:${word}`, exact: `w:${m[0]}`, shown: m[0] }
            : { kind: "space", key: "s", exact: `s:${m[0]}`, shown: m[0] },
        );
      }
    });
  };
  for (const s of segments) {
    switch (s.kind) {
      case "text":
        pushText(s.text);
        break;
      case "value":
        line().push({ kind: "value", key: "v", exact: "v", shown: `\${${s.name}}`, name: s.name });
        break;
      case "conditional": {
        const bang = s.when === "falsy" ? "!" : "";
        line().push({ kind: "open", key: `o:${bang}`, exact: `o:${bang}`, shown: `«if ${bang}${s.test}»`, name: s.test });
        pushText(s.text);
        line().push({ kind: "close", key: "c", exact: "c", shown: "«/if»" });
        break;
      }
      case "expression":
        line().push({ kind: "expression", key: `x:${s.source}`, exact: `x:${s.source}`, shown: `\${${s.source}}` });
        break;
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Myers' O(ND) difference algorithm
// ---------------------------------------------------------------------------

export interface Edit {
  op: "=" | "-" | "+";
  /** Index into `a` (for `=` and `-`; for `+`, the position it is inserted at). */
  a: number;
  /** Index into `b` (for `=` and `+`; for `-`, the position it is removed at). */
  b: number;
}

/**
 * The shortest edit script from `a` to `b` (Myers 1986). The trace keeps only the
 * band of the frontier each step can read, so memory grows with D², not N·D.
 */
export function diffSequence<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): Edit[] {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  search: for (let d = 0; d <= n + m; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break search;
    }
  }

  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const band = trace[d];
    const at = (k: number) => band[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ op: "=", a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) edits.push({ op: "+", a: x, b: y - 1 });
      else edits.push({ op: "-", a: x - 1, b: y });
    }
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

// ---------------------------------------------------------------------------
// Capture-to-capture comparison
// ---------------------------------------------------------------------------

/** A run of text in an excerpt: unchanged, removed, or added. */
export interface Piece {
  op: "=" | "-" | "+";
  text: string;
}

/** One changed passage, with a little unchanged context on each side. */
export interface Excerpt {
  /** 1-based line of the newer capture's prose artifact where the passage starts. */
  line: number;
  /** Context was cut at this end, so the reader sees an ellipsis there. */
  clippedStart: boolean;
  clippedEnd: boolean;
  pieces: Piece[];
}

export interface CaptureDiff {
  /** Minifier renames, in order of first appearance (`[old, new]`). */
  renames: Array<[string, string]>;
  /**
   * Name changes that cannot be a minifier's renaming — one name split in two,
   * two merged, an old name reused for a different value, a rename to a global —
   * each explained in a sentence. Any entry means a runtime value moved.
   */
  nameProblems: string[];
  /** Changed passages — empty when only names moved. */
  excerpts: Excerpt[];
  /** Lines (1-based, newer capture) where only spacing changed, which no excerpt shows. */
  spacingOnly: number[];
  wordsAdded: number;
  wordsRemoved: number;
  schemaChanged: boolean;
  /** Line diff of the input schema, two lines of context (only when it changed). */
  schemaLines: Piece[];
}

/** Unchanged words kept on each side of a change. */
const CONTEXT_WORDS = 10;
/** Changes separated by at most this many unchanged words share an excerpt. */
const MERGE_GAP_WORDS = 2 * CONTEXT_WORDS;
/** Global values a minifier never names a module variable after. */
const GLOBAL_NAMES = new Set(["undefined", "NaN", "Infinity", "globalThis"]);

const isWord = (t: Token) => t.kind !== "space" && t.kind !== "break";

/** Compare two captures (only their prose segments and input schema are read). */
export function diffCaptures(
  older: Pick<Capture, "segments" | "schema">,
  newer: Pick<Capture, "segments" | "schema">,
): CaptureDiff {
  const oldLines = tokenLines(older.segments);
  const newLines = tokenLines(newer.segments);
  const lineKey = (l: Token[]) => JSON.stringify(l.map((t) => t.exact));
  const lineEdits = diffSequence(oldLines.map(lineKey), newLines.map(lineKey), (p, q) => p === q);

  // Every aligned pair of names, same-name pairs included, so the mapping can be checked whole.
  const pairs: Array<[string, string]> = [];
  const pair = (o: Token, n: Token) => {
    if (o.name !== undefined && n.name !== undefined) pairs.push([o.name, n.name]);
  };

  const excerpts: Excerpt[] = [];
  const spacingOnly: number[] = [];
  let wordsAdded = 0;
  let wordsRemoved = 0;
  for (let i = 0; i < lineEdits.length; ) {
    const first = lineEdits[i];
    if (first.op === "=") {
      oldLines[first.a].forEach((t, j) => pair(t, newLines[first.b][j]));
      i++;
      continue;
    }
    // A run of changed lines: compare its tokens word by word.
    let j = i;
    while (j < lineEdits.length && lineEdits[j].op !== "=") j++;
    const run = lineEdits.slice(i, j);
    const join = (lines: Token[][], idx: number[]) =>
      idx.flatMap((li, n) => (n === 0 ? lines[li] : [LINE_BREAK, ...lines[li]]));
    const a = join(oldLines, run.filter((r) => r.op === "-").map((r) => r.a));
    const b = join(newLines, run.filter((r) => r.op === "+").map((r) => r.b));
    const edits = diffSequence(a, b, (p, q) => p.key === q.key);
    for (const ed of edits) {
      if (ed.op === "=") pair(a[ed.a], b[ed.b]);
      else if (ed.op === "+" && isWord(b[ed.b])) wordsAdded++;
      else if (ed.op === "-" && isWord(a[ed.a])) wordsRemoved++;
    }
    const found = excerptsOf(edits, a, b, first.b + 1);
    if (found.length === 0) spacingOnly.push(Math.min(first.b + 1, newLines.length));
    excerpts.push(...found);
    i = j;
  }

  const oldNames = new Set(oldLines.flat().flatMap((t) => (t.name === undefined ? [] : [t.name])));
  const schemaChanged = older.schema !== newer.schema;
  return {
    ...checkNames(pairs, oldNames),
    excerpts,
    spacingOnly,
    wordsAdded,
    wordsRemoved,
    schemaChanged,
    schemaLines: schemaChanged ? lineDiff(older.schema, newer.schema) : [],
  };
}

/**
 * Read the renames off the aligned name pairs, and say why when they cannot be
 * a minifier's renaming. A minifier renames a value consistently and one-to-one;
 * so a name that maps to two names (or two names onto one), an old name that now
 * stands for a different value, or a "rename" to a global like `undefined` means
 * a runtime value moved — something the collapsed text alone cannot see.
 */
function checkNames(
  pairs: Array<[string, string]>,
  oldNames: ReadonlySet<string>,
): Pick<CaptureDiff, "renames" | "nameProblems"> {
  const forward = new Map<string, Set<string>>();
  const backward = new Map<string, Set<string>>();
  for (const [o, n] of pairs) {
    if (!forward.has(o)) forward.set(o, new Set());
    forward.get(o)!.add(n);
    if (!backward.has(n)) backward.set(n, new Set());
    backward.get(n)!.add(o);
  }
  const show = (names: Iterable<string>) => [...names].map((x) => `\`\${${x}}\``).join(" and ");
  const nameProblems: string[] = [];
  for (const [o, ns] of forward) if (ns.size > 1) nameProblems.push(`\`\${${o}}\` became both ${show(ns)}.`);
  for (const [n, os] of backward) if (os.size > 1) nameProblems.push(`${show(os)} both became \`\${${n}}\`.`);
  const renames: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [o, n] of pairs) {
    const id = JSON.stringify([o, n]);
    if (o === n || seen.has(id)) continue;
    seen.add(id);
    renames.push([o, n]);
    if (oldNames.has(n)) nameProblems.push(`\`\${${o}}\` became \`\${${n}}\`, a name that stood for a different value before.`);
    if (GLOBAL_NAMES.has(n) || GLOBAL_NAMES.has(o)) nameProblems.push(`\`\${${o}}\` became \`\${${n}}\`; a global is not a minifier's name.`);
  }
  return { renames, nameProblems };
}

/** Cut one run's word edits into excerpts: nearby changes merge, distant ones split. */
function excerptsOf(edits: Edit[], a: Token[], b: Token[], firstLine: number): Excerpt[] {
  const tok = (ed: Edit) => (ed.op === "-" ? a[ed.a] : b[ed.b]);
  const groups: Array<[number, number]> = [];
  let gap = Infinity;
  edits.forEach((ed, idx) => {
    if (ed.op === "=") {
      if (isWord(tok(ed))) gap++;
      return;
    }
    if (groups.length > 0 && gap <= MERGE_GAP_WORDS) groups[groups.length - 1][1] = idx;
    else groups.push([idx, idx]);
    gap = 0;
  });

  return groups.map(([start, end]) => {
    const from = contextEdge(edits, tok, start, -1);
    const to = contextEdge(edits, tok, end, +1);
    const lineBreaksBefore = edits.slice(0, from).filter((ed) => ed.op !== "-" && b[ed.b] === LINE_BREAK).length;
    // An excerpt that reaches its line's edge — past indentation alone — shows no ellipsis there.
    const continues = (i: number, dir: -1 | 1) => {
      for (let k = i; k >= 0 && k < edits.length; k += dir) {
        const t = tok(edits[k]);
        if (t.kind === "break") return false;
        if (t.kind !== "space") return true;
      }
      return false;
    };
    return {
      line: firstLine + lineBreaksBefore,
      clippedStart: continues(from - 1, -1),
      clippedEnd: continues(to + 1, 1),
      pieces: trimEdges(piecesOf(edits.slice(from, to + 1), tok)),
    };
  });
}

/** Drop the whitespace and line breaks an excerpt would otherwise open or close on. */
function trimEdges(pieces: Piece[]): Piece[] {
  const out = pieces.map((p) => ({ ...p }));
  const first = out[0];
  if (first?.op === "=") first.text = first.text.trimStart();
  const last = out[out.length - 1];
  if (last?.op === "=") last.text = last.text.trimEnd();
  return out.filter((p) => p.text !== "");
}

/** The furthest unchanged edit within CONTEXT_WORDS of `at`, never stopping on bare whitespace or a line break. */
function contextEdge(edits: Edit[], tok: (ed: Edit) => Token, at: number, dir: -1 | 1): number {
  let edge = at;
  let words = 0;
  for (let i = at + dir; i >= 0 && i < edits.length && edits[i].op === "="; i += dir) {
    const t = tok(edits[i]);
    if (t === LINE_BREAK) break;
    if (isWord(t)) {
      if (words === CONTEXT_WORDS) break;
      words++;
      edge = i;
    }
  }
  return edge;
}

/**
 * Merge an excerpt's edits into pieces. Within one change, everything removed is
 * shown before everything added, and whitespace kept between two edits of the
 * same change is folded into both sides — so a replaced phrase reads as one
 * removal and one addition, not as alternating word swaps around kept spaces.
 */
function piecesOf(edits: Edit[], tok: (ed: Edit) => Token): Piece[] {
  const pieces: Piece[] = [];
  const keep = (text: string) => {
    const last = pieces[pieces.length - 1];
    if (last?.op === "=") last.text += text;
    else pieces.push({ op: "=", text });
  };
  for (let i = 0; i < edits.length; ) {
    if (edits[i].op === "=") {
      keep(tok(edits[i]).shown);
      i++;
      continue;
    }
    let removed = "";
    let added = "";
    let j = i;
    while (j < edits.length) {
      const ed = edits[j];
      if (ed.op !== "=") {
        if (ed.op === "-") removed += tok(ed).shown;
        else added += tok(ed).shown;
        j++;
        continue;
      }
      // Kept whitespace counts as part of the change only when more of it follows.
      let k = j;
      while (k < edits.length && edits[k].op === "=" && !isWord(tok(edits[k]))) k++;
      if (k === j || k === edits.length || edits[k].op === "=") break;
      const between = edits
        .slice(j, k)
        .map((ed2) => tok(ed2).shown)
        .join("");
      if (removed) removed += between;
      if (added) added += between;
      j = k;
    }
    // Trailing spaces both sides share read better outside the marks, as kept text.
    const tail = /\s*$/.exec(added || removed)![0];
    const cut = (s: string) => s.slice(0, s.length - tail.length);
    const shared =
      tail !== "" &&
      (!removed || removed.endsWith(tail)) &&
      (!added || added.endsWith(tail)) &&
      /\S/.test(cut(removed) + cut(added));
    if (shared) {
      removed = removed && cut(removed);
      added = added && cut(added);
    }
    if (removed) pieces.push({ op: "-", text: removed });
    if (added) pieces.push({ op: "+", text: added });
    if (shared) keep(tail);
    i = j;
  }
  return pieces;
}

/** A plain line diff with two lines of context, for the (rarely changing) schema. */
function lineDiff(older: string, newer: string): Piece[] {
  const a = older.split("\n");
  const b = newer.split("\n");
  const edits = diffSequence(a, b, (p, q) => p === q);
  const near = new Set<number>();
  edits.forEach((ed, i) => {
    if (ed.op !== "=") for (let k = i - 2; k <= i + 2; k++) near.add(k);
  });
  return edits.flatMap((ed, i) => (near.has(i) ? [{ op: ed.op, text: ed.op === "-" ? a[ed.a] : b[ed.b] }] : []));
}
