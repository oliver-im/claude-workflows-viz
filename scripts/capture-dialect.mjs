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

/**
 * Capture — and check — the upstream Claude Code "workflow dialect": the grammar
 * this tool statically parses, which Claude Code owns and does not formally
 * version, read from the locally installed `@anthropic-ai/claude-code` package,
 * content-hashed and dated. Two artifacts define the dialect:
 *
 *   - the Workflow tool *description* prose (the `meta`/`agent`/`parallel`/
 *     `pipeline`/`phase` authoring contract), embedded as a plaintext template
 *     literal inside the compiled `bin/claude.exe`; and
 *   - the Workflow *input schema* (`WorkflowInput`/`WorkflowOutput`), shipped as
 *     declarations in `sdk-tools.d.ts`.
 *
 * Nothing is executed: the binary is scanned for a known string range and the
 * `.d.ts` is sliced as text. Anchors are matched strictly: a missing anchor
 * throws ("the dialect's shape moved; reconcile manually") rather than capturing
 * garbage.
 *
 * Two modes:
 *   - default — write the capture to `spec/upstream/<YYYY-MM-DD>-cc-<version>/`
 *     with a `manifest.json` of per-artifact sha256s (the epoch baseline).
 *   - `--check` — re-capture in memory and compare against the latest snapshot
 *     in `spec/upstream/` (the checked-in baseline as it sits on disk), exiting
 *     non-zero on any drift. Reading the working-tree files — not a git blob — is
 *     deliberate: it lets the reconcile loop re-capture and re-check before
 *     committing, and means a hand-edited snapshot byte is caught directly. This
 *     is the reconciliation gate (`npm run check-dialect`); see
 *     `docs/DIALECT-CHANGELOG.md` "How to reconcile". It needs the installed
 *     `claude` binary, so it runs where Claude Code lives — a dev machine or a
 *     scheduled local agent — not a generic CI runner.
 */

// The Workflow tool description is one template literal. It starts at this exact
// sentence and ends at the literal's closing delimiter — a backtick immediately
// followed by `})`. That order never collides with inline code in the prose
// (which closes spans as `…})` + backtick, i.e. the reverse).
const PROSE_START = "Execute a workflow script that orchestrates multiple subagents deterministically.";
const PROSE_END = "`})";

const ARTIFACT_PROSE = "workflow-tool-description.txt";
const ARTIFACT_SCHEMA = "workflow-input-schema.d.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Locate the installed @anthropic-ai/claude-code package directory + version. */
function locateClaudeCode() {
  let onPath;
  try {
    onPath = execSync("command -v claude", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("`claude` is not on PATH — install Claude Code to capture its dialect");
  }
  // `bin/claude.exe` is the package's canonical bin entry on every platform (the
  // per-OS binaries are optionalDependencies the postinstall copies in), so the
  // package root is found by walking up from whatever `claude` resolves to.
  let dir = dirname(realpathSync(onPath));
  while (true) {
    const pkgJson = join(dir, "package.json");
    if (existsSync(pkgJson)) {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (pkg.name === "@anthropic-ai/claude-code") return { dir, version: pkg.version };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find the @anthropic-ai/claude-code package from ${onPath}`);
}

/** Extract the Workflow tool description prose from the compiled binary. */
function captureProse(ccDir) {
  const binPath = join(ccDir, "bin", "claude.exe");
  const buf = readFileSync(binPath);
  const start = buf.indexOf(PROSE_START);
  if (start < 0) {
    throw new Error(
      `Workflow description anchor not found in ${binPath} — the dialect's wording moved; reconcile manually`,
    );
  }
  // Slice [start, the closing delimiter) straight from the buffer: no fixed
  // window (so a longer future description can't be silently truncated) and no
  // decoding of the arbitrary binary past the close. The description is ASCII
  // (non-ASCII is source-escaped as \uXXXX), so the byte range decodes exactly.
  const end = buf.indexOf(PROSE_END, start + PROSE_START.length);
  if (end < 0) {
    throw new Error(
      `Workflow description close delimiter (${PROSE_END}) not found after the anchor — reconcile manually`,
    );
  }
  return buf.subarray(start, end).toString("utf8");
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

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Capture both defining artifacts from the install (the shared capture core). */
function captureArtifacts() {
  const { dir: ccDir, version } = locateClaudeCode();
  return {
    version,
    artifacts: {
      [ARTIFACT_PROSE]: captureProse(ccDir),
      [ARTIFACT_SCHEMA]: captureSchema(ccDir),
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

  console.log(`Captured cc-${version} dialect → ${relative(root, outDir)}`);
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
      `no baseline snapshot under ${relative(root, upstreamDir)} — run \`npm run capture-dialect\` first`,
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
      "\n✗ dialect drift — the upstream grammar moved, or the committed snapshot was edited.\n" +
        '  Reconcile per docs/DIALECT-CHANGELOG.md "How to reconcile": re-run\n' +
        "  `npm run capture-dialect`, diff the snapshot, then decide whether it stays on\n" +
        "  the current epoch (incidental wording) or earns the next one (grammar change).",
    );
    process.exit(1);
  }

  // In sync. A version bump that ships a byte-identical grammar is provenance
  // drift, not dialect drift — the same epoch still holds, so note it and pass.
  if (version !== baselineVersion) {
    console.log(
      `\nNote: installed cc-${version} differs from the baseline's cc-${baselineVersion}, ` +
        "but the grammar is byte-identical — same epoch.",
    );
  }
  console.log("\n✓ dialect in sync with the latest baseline — the recognizer is still reconciled.");
}

if (process.argv.includes("--check")) {
  runCheck();
} else {
  runCapture();
}
