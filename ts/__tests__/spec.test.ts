import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { type Capture, listCaptures, parseProse, quotableText } from "../spec/capture.js";
import { diffCaptures, diffSequence } from "../spec/diff.js";
import { classifyProseDrift, generateSpec } from "../spec/index.js";
import { changesPage } from "../spec/markdown.js";
import { generateSite, REPO_URL } from "../spec/site.js";

/**
 * The readable side of `spec/` is derived, so it is held to its sources the way
 * the example renders are held to the renderer: regenerate, compare, fail on any
 * difference. And the hand-written reference (`spec/README.md`) may only quote —
 * every “curly-quoted” passage and every line of a ```` ```… quote ```` block
 * must still appear in the newest capture, so an upstream rewording fails here
 * instead of leaving the reference quietly wrong.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const captures = listCaptures(join(root, "spec", "upstream"));
const byVersion = (v: string) => {
  const c = captures.find((x) => x.ccVersion === v);
  if (!c) throw new Error(`no capture for cc-${v}`);
  return c;
};

describe("generated spec pages", () => {
  it("are what `npm run spec` writes from the current captures", () => {
    for (const file of generateSpec(root)) {
      const committed = readFileSync(join(root, file.path), "utf8");
      expect(committed, `${file.path} is stale — run \`npm run spec\``).toBe(file.content);
    }
  });

  it("link every changed passage to the line it sits on in the raw capture", () => {
    // The line links point into the raw `.txt`, so decoding must keep its lines.
    for (const c of captures) {
      expect(quotableLines(c.segments), c.id).toBe(c.prose.split("\n").length);
    }
  });
});

describe("committed snapshots", () => {
  // The drift check compares the installed Claude Code against the newest
  // snapshot and lets renames through, so it cannot notice a hand edit to a
  // snapshot. This can: every artifact must still hash to its manifest entry.
  it.each(captures.map((c) => [c.id, c]))("%s matches its manifest", (_, c) => {
    const capture = c as Capture;
    const files = { "workflow-tool-description.txt": capture.prose, "workflow-input-schema.d.ts": capture.schema };
    for (const [file, content] of Object.entries(files)) {
      const digest = capture.digests[file];
      expect(digest, `${capture.id}/manifest.json lists ${file}`).toBeDefined();
      expect(Buffer.byteLength(content), `${capture.id}/${file} bytes`).toBe(digest.bytes);
      expect(createHash("sha256").update(content).digest("hex"), `${capture.id}/${file} sha256`).toBe(digest.sha256);
    }
  });
});

function quotableLines(segments: ReturnType<typeof parseProse>): number {
  return segments
    .map((s) => (s.kind === "text" ? s.text : s.kind === "conditional" ? s.text : "x"))
    .join("")
    .split("\n").length;
}

describe("spec/README.md only quotes the newest capture", () => {
  const newest = captures[captures.length - 1];
  const haystack = `${quotableText(newest.segments)} ${newest.schema.replace(/\s+/g, " ")}`;
  const readme = readFileSync(join(root, "spec", "README.md"), "utf8");

  /** Undo what Markdown needed: a backticked placeholder, entities, backslash escapes, wrapping. */
  const normalize = (q: string) =>
    q
      .replace(/`\$\{…\}`/g, "${…}")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\\([!-/:-@[-`{-~])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

  const quotes = [...readme.matchAll(/“([^”]+)”/g)].map((m) => normalize(m[1]));
  const quotedBlocks = [...readme.matchAll(/^```\w* quote\n([\s\S]*?)^```$/gm)].flatMap((m) =>
    m[1]
      .split("\n")
      .filter((l) => l.trim())
      .map(normalize),
  );

  it("has quotes to check", () => {
    expect(quotes.length).toBeGreaterThan(40);
    expect(quotedBlocks.length).toBeGreaterThan(5);
  });

  it.each([...quotes, ...quotedBlocks].map((q) => [q.length > 70 ? `${q.slice(0, 67)}…` : q, q]))(
    "“%s” is in the newest capture",
    (_, quote) => {
      expect(haystack.includes(quote), `not in cc-${newest.ccVersion}: ${quote}`).toBe(true);
    },
  );
});

describe("capture diffs", () => {
  it("find the shortest edit script", () => {
    // Myers' own example: ABCABBA → CBABAC takes five edits.
    const edits = diffSequence([..."ABCABBA"], [..."CBABAC"], (x, y) => x === y);
    expect(edits.filter((e) => e.op !== "=").length).toBe(5);
    expect(edits.filter((e) => e.op !== "+").map((e) => "ABCABBA"[e.a]).join("")).toBe("ABCABBA");
    expect(edits.filter((e) => e.op !== "-").map((e) => "CBABAC"[e.b]).join("")).toBe("CBABAC");
  });

  // The cases below are the ledger's own findings (docs/GRAMMAR-CHANGELOG.md),
  // reached there by hand and here by the diff.
  it("set minifier renames aside: cc-2.1.280 only renamed two values", () => {
    const d = diffCaptures(byVersion("2.1.267"), byVersion("2.1.280"));
    expect(d.excerpts).toEqual([]);
    expect(d.renames).toEqual([
      ["PP", "tN"],
      ["dC", "Fk"],
    ]);
    expect(d.schemaChanged).toBe(false);
  });

  it("show real edits word by word: cc-2.1.245's two rewordings", () => {
    const d = diffCaptures(byVersion("2.1.220"), byVersion("2.1.245"));
    const changes = d.excerpts.map((ex) =>
      ex.pieces
        .filter((p) => p.op !== "=")
        .map((p) => `${p.op}${p.text}`)
        .join(" "),
    );
    expect(changes).toEqual(["-cpu cores +available CPUs", "-4096 +${ZU}"]);
    expect(d.renames).toHaveLength(6);
  });

  it("catch an added option inside a long signature line: cc-2.1.219's effort", () => {
    const d = diffCaptures(byVersion("2.1.173"), byVersion("2.1.219"));
    const added = d.excerpts.flatMap((ex) => ex.pieces.filter((p) => p.op === "+").map((p) => p.text));
    expect(added).toContain("effort?: string,");
    expect(added.some((t) => t.startsWith("opts.effort overrides the reasoning effort"))).toBe(true);
  });

  it("classify drift for the grammar check", () => {
    const raw = (v: string) => byVersion(v).prose;
    expect(classifyProseDrift(raw("2.1.280"), raw("2.1.280")).kind).toBe("same");
    expect(classifyProseDrift(raw("2.1.267"), raw("2.1.280")).kind).toBe("renames");
    expect(classifyProseDrift(raw("2.1.220"), raw("2.1.245")).kind).toBe("wording");
  });

  it("count a spacing-only edit as a change, not a rename", () => {
    const raw = byVersion("2.1.280").prose;
    const spaced = raw.replace("Workflows run in the background", "Workflows run  in the background");
    const drift = classifyProseDrift(raw, spaced);
    expect(drift.kind).toBe("wording");
  });
});

describe("the drift check does not wave through", () => {
  // Each input is one edit to the newest capture that changes what Claude reads
  // or which runtime value fills a slot, while keeping the text identical once
  // names are collapsed. A pass here would let `npm run check-grammar` exit 0.
  const raw = captures[captures.length - 1].prose;
  const edit = (from: string, to: string, nth = 0) => {
    let at = -1;
    for (let i = 0; i <= nth; i++) at = raw.indexOf(from, at + 1);
    expect(at, `the capture contains ${from} (occurrence ${nth})`).toBeGreaterThanOrEqual(0);
    return raw.slice(0, at) + to + raw.slice(at + from.length);
  };
  const kind = (changed: string) => classifyProseDrift(raw, changed).kind;
  const value = (name: string) => "${" + name + "}";
  const values = [...raw.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]);
  const [first, second] = values.filter((v, i) => values.indexOf(v) === i);

  it("one conditional switching to a different guard", () => {
    expect(kind(edit('${e?"":', '${t?"":', 1))).toBe("values");
  });

  it("a slot re-pointed at a value another slot already uses", () => {
    expect(kind(edit(value(second), value(first)))).toBe("values");
  });

  it("two slots trading values", () => {
    const swapped = raw
      .replace(value(first), "\u0000")
      .replace(value(second), value(first))
      .replace("\u0000", value(second));
    expect(kind(swapped)).toBe("values");
  });

  it("a slot re-pointed at a global", () => {
    expect(kind(edit(value(first), value("undefined")))).toBe("values");
  });

  it("an example's literal text turned into a live interpolation", () => {
    expect(kind(edit("\\${d.key}", "${d.key}"))).toBe("wording");
  });

  it("a live value turned into literal text", () => {
    expect(kind(edit(value(first), "\\${·}"))).toBe("wording");
  });

  it("but passes a respelled escape, which Claude reads identically", () => {
    const escaped = "\\" + "u2014";
    expect(kind(edit(escaped, String.fromCharCode(0x2014)))).toBe("encoding");
  });
});

describe("change pages show what a word diff alone would hide", () => {
  const newest = captures[captures.length - 1];
  const variant = (prose: string): Capture => ({ ...newest, id: "variant", ccVersion: "9.9.9", prose, segments: parseProse(prose) });
  const page = (prose: string) =>
    changesPage(newest, variant(prose), diffCaptures(newest, variant(prose)), { before: 2, after: 2, minted: false });
  const quoteHtml = (md: string) =>
    ((marked.parse(md, { gfm: true }) as string).match(/<blockquote>[\s\S]*?<\/blockquote>/g) ?? []).join("");

  it("a joined line, as a struck line-break mark", () => {
    const at = newest.prose.indexOf("on mismatch.\n");
    expect(at).toBeGreaterThan(0);
    const joined = newest.prose.slice(0, at) + "on mismatch. " + newest.prose.slice(at + "on mismatch.\n".length);
    expect(quoteHtml(page(joined))).toContain("<del>↵</del>");
  });

  it("a conditional glued to the word before it, still bold", () => {
    const glued = newest.prose.replace("Use /workflows to watch", 'Use /workflows${e?"":" (or /tasks)"} to watch');
    expect(glued).not.toBe(newest.prose);
    expect(quoteHtml(page(glued))).toMatch(/<strong>«if !e» \(or \/tasks\)«\/if»<\/strong>/);
  });
});

describe("change pages", () => {
  // Excerpts mark changes with `~~…~~` and `**…**` (the prose itself is escaped,
  // so these are the only live delimiters). A delimiter Markdown refuses to parse —
  // say, a mark that opens on a space — would show as literal asterisks instead of
  // a change, so every pair must come out of a real renderer as <del> or <strong>.
  const pages = generateSpec(root).filter((f) => f.path.endsWith("/CHANGES.md"));

  it.each(pages.map((f) => [f.path, f.content]))("%s renders every mark", (_, content) => {
    const quoted = content
      .split("\n")
      .filter((l) => l.startsWith("> "))
      .join("\n");
    const delimiters = (quoted.match(/(?<!\\)\*\*/g)?.length ?? 0) + (quoted.match(/(?<!\\)~~/g)?.length ?? 0);
    const html = marked.parse(content, { gfm: true }) as string;
    const rendered = (html.match(/<blockquote>[\s\S]*?<\/blockquote>/g) ?? []).join("");
    const marks = (rendered.match(/<strong>/g)?.length ?? 0) + (rendered.match(/<del>/g)?.length ?? 0);
    expect(delimiters % 2).toBe(0);
    expect(marks).toBe(delimiters / 2);
  });
});

describe("links", () => {
  it("in the spec pages and the ledger point at files that exist", () => {
    const docs = [
      ...generateSpec(root).map((f) => ({ path: f.path, text: f.content })),
      { path: "docs/GRAMMAR-CHANGELOG.md", text: readFileSync(join(root, "docs/GRAMMAR-CHANGELOG.md"), "utf8") },
    ];
    const broken: string[] = [];
    for (const doc of docs) {
      for (const [, href] of doc.text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(href) || href.startsWith("#")) continue;
        const target = posix.normalize(posix.join(posix.dirname(doc.path), href.split("#")[0]));
        if (!existsSync(join(root, target))) broken.push(`${doc.path} → ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("on the HTML page resolve: anchors to headings, repo links to real paths", () => {
    const html = generateSite(root);
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(30);
    expect(anchors.filter((a) => !ids.has(a))).toEqual([]);
    const repoPaths = [...html.matchAll(new RegExp(`href="${REPO_URL}/(?:blob|tree)/main/([^"#]+)`, "g"))].map((m) => m[1]);
    expect(repoPaths.filter((p) => !existsSync(join(root, p)))).toEqual([]);
  });

  it("leave the HTML page self-contained: no scripts, stylesheets, or images to fetch", () => {
    expect(generateSite(root)).not.toMatch(/<script|<link\s|<img\s|@import/);
  });
});
