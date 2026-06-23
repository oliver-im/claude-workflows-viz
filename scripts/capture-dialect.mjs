import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Capture the upstream Claude Code "workflow dialect" — the grammar this tool
 * statically parses, which Claude Code owns and does not formally version — from
 * the locally installed `@anthropic-ai/claude-code` package, content-hashed and
 * dated. Two artifacts define the dialect:
 *
 *   - the Workflow tool *description* prose (the `meta`/`agent`/`parallel`/
 *     `pipeline`/`phase` authoring contract), embedded as a plaintext template
 *     literal inside the compiled `bin/claude.exe`; and
 *   - the Workflow *input schema* (`WorkflowInput`/`WorkflowOutput`), shipped as
 *     declarations in `sdk-tools.d.ts`.
 *
 * Nothing is executed: the binary is scanned for a known string range and the
 * `.d.ts` is sliced as text. The capture lands in
 * `spec/upstream/<YYYY-MM-DD>-cc-<version>/` with a `manifest.json` recording the
 * sha256 of each artifact — the fingerprint a future reconciliation diffs
 * against (see Unit 05's `check-dialect`). Anchors are matched strictly: a
 * missing anchor throws ("the dialect's shape moved; reconcile manually") rather
 * than capturing garbage.
 */

// The Workflow tool description is one template literal. It starts at this exact
// sentence and ends at the literal's closing delimiter — a backtick immediately
// followed by `})`. That order never collides with inline code in the prose
// (which closes spans as `…})` + backtick, i.e. the reverse).
const PROSE_START = "Execute a workflow script that orchestrates multiple subagents deterministically.";
const PROSE_END = "`})";

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

const { dir: ccDir, version } = locateClaudeCode();
const artifacts = {
  "workflow-tool-description.txt": captureProse(ccDir),
  "workflow-input-schema.d.ts": captureSchema(ccDir),
};

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
