# Unit 05 — Sample, docs, and install verification
**Blocked by:** 04-rasterize-to-png-and-wire-the-cli-end-to-end**Agents involved:** main only**Topology:** none
## Summary

Make it genuinely easy to install and run, with a real sample and usage docs.

### Tasks
- Add an `examples/` sample workflow `.js` (a realistic `meta` with several phases and mixed models).
- Flesh out `README.md`: install (`npm i -g claude-workflows-viz` and `npx claude-workflows-viz <file>`), usage per `--format`, and a rendered sample image.
- Verify install paths: `npm pack` then install the tarball / `npx .` runs the binary end-to-end on the sample; confirm shebang + `bin` work.

### Acceptance
- A fresh `npx`/global install renders the bundled sample to SVG and PNG; README documents install + usage accurately.

### Notes
- This makes the "easy install" requirement real and verified end-to-end.
- **Out of v1 (future):** AST-parse the imperative body for agent graphs; add a layout engine (elkjs/dagre); per-pattern templates for the six named workflow patterns (classify-and-act, fanout-synthesize, adversarial-verification, generate-and-filter, tournament, loop-until-done); a trace mode that renders the actual run from `agent-*.jsonl` journals.

## Review pipeline

- [x] `/code-review` — built-in local-diff reviewer (Claude): correctness bugs + reuse/simplification/efficiency. (Not `/code-review:code-review`, the PR plugin.)
- [x] codex cross-lineage 2nd opinion (GPT) over the same working-tree diff, before commit:
  ```sh
  codex exec -s read-only "Second opinion on the working-tree diff. Plan at plan/260607-0-build-claude-workflows-viz-workflow-meta-to-svg-and-png — read 05-sample-docs-and-install-verification.md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief."
  ```

**Outcome:** Claude lineage (via the `feature-dev:code-reviewer` subagent at the worktree) caught **one material doc-accuracy issue**: the README "Examples" used a bare relative `examples/review-pr.js` path that fails for a globally-installed user from an arbitrary cwd — **fixed** by switching the flag-demo examples to a `your-workflow.js` placeholder and adding an accurate bundled-sample callout (clone path + `$(npm root -g)/...` global-install path), plus a "from a clone" note on the in-file comment. It verified every documented flag/default/inference/stdout claim and the never-execute claims against the code, the sample's `meta` validity, and the packaging. codex (GPT) found **no correctness issues** — independently confirmed README↔CLI parity, that the sample parses as an ES module and renders, and that `files`/`prepack`/`bin` are correct. Install path verified manually end-to-end: `npm pack` → install the tarball in a clean project → the **bundled** sample renders to SVG + PNG via the installed bin (shebang + `bin` symlink + `npx` resolution all work; externalized `@resvg/resvg-js` resolves from a real install).
---
See `progress.md` for the cursor and overall plan state.
