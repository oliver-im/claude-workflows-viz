# Unit 01 — Capture machinery and the D1 baseline snapshot
**Blocked by:** none**Agents involved:** main only
## Summary

Add a `scripts/capture-dialect.mjs` that snapshots the upstream dialect's defining artifacts from the local Claude Code install, content-hashed and dated, and commit the first baseline (`cc-2.1.173`) as epoch **D1**.

**Tasks**
- New `scripts/capture-dialect.mjs`, mirroring the ESM/`fileURLToPath` style of
  `scripts/build.mjs` and `scripts/regen-examples.mjs` (no new deps; `node:fs`,
  `node:path`, `node:child_process`, `node:crypto`).
- Locate the package: `command -v claude` → `fs.realpathSync` → walk up to the
  `package.json` whose `name` is `@anthropic-ai/claude-code`; read `version`.
- Prose: read `bin/claude.exe` as a buffer, `indexOf` the start anchor, slice a window,
  cut at the first `` `}) `` after it. **Fail loud** (throw with a "reconcile manually"
  message) if either anchor is missing — a moved anchor is the structural-change signal.
- Schema: slice `WorkflowInput`…`WorkflowOutput` out of `sdk-tools.d.ts`.
- sha256 each; write `spec/upstream/<YYYY-MM-DD>-cc-<ver>/` containing
  `workflow-tool-description.txt`, `workflow-input-schema.d.ts`, and `manifest.json`
  (`ccVersion`, `capturedAt`, per-file `{bytes, sha256}`). `Date`/`new Date()` are fine
  here — the unavailability rule only applies inside Workflow scripts, not node scripts.
- Add `"capture-dialect": "node scripts/capture-dialect.mjs"` to `package.json` scripts
  (after `regen-examples`).
- Run it once; commit the produced `spec/upstream/2026-06-23-cc-2.1.173/` as the D1 baseline.

**Acceptance**
- `npm run capture-dialect` writes the snapshot dir; `manifest.json` records prose
  sha256 `15e8f855…` and byte count `19078` for the current install.
- The baseline dir is committed (verify `spec/` is **not** matched by `.gitignore` — it is
  not; only `dist/`, `out/`, `worktrees/`, `node_modules` are).

**Notes / files**
- `spec/upstream/` is committed to git. It need not be added to `package.json` `files`
  (currently `["dist","README.md","examples","skills"]`) — this is dev infrastructure, not
  shipped to npm.
- Self-contained and runnable on its own — the reviewable slice is "run the script, inspect
  the snapshot + hash."

## Review pipeline

- [x] `/code-review` — 2 finder agents; one simplification applied (buffer-scan replaces the fixed 60 KB window). No correctness bugs.
- [x] `codex exec -s read-only` — ran on the staged diff; **no findings** (independently confirmed 19078B / sha256 `15e8f855…`, the wiring, and the per-interface slice).

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
