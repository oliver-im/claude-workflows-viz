import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Extraction rules of `scripts/capture-grammar.mjs`, driven with crafted inputs.
 *
 * The rest of the grammar gate is checked against *committed output*
 * (`grammar.test.ts` holds each snapshot to its manifest) or against the *installed
 * binary* (`npm run check-grammar`). Neither reaches the selectors, which is where
 * the subtle failures live: the binary is a moving target that only exists on a
 * machine with Claude Code installed, so a rule that silently captures the wrong
 * region would produce an artifact that is internally consistent — valid hash, valid
 * manifest, passing tests — and simply wrong. These fixtures are how those rules get
 * to fail on purpose.
 *
 * The fixtures stand in for `bin/claude.exe`: the capture only ever reads it as a
 * byte buffer and searches it as text, so plain JS source is a faithful stand-in for
 * the part that matters.
 */

const scriptUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "capture-grammar.mjs"),
).href;
// Non-literal specifier on purpose: it keeps TypeScript from trying to resolve types
// for a plain .mjs script, and importing is safe because the CLI entrypoint is
// guarded by `invokedDirectly()`.
const capture = await import(/* @vite-ignore */ scriptUrl);

const ANCHOR = "Launch a new agent to handle complex, multi-step tasks.";
const SEP: string = capture.AGENT_FRAGMENT_SEP;

const tmpRoot = mkdtempSync(join(tmpdir(), "cwv-capture-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
/** A stand-in install: `bin/claude.exe` holding `js`, and an optional `sdk-tools.d.ts`. */
function fakeInstall(js: string, dts?: string): string {
  const dir = join(tmpRoot, `cc-${seq++}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "claude.exe"), js);
  if (dts !== undefined) writeFileSync(join(dir, "sdk-tools.d.ts"), dts);
  return dir;
}

const proseOf = (js: string): string[] =>
  (capture.captureAgentProse(fakeInstall(js)) as string).replace(/\n$/, "").split(`\n${SEP}\n`);

// A miniature of the real builder: a gated fragment, the anchor-bearing header, an
// early return, and a tail with a nested ternary — every shape the collector must
// handle, in one function small enough to reason about.
const BUILDER = `function build(e,t){
  let m = t ? \`\\n\\nExtra when t.\` : "";
  let g = \`${ANCHOR} Header.\${m}\`;
  if (e) return g;
  return \`\${g}\\n\\n## Usage notes\\n\\n- \${e ? \`forked\` : \`fresh\`}\`;
}`;

describe("captureAgentProse — what it collects", () => {
  it("inventories every literal in source order, interpolations collapsed", () => {
    expect(proseOf(BUILDER)).toEqual([
      "\n\nExtra when t.",
      `${ANCHOR} Header.${capture.AGENT_INTERPOLATION}`,
      `${capture.AGENT_INTERPOLATION}\n\n## Usage notes\n\n- ${capture.AGENT_INTERPOLATION}`,
      "forked",
      "fresh",
    ]);
  });

  it("keeps both arms of a conditional — nothing is chosen for the reader", () => {
    const frags = proseOf(BUILDER);
    expect(frags).toContain("forked");
    expect(frags).toContain("fresh");
  });

  it("drops fragments that carry no prose, empty or whitespace-only", () => {
    // The `: ""` arms of the fragment ternaries, and separator-only fragments like a
    // bare "\n\n", say nothing about the description's wording — keeping them would
    // make the artifact churn on pure control-flow edits. Dropping them hides
    // nothing: prose appearing where there was none shows up as a new fragment, and
    // prose becoming empty shows up as a deletion.
    expect(proseOf(BUILDER)).not.toContain("");
    const ws = proseOf(`function b(t){ let x = t ? \`\\n\\n\` : ""; return \`${ANCHOR}\${x}\`; }`);
    expect(ws).toEqual([ANCHOR + capture.AGENT_INTERPOLATION]);
  });

  it("is deterministic across runs", () => {
    expect(capture.captureAgentProse(fakeInstall(BUILDER))).toBe(
      capture.captureAgentProse(fakeInstall(BUILDER)),
    );
  });
});

describe("captureAgentProse — anchor selection", () => {
  it("ignores a copy that does not open a template literal (the bytecode pool)", () => {
    // The real binary carries the sentence twice; the constant-pool copy sits among
    // NULs rather than after a backtick. A plain indexOf finds that one first.
    const decoy = `\u0000${ANCHOR}\u0000\u0000`;
    expect(proseOf(`${decoy}\n${BUILDER}`)).toEqual(proseOf(BUILDER));
  });

  it("refuses when two source-form anchors exist", () => {
    expect(() => proseOf(`${BUILDER}\n${BUILDER.replace("build", "other")}`)).toThrow(
      /expected exactly one source-form Agent description anchor.*found 2/s,
    );
  });

  it("refuses when the anchor never opens a template literal", () => {
    expect(() => proseOf(`const s = "${ANCHOR}";`)).toThrow(/found 0/);
  });
});

describe("captureAgentProse — builder identification", () => {
  it("refuses when the anchor sits in a function nested inside another", () => {
    // The failure this guards is silent: taking the NEAREST enclosing function would
    // capture `inner` alone and quietly drop the outer builder's prose, producing a
    // short-but-internally-consistent artifact.
    const nested = `function outer(a){
      let head = \`Outer prose that belongs to the description.\`;
      function inner(b){ let g = \`${ANCHOR} Header.\`; return g; }
      return head + inner(a);
    }`;
    expect(() => proseOf(nested)).toThrow(/nested functions enclose.*reconcile manually/s);
  });

  it("refuses when no function encloses the anchor", () => {
    const loose = `function early(a){ return a + 1; }\nconst g = \`${ANCHOR} Header.\`;`;
    expect(() => proseOf(loose)).toThrow(/no function enclosing.*reconcile manually/s);
  });

  it("refuses when a candidate is too large to measure, rather than skipping it", () => {
    // The subtle version of the nesting failure. `outer` runs past the 512KB parse
    // window, so acorn cannot measure it; `inner` fits and encloses the anchor.
    // Treating an unmeasurable candidate as "not a function" would leave `inner` as
    // the only survivor, satisfy "exactly one enclosing", and silently capture a
    // subtree — the artifact would be short, self-consistent, and wrong. An
    // unresolved candidate has to void the uniqueness claim instead.
    const pad = "x".repeat(600 * 1024);
    const outerTooBig = `function outer(a){
      function inner(b){ let g = \`${ANCHOR} Header.\`; return g; }
      let pad = "${pad}";
      return inner(a) + pad;
    }
    const tail = 1;`;
    expect(() => proseOf(outerTooBig)).toThrow(/could not be measured.*reconcile manually/s);
  });

  it("refuses when an outer candidate is cut off inside a block comment", () => {
    // The variant that defeats a position-only truncation test. acorn's
    // `skipBlockComment` looks ahead for `*/` and raises with the cursor still at the
    // comment's OPENING, so an outer function cut off inside a long comment reports
    // an error far from the window end — indistinguishable, by position alone, from a
    // `function` keyword inside a string. Only the error *kind* separates them.
    const comment = "c".repeat(600 * 1024);
    const outerComment = `function outer(a){
      function inner(b){ let g = \`${ANCHOR} Header.\`; return g; }
      /* ${comment} */
      return inner(a);
    }
    const tail = 1;`;
    expect(() => proseOf(outerComment)).toThrow(/could not be measured.*reconcile manually/s);
  });

  it("refuses when an enclosing candidate carries non-ASCII before the anchor", () => {
    // Raw multibyte text makes acorn's character offsets diverge from the binary's
    // byte offsets. Comparing the two would make `outer` look like it closes before
    // the anchor, so it would be skipped and `inner` would become the false sole
    // survivor. The offsets have to be validated before they are compared.
    const outerNonAscii = `function outer(a){
      let note = "— an em dash — and a café";
      function inner(b){ let g = \`${ANCHOR} Header.\`; return g; }
      return note + inner(a);
    }`;
    expect(() => proseOf(outerNonAscii)).toThrow(/could not be measured.*reconcile manually/s);
  });

  it("measures an async builder, whose `async` is not part of the `function` keyword", () => {
    // Not hypothetical: at cc-2.1.220 the builder IS `async function mvd(e,t,r)`.
    // Matching from the `function` keyword drops the prefix, and re-parsing the body
    // without it turns any `await` into an "Unexpected token" — so the real builder
    // measures correctly today only because it happens to contain no `await`.
    const asyncBuilder = `async function build(a){
      const n = await probe(a);
      let g = \`${ANCHOR} Header \${n}.\`;
      return g;
    }`;
    expect(proseOf(asyncBuilder)).toEqual([`${ANCHOR} Header ${capture.AGENT_INTERPOLATION}.`]);
  });

  it("refuses when an async outer encloses the anchor-bearing function", () => {
    // The narrowing the fixture above is the benign half of. Parsed without its
    // `async`, `outer` fails on `await` and is skipped, leaving `inner` as the sole
    // enclosing candidate — so the capture silently drops `outer`'s prose and returns
    // a short, self-consistent, wrong artifact instead of refusing.
    const asyncNested = `async function outer(a){
      const n = await probe(a);
      let head = \`Prose that belongs to the description.\`;
      function inner(b){ let g = \`${ANCHOR} Header.\`; return g; }
      return head + inner(a) + n;
    }`;
    expect(() => proseOf(asyncNested)).toThrow(/nested functions enclose.*reconcile manually/s);
  });

  it("measures generator and anonymous builders, which `function\\s+<name>` cannot match", () => {
    // `function\s+` cannot cross the `*`, and requires a name — so both forms were
    // previously not candidates at all. Missing a form is not a near miss: whatever
    // named function sits inside it becomes the sole survivor.
    const gen = `function* build(a){ let g = \`${ANCHOR} Generator.\`; yield g; }`;
    expect(proseOf(gen)).toEqual([`${ANCHOR} Generator.`]);
    const anon = `const build = function(a){ let g = \`${ANCHOR} Anonymous.\`; return g; };`;
    expect(proseOf(anon)).toEqual([`${ANCHOR} Anonymous.`]);
  });

  it("keeps `async` attached across a block comment, which the grammar allows", () => {
    // `async [no LineTerminator here] function` admits a comment as the separator,
    // so `async/**/function` is a legal async function and loses its prefix to a
    // whitespace-only pattern — the same silent discard as above, one lexical form
    // over. Covered for correctness rather than reach: there are zero
    // `async <comment> function` in the whole 257MB binary.
    const commented = `async/**/function outer(a){
      const n = await probe(a);
      let head = \`Prose that belongs to the description.\`;
      function inner(b){ let g = \`${ANCHOR} Header.\`; return g; }
      return head + inner(a) + n;
    }`;
    expect(() => proseOf(commented)).toThrow(/nested functions enclose.*reconcile manually/s);
  });

  it("rejects a decoy that parses and spans the anchor but does not contain it", () => {
    // The regex is lexically blind, so a candidate can start inside a string. Here
    // the bytes from that point reparse into a valid anonymous function whose body
    // is a single comment swallowing the real builder — it spans the anchor, so an
    // offset-only enclosure test counts it as a second candidate and turns a working
    // capture into a spurious "reconcile manually". Requiring the parse to contain a
    // template literal opening AT the anchor rejects it: there, the anchor is inside
    // a comment, which is not in the AST at all.
    // The trailing `;` is load-bearing: acorn reads one token past the function body
    // to see whether the expression continues, so a tail ending `"` would abort the
    // decoy on an unterminated string and quietly make this fixture prove nothing.
    const decoyed = `const a = "function(){/*";
    ${BUILDER}
    const b = "*/};";`;
    expect(proseOf(decoyed)).toEqual(proseOf(BUILDER));
  });

  it("refuses when a fragment would collide with the separator", () => {
    const collide = `function b(){ return \`${ANCHOR}\\n${SEP}\\ntail\`; }`;
    expect(() => proseOf(collide)).toThrow(/no longer\s+unambiguous/);
  });
});

describe("the CLI entrypoint guard", () => {
  it("still runs the CLI when executed directly", () => {
    // The import above proves the guard's FALSE branch (importing runs nothing).
    // This proves the true branch, which is the more dangerous one: an
    // `invokedDirectly()` that always returned false would make both
    // `capture-grammar` and `check-grammar` exit 0 having done nothing — a gate
    // that silently stopped gating, indistinguishable from a passing one.
    //
    // Driven to a *failure* on purpose: with every locate strategy blocked, the
    // script can only reach its "could not locate" diagnostic by actually running,
    // and it writes no snapshot on the way.
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const res = spawnSync(process.execPath, [join("scripts", "capture-grammar.mjs"), "--check"], {
      cwd: root,
      encoding: "utf8",
      // Empty PATH so `command -v claude` and `npm root -g` both miss; otherwise
      // this machine's real install would be found and the check would proceed.
      env: { PATH: "", CLAUDE_CODE_DIR: join(tmpRoot, "definitely-not-an-install") },
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/could not locate an @anthropic-ai\/claude-code/);
  });
});

describe("sliceTopLevelDecl", () => {
  const DTS = [
    "export interface Other {",
    "  a: string;",
    "}",
    "export interface AgentInput {",
    "  prompt: string;",
    '  model?: "sonnet" | "opus";',
    "}",
    "export type AgentOutput =",
    "  | {",
    "      agentId: string;",
    "    }",
    "  | {",
    "      status: string;",
    "    };",
    "export interface After {",
    "  z: number;",
    "}",
    "",
  ].join("\n");

  it("slices an interface without swallowing the next declaration", () => {
    expect(capture.sliceTopLevelDecl(DTS, "AgentInput")).toBe(
      'export interface AgentInput {\n  prompt: string;\n  model?: "sonnet" | "opus";\n}\n',
    );
  });

  it("slices a type alias whose union closes indented", () => {
    // The reason this helper exists: `sliceInterface` ends at the first `}` in column
    // zero, and this declaration's last member closes at `    };` — four spaces in —
    // so that rule would run straight past it into the rest of the file.
    const sliced = capture.sliceTopLevelDecl(DTS, "AgentOutput");
    expect(sliced.startsWith("export type AgentOutput =")).toBe(true);
    expect(sliced.trimEnd().endsWith("};")).toBe(true);
    expect(sliced).not.toContain("export interface After");
    // And the older slicer cannot reach it at all — it looks for `export interface`,
    // so a type alias is not merely mis-sliced, it is not found. Keeping the two
    // separate is what stops the Workflow schema's committed bytes from moving.
    expect(() => capture.sliceInterface(DTS, "AgentOutput")).toThrow(/not found/);
  });

  it("refuses a declaration that is not there", () => {
    expect(() => capture.sliceTopLevelDecl(DTS, "Missing")).toThrow(/not found.*reconcile manually/);
  });

  it("captureAgentSchema emits both declarations, in order", () => {
    const dir = fakeInstall("// unused", DTS);
    const schema = capture.captureAgentSchema(dir) as string;
    expect(schema.indexOf("export interface AgentInput")).toBeLessThan(
      schema.indexOf("export type AgentOutput"),
    );
    expect(schema).not.toContain("export interface Other");
    expect(schema).not.toContain("export interface After");
  });
});
