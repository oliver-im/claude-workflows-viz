import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

/**
 * Capture — and check — the upstream Claude Code grammar surface this tool
 * statically parses, which Claude Code owns and does not formally version, read
 * from the locally installed `@anthropic-ai/claude-code` package, content-hashed
 * and dated. Four artifacts, in two pairs.
 *
 * The **Workflow** tool — the authoring contract for a dynamic-workflow file:
 *   - `workflow-tool-description.txt` — the description prose (`meta`/`agent`/
 *     `parallel`/`pipeline`/`phase`), embedded as a plaintext template literal
 *     inside the compiled `bin/claude.exe`; and
 *   - `workflow-input-schema.d.ts` — `WorkflowInput`/`WorkflowOutput`, shipped as
 *     declarations in `sdk-tools.d.ts`.
 *
 * The **Agent** tool — the *subagent* surface a workflow's `agent()` call
 * ultimately spawns onto, and the reason it is pinned at all: `opts.agentType`
 * resolves against this tool's registry, and `opts.model`'s enum lives in its
 * schema, not the Workflow one. Before these two artifacts existed the changelog
 * asserted facts about the Agent tool against a baseline that never captured it:
 *   - `agent-tool-description.fragments.txt` — see `captureAgentProse`; and
 *   - `agent-input-schema.d.ts` — `AgentInput`/`AgentOutput`.
 *
 * Nothing is executed: the binary is scanned for known string ranges, the one
 * assembled description is recovered by *parsing* (acorn) rather than running its
 * builder, and the `.d.ts` is sliced as text. Anchors are matched strictly: a
 * missing or ambiguous anchor throws ("the grammar's shape moved; reconcile
 * manually") rather than capturing garbage.
 *
 * Two modes:
 *   - default — write the capture to `spec/upstream/<YYYY-MM-DD>-cc-<version>/`
 *     with a `manifest.json` of per-artifact sha256s (the grammar-level baseline).
 *   - `--check` — re-capture in memory and compare against the latest snapshot
 *     in `spec/upstream/` (the checked-in baseline as it sits on disk), exiting
 *     non-zero on any drift. Reading the working-tree files — not a git blob — is
 *     deliberate: it lets the reconcile loop re-capture and re-check before
 *     committing, and means a hand-edited snapshot byte is caught directly. This
 *     is the reconciliation gate (`npm run check-grammar`); see
 *     `docs/GRAMMAR-CHANGELOG.md` "How to reconcile". It needs the installed
 *     `claude` binary, so it runs where Claude Code lives — a dev machine or a
 *     scheduled local agent — not a generic CI runner.
 */

// The Workflow tool description is one template literal. It starts at this exact
// sentence and ends at the literal's closing delimiter — a backtick immediately
// followed by `})`. That order never collides with inline code in the prose
// (which closes spans as `…})` + backtick, i.e. the reverse).
const WORKFLOW_PROSE_START =
  "Execute a workflow script that orchestrates multiple subagents deterministically.";
const WORKFLOW_PROSE_END = "`})";

// The Agent tool description has no such delimiters — it is built, not stored —
// so the anchor is only a way in; `captureAgentProse` finds the extent.
const AGENT_PROSE_ANCHOR = "Launch a new agent to handle complex, multi-step tasks.";

/** Every `${…}` in the Agent prose collapses to this. See `captureAgentProse`. */
const AGENT_INTERPOLATION = "${…}";
/** Fragment delimiter in the Agent prose artifact; asserted un-collidable at capture. */
const AGENT_FRAGMENT_SEP = "-".repeat(40);

const ARTIFACT_PROSE = "workflow-tool-description.txt";
const ARTIFACT_SCHEMA = "workflow-input-schema.d.ts";
const ARTIFACT_AGENT_PROSE = "agent-tool-description.fragments.txt";
const ARTIFACT_AGENT_SCHEMA = "agent-input-schema.d.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PKG_NAME = "@anthropic-ai/claude-code";

/**
 * Is `dir` a usable claude-code package root? Three outcomes, which the callers
 * distinguish: `null` (not this package at all — no/unreadable `package.json`, or
 * a different name), `{dir, version, missing}` (the right package, but a capture
 * artifact is absent), or `{dir, version}` (good).
 *
 * The `missing` case is deliberately reported rather than folded into `null`: a
 * directory that IS the package but can't be captured from is a much more useful
 * thing to say in the failure message than "not found". Layouts that ship the CLI
 * without the package scaffolding — e.g. the native installer's
 * `~/.local/share/claude/versions/<ver>`, a self-contained binary — never reach
 * that check; they fail the `package.json` test on the first line and return
 * `null`.
 */
function readPackageAt(dir) {
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) return null;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  } catch {
    return null;
  }
  if (pkg.name !== PKG_NAME) return null;
  const missing = [join("bin", "claude.exe"), "sdk-tools.d.ts"].filter(
    (f) => !existsSync(join(dir, f)),
  );
  return missing.length > 0 ? { dir, version: pkg.version, missing } : { dir, version: pkg.version };
}

/** Walk up from a path looking for the package root. */
function walkUpFrom(start) {
  let dir = start;
  while (true) {
    const found = readPackageAt(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Locate the installed @anthropic-ai/claude-code package directory + version.
 *
 * Three strategies, in order — because `claude` on PATH is NOT reliably a file
 * inside the package. It is for an npm install (`…/bin/claude` symlinks into
 * `…/lib/node_modules/@anthropic-ai/claude-code/`), but multiplexers and version
 * managers commonly shadow it with a *wrapper script* that lives somewhere else
 * entirely and re-execs the real CLI — cmux, for instance, puts a bash shim in a
 * temp dir. `realpathSync` on a wrapper resolves to the wrapper, so the walk-up
 * finds nothing. Falling back to `npm root -g` recovers the ordinary npm install
 * underneath; `CLAUDE_CODE_DIR` is the escape hatch for anything else.
 */
function locateClaudeCode() {
  const tried = [];

  // 1. An explicit override always wins — point it at the package root.
  const override = process.env.CLAUDE_CODE_DIR;
  if (override) {
    const found = readPackageAt(override);
    if (found && !found.missing) return found;
    tried.push(
      `CLAUDE_CODE_DIR=${override} — ${
        found?.missing ? `missing ${found.missing.join(", ")}` : `not a ${PKG_NAME} package root`
      }`,
    );
  }

  // 2. Walk up from `claude` on PATH (the npm-install case).
  let onPath;
  try {
    onPath = execSync("command -v claude", { encoding: "utf8" }).trim();
  } catch {
    onPath = "";
  }
  if (onPath) {
    // `realpathSync` can throw on a path `command -v` was happy with: a
    // permissions wall on a parent directory, a symlink loop, or the binary
    // being swapped out between the two calls (Claude Code self-updates, so
    // that race is real). None of those mean there is no install to capture
    // from — record the miss and let strategy 3 run, rather than taking the
    // whole locate down with an uncaught throw.
    let resolved;
    try {
      resolved = realpathSync(onPath);
    } catch (err) {
      tried.push(`\`claude\` on PATH (${onPath}) — cannot be resolved: ${err.message}`);
    }
    const found = resolved ? walkUpFrom(dirname(resolved)) : undefined;
    if (found && !found.missing) return found;
    if (resolved) {
      tried.push(
        `\`claude\` on PATH (${onPath}) — ${
          found?.missing
            ? `found ${found.dir} but it is missing ${found.missing.join(", ")}`
            : "resolves outside any package (a wrapper script?)"
        }`,
      );
    }
  } else {
    tried.push("`claude` is not on PATH");
  }

  // 3. The global npm root — where a PATH wrapper is usually hiding the install.
  let globalRoot;
  try {
    globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  } catch {
    globalRoot = "";
  }
  if (globalRoot) {
    const candidate = join(globalRoot, PKG_NAME);
    const found = readPackageAt(candidate);
    if (found && !found.missing) return found;
    tried.push(
      `\`npm root -g\` (${candidate}) — ${
        found?.missing ? `missing ${found.missing.join(", ")}` : "no package there"
      }`,
    );
  }

  throw new Error(
    `could not locate an ${PKG_NAME} install to capture from. Tried:\n` +
      tried.map((t) => `  - ${t}`).join("\n") +
      `\n  Set CLAUDE_CODE_DIR to the package root (the directory holding bin/claude.exe and sdk-tools.d.ts).`,
  );
}

/** Extract the Workflow tool description prose from the compiled binary. */
function captureProse(ccDir) {
  const binPath = join(ccDir, "bin", "claude.exe");
  const buf = readFileSync(binPath);
  const start = buf.indexOf(WORKFLOW_PROSE_START);
  if (start < 0) {
    throw new Error(
      `Workflow description anchor not found in ${binPath} — the grammar's wording moved; reconcile manually`,
    );
  }
  // Slice [start, the closing delimiter) straight from the buffer: no fixed
  // window (so a longer future description can't be silently truncated) and no
  // decoding of the arbitrary binary past the close. The description is ASCII
  // (non-ASCII is source-escaped as \uXXXX), so the byte range decodes exactly.
  const end = buf.indexOf(WORKFLOW_PROSE_END, start + WORKFLOW_PROSE_START.length);
  if (end < 0) {
    throw new Error(
      `Workflow description close delimiter (${WORKFLOW_PROSE_END}) not found after the anchor — reconcile manually`,
    );
  }
  return buf.subarray(start, end).toString("utf8");
}

/**
 * Extract the Agent (subagent) tool description's PROSE from the compiled binary.
 *
 * Unlike the Workflow description, there is no string to slice. The Agent
 * description is *assembled* by a builder function: at cc-2.1.220, 10 runtime gates
 * (fork support, background vs. synchronous, plan tier, teammate context, remote
 * sandbox…) drive 29 branch points over 60 string/template literals. No single
 * literal holds the description, and which of them apply depends on runtime state
 * we do not have and will not manufacture. Running the builder to find out is off
 * the table: this project never executes what it inspects. So we do the same thing
 * the renderer does with a workflow body — parse it, and report only what the
 * source literally says.
 *
 * The capture is therefore an inventory of the builder's string and template
 * literals in source order, one per fragment, with every interpolation collapsed
 * to `${…}`. Every variant is present (nothing is chosen for the reader), and the
 * conditions that select them are not — an honest trade, and the reason the file
 * is named `.fragments.txt` rather than `-description.txt`: it is not a rendered
 * description and must not read as one.
 *
 * Collapsing the interpolations is load-bearing, not cosmetic. The Workflow prose
 * is captured raw, so its hash churns whenever the minifier reshuffles the
 * identifiers inside its `${…}` (the "Known noise" box in
 * `docs/GRAMMAR-CHANGELOG.md`). This builder is mostly *code*, so a raw slice
 * would trip the gate on essentially every release with nothing to reconcile.
 * Normalizing makes the artifact stable against renames by construction — at the
 * cost of not seeing a change that is purely an identifier swap, which by
 * construction carries no grammar meaning.
 */
function captureAgentProse(ccDir) {
  const binPath = join(ccDir, "bin", "claude.exe");
  const buf = readFileSync(binPath);

  // The binary carries this sentence TWICE: once as source (opening a template
  // literal) and once in the JSC bytecode constant pool, where the same text sits
  // as a NUL-delimited fragment with its `${…}` already split away. Only the
  // source copy is preceded by a backtick, which is the whole discriminator —
  // a plain `indexOf` finds the bytecode copy first and would capture garbage.
  const BACKTICK = 0x60;
  const hits = [];
  for (let i = buf.indexOf(AGENT_PROSE_ANCHOR); i >= 0; i = buf.indexOf(AGENT_PROSE_ANCHOR, i + 1)) {
    if (buf[i - 1] === BACKTICK) hits.push(i);
  }
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one source-form Agent description anchor in ${binPath}, found ${hits.length} — ` +
        "the grammar's shape moved; reconcile manually",
    );
  }
  const anchor = hits[0];

  // The builder's name is minifier-generated (`mvd` at cc-2.1.220), so it cannot
  // be anchored on. Walk back from the prose to the nearest enclosing
  // `function <ident>(` instead — stable under renames, since only the shape is
  // matched.
  // Decoded as latin1, NOT utf8: `fnRel` is used as a byte offset into `buf`, and
  // latin1 is the only decoding where one char is exactly one byte, so the two
  // cannot diverge. (utf8 happens to agree today because the surrounding bundle is
  // pure ASCII — but that is a property of what the minifier put nearby, not a
  // guarantee, and one literal non-ASCII byte in the window would shift every
  // offset after it.) The pattern is ASCII-only, so it matches identically either
  // way.
  const BACK_WINDOW = 64 * 1024;
  const winStart = Math.max(0, anchor - BACK_WINDOW);
  const before = buf.subarray(winStart, anchor).toString("latin1");
  let fnRel = -1;
  for (const m of before.matchAll(/function\s+[A-Za-z0-9_$]+\s*\(/g)) fnRel = m.index;
  if (fnRel < 0) {
    throw new Error(
      "no enclosing function found before the Agent description anchor — reconcile manually",
    );
  }
  const fnStart = winStart + fnRel;

  // Let acorn measure the extent. Its lexer already knows strings, template
  // nesting, regex literals, and comments — all of which a hand-rolled brace scan
  // would have to re-derive, and would get wrong on the first regex in minified
  // code. `parseExpressionAt` reads exactly one function and stops at its closing
  // brace, so the window past it is never decoded as anything meaningful.
  const AHEAD_WINDOW = 512 * 1024;
  const text = buf.subarray(fnStart, Math.min(buf.length, fnStart + AHEAD_WINDOW)).toString("utf8");
  let fn;
  try {
    fn = acorn.parseExpressionAt(text, 0, { ecmaVersion: "latest" });
  } catch (err) {
    throw new Error(
      `could not parse the Agent description builder at byte ${fnStart}: ${err.message} — reconcile manually`,
    );
  }
  // Here `text` IS decoded as utf8, so that fragment contents come out as real
  // strings — but that makes acorn's offsets char-based while `anchor`/`fnStart`
  // are byte-based. They agree only while the region is single-byte throughout, so
  // check that rather than assume it; a mismatch means the comparison below (and
  // any offset reasoning after it) is meaningless.
  if (Buffer.byteLength(text.slice(0, fn.end)) !== fn.end) {
    throw new Error(
      "the Agent description builder contains non-ASCII source bytes, so parser offsets no " +
        "longer line up with binary offsets — reconcile manually",
    );
  }
  // The walk-back found *a* function; this proves it is the enclosing one.
  if (fn.end <= anchor - fnStart) {
    throw new Error(
      "the function preceding the Agent description anchor closes before it — reconcile manually",
    );
  }

  // Collect string and template literals in source order. Nested templates inside
  // an interpolation are visited in their own right, so both arms of a
  // `${cond ? `a` : `b`}` survive as separate fragments — flattened, but never
  // dropped.
  const frags = [];
  (function walk(node) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node.type !== "string") return;
    if (node.type === "Literal" && typeof node.value === "string") {
      frags.push([node.start, node.value]);
    } else if (node.type === "TemplateLiteral") {
      frags.push([
        node.start,
        node.quasis.map((q) => q.value.cooked ?? "").join(AGENT_INTERPOLATION),
      ]);
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      walk(node[key]);
    }
  })(fn);

  frags.sort((a, b) => a[0] - b[0]);
  // Empties are the `:""` arms of the fragment ternaries — they carry no prose,
  // and keeping them would make the artifact churn on pure control-flow edits.
  const kept = frags.map(([, s]) => s).filter((s) => s.trim() !== "");
  if (kept.length === 0) {
    throw new Error("the Agent description builder yielded no prose — reconcile manually");
  }
  // The delimiter has to be unambiguous for the artifact to be readable as a
  // fragment list. Assert that rather than hope: a fragment that ever contains a
  // bare separator line silently merges two entries in every future diff.
  const collision = kept.find((s) => s.split("\n").includes(AGENT_FRAGMENT_SEP));
  if (collision !== undefined) {
    throw new Error(
      "an Agent prose fragment contains the fragment separator; the delimiter is no longer " +
        "unambiguous — reconcile manually",
    );
  }
  return `${kept.join(`\n${AGENT_FRAGMENT_SEP}\n`)}\n`;
}

/** Slice one top-level `export interface <name> { ... }` block out of the .d.ts. */
function sliceInterface(dts, name) {
  const start = dts.indexOf(`export interface ${name}`);
  if (start < 0) {
    throw new Error(`interface ${name} not found in sdk-tools.d.ts — reconcile manually`);
  }
  // Top-level interfaces close with `}` at column 0 (a newline directly followed
  // by `}`); nested object types are indented, so this skips past them.
  const end = dts.indexOf("\n}", start);
  if (end < 0) throw new Error(`could not find the end of interface ${name}`);
  return dts.slice(start, end + 2);
}

/** Capture the Workflow input/output schema from the shipped declarations. */
function captureSchema(ccDir) {
  const dts = readFileSync(join(ccDir, "sdk-tools.d.ts"), "utf8");
  return `${sliceInterface(dts, "WorkflowInput")}\n\n${sliceInterface(dts, "WorkflowOutput")}\n`;
}

/**
 * Slice one top-level declaration — `export interface X {…}` OR `export type X = …`
 * — out of the .d.ts, by running to the next top-level `export`.
 *
 * `sliceInterface` above cannot do this job: it ends at the first `}` in column 0,
 * and `AgentOutput` is a *union type alias* whose last member closes at `};`
 * indented four spaces, so that rule runs straight past it into the rest of the
 * file. The two slicers are kept separate rather than unified because changing
 * how the Workflow schema is sliced would move its bytes, and with them a
 * committed baseline hash that two snapshots (cc-2.1.173, cc-2.1.219) can no
 * longer be re-captured to match.
 */
function sliceTopLevelDecl(dts, name) {
  const opener = new RegExp(String.raw`^export (?:interface|type) ${name}\b`, "m");
  const m = opener.exec(dts);
  if (!m) {
    throw new Error(`declaration ${name} not found in sdk-tools.d.ts — reconcile manually`);
  }
  const after = m.index + m[0].length;
  const next = dts.slice(after).search(/\nexport /);
  return `${dts.slice(m.index, next < 0 ? dts.length : after + next).trimEnd()}\n`;
}

/**
 * Capture the Agent (subagent) input/output schema. This is the artifact that
 * actually earns its keep for a workflow renderer: `AgentInput.model` is where the
 * `"sonnet" | "opus" | "haiku" | "fable"` enum behind `MODEL_SWATCHES` lives, and
 * `subagent_type` is the registry `agent()`'s `opts.agentType` resolves against.
 * Both were previously unpinned — `fable` was noticed by accident, not by the gate.
 */
function captureAgentSchema(ccDir) {
  const dts = readFileSync(join(ccDir, "sdk-tools.d.ts"), "utf8");
  return `${sliceTopLevelDecl(dts, "AgentInput")}\n${sliceTopLevelDecl(dts, "AgentOutput")}`;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Capture every defining artifact from the install (the shared capture core). */
function captureArtifacts() {
  const { dir: ccDir, version } = locateClaudeCode();
  return {
    version,
    artifacts: {
      [ARTIFACT_PROSE]: captureProse(ccDir),
      [ARTIFACT_SCHEMA]: captureSchema(ccDir),
      [ARTIFACT_AGENT_PROSE]: captureAgentProse(ccDir),
      [ARTIFACT_AGENT_SCHEMA]: captureAgentSchema(ccDir),
    },
  };
}

/** The latest committed snapshot dir name under spec/upstream/, or null if none. */
function latestBaselineName(upstreamDir) {
  if (!existsSync(upstreamDir)) return null;
  // Snapshot dirs are `<YYYY-MM-DD>-cc-<version>`. Numeric collation orders the
  // ISO date prefix chronologically AND the dotted version suffix by value — so
  // cc-2.1.9 sorts before cc-2.1.100, which a plain lexicographic sort gets
  // backwards. The last entry is then the most recent capture.
  const dirs = readdirSync(upstreamDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}-cc-/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return dirs.length > 0 ? dirs[dirs.length - 1] : null;
}

/** Default mode: write the capture as a new dated baseline. */
function runCapture() {
  const { version, artifacts } = captureArtifacts();

  const day = new Date().toISOString().slice(0, 10);
  const outDir = join(root, "spec", "upstream", `${day}-cc-${version}`);
  mkdirSync(outDir, { recursive: true });

  const manifest = { ccVersion: version, capturedAt: new Date().toISOString(), artifacts: {} };
  for (const [name, content] of Object.entries(artifacts)) {
    writeFileSync(join(outDir, name), content);
    manifest.artifacts[name] = { bytes: Buffer.byteLength(content), sha256: sha256(content) };
  }
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Captured cc-${version} grammar → ${relative(root, outDir)}`);
  for (const [name, { bytes, sha256: hash }] of Object.entries(manifest.artifacts)) {
    console.log(`  ${name}: ${bytes}B  sha256 ${hash.slice(0, 16)}…`);
  }
}

/**
 * `--check` mode: re-capture and compare against the latest snapshot in
 * `spec/upstream/`, exiting non-zero on drift. "Drift" is *any* per-artifact byte
 * difference — whether the upstream grammar moved or the checked-in snapshot was
 * edited; both mean the recognizer can no longer be trusted to match what ships.
 */
function runCheck() {
  const upstreamDir = join(root, "spec", "upstream");
  const baselineName = latestBaselineName(upstreamDir);
  if (!baselineName) {
    throw new Error(
      `no baseline snapshot under ${relative(root, upstreamDir)} — run \`npm run capture-grammar\` first`,
    );
  }
  const baselineDir = join(upstreamDir, baselineName);

  // Provenance only — the gate compares against the snapshot artifact *files* on
  // disk, not this manifest, so a hand-edited snapshot byte is caught even if the
  // manifest was left untouched. A missing or unreadable manifest must not abort
  // the check; the file-vs-file comparison below still runs.
  let baselineVersion = "?";
  try {
    baselineVersion = JSON.parse(readFileSync(join(baselineDir, "manifest.json"), "utf8")).ccVersion ?? "?";
  } catch {
    // missing / malformed manifest → unknown provenance; carry on with "?"
  }

  const { version, artifacts } = captureArtifacts();
  console.log(
    `Checking installed cc-${version} against baseline ${relative(root, baselineDir)} (cc-${baselineVersion})…`,
  );

  let drift = false;
  for (const [name, content] of Object.entries(artifacts)) {
    const current = { bytes: Buffer.byteLength(content), sha: sha256(content) };
    const committedPath = join(baselineDir, name);
    if (!existsSync(committedPath)) {
      drift = true;
      console.log(`  ${name}: DRIFT — missing from the committed baseline`);
      console.log(`      current  ${current.bytes}B sha ${current.sha.slice(0, 16)}…`);
      continue;
    }
    const committed = readFileSync(committedPath);
    const baseline = { bytes: committed.length, sha: sha256(committed) };
    if (baseline.sha === current.sha) {
      console.log(`  ${name}: in sync (${current.bytes}B, sha ${current.sha.slice(0, 16)}…)`);
    } else {
      drift = true;
      console.log(`  ${name}: DRIFT`);
      console.log(`      baseline ${baseline.bytes}B sha ${baseline.sha.slice(0, 16)}…`);
      console.log(`      current  ${current.bytes}B sha ${current.sha.slice(0, 16)}…`);
    }
  }

  if (drift) {
    console.error(
      "\n✗ grammar drift — the upstream grammar moved, or the committed snapshot was edited.\n" +
        '  Reconcile per docs/GRAMMAR-CHANGELOG.md "How to reconcile": re-run\n' +
        "  `npm run capture-grammar`, diff the snapshot, then decide whether it stays on\n" +
        "  the current grammar level (incidental wording) or earns the next one (grammar change).",
    );
    process.exit(1);
  }

  // In sync. A version bump that ships a byte-identical grammar is provenance
  // drift, not grammar drift — the same level still holds, so note it and pass.
  if (version !== baselineVersion) {
    console.log(
      `\nNote: installed cc-${version} differs from the baseline's cc-${baselineVersion}, ` +
        "but the grammar is byte-identical — same grammar level.",
    );
  }
  console.log("\n✓ grammar in sync with the latest baseline — the recognizer is still reconciled.");
}

if (process.argv.includes("--check")) {
  runCheck();
} else {
  runCapture();
}
