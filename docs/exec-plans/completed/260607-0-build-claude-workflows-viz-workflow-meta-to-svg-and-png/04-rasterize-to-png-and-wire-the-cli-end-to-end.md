# Unit 04 — Rasterize to PNG and wire the CLI end-to-end
**Blocked by:** 03-render-the-phase-flow-svg**Agents involved:** main only**Topology:** none
## Summary

Complete the must-have image pipeline: SVG → PNG via `@resvg/resvg-js`, and wire the default command from file path to written output honoring `--format`, `-o`, and `--open`.

### Tasks
- `ts/render-png.ts`: `svgToPng(svg: string): Buffer` using `@resvg/resvg-js` (`new Resvg(svg).render().asPng()`), no browser.
- Wire `ts/cli.ts` default action: read `<workflow>` → `extractMeta` (U02) → `renderSvg` (U03) → if `--format png`, rasterize → write to `--out` (or a default path; svg may go to stdout) → if `--open`, open via the `openBrowser` pattern from planview's `ts/output.ts` (copy `ts/output.ts`).
- Errors: missing file, extract failure, bad `--format` → clear messages + non-zero exit.
- `ts/__tests__/cli.smoke.test.ts`: run the built CLI against a fixture: `-o out.svg` writes well-formed SVG; `--format png -o out.png` writes a file whose first bytes are the PNG magic number with non-zero dimensions.

### Acceptance
- `claude-workflows-viz fixture.js -o out.svg` and `--format png -o out.png` both produce valid image files; `--open` opens the result; the previously-stubbed action is now real.

### Notes
- This unit closes the hard requirement (image-file output).
- `--format html` is an **optional, non-blocking** extra: wrap the SVG in planview's `ts/html.ts` chrome + `writeTempHtml`/`openBrowser`. Add it here only if quick; otherwise leave a stub + note — it's not required for v1.

## Review pipeline

- [x] `/code-review` — built-in local-diff reviewer (Claude): correctness bugs + reuse/simplification/efficiency. (Not `/code-review:code-review`, the PR plugin.)
- [x] codex cross-lineage 2nd opinion (GPT) over the same working-tree diff, before commit:
  ```sh
  codex exec -s read-only "Second opinion on the working-tree diff. Plan at plan/260607-0-build-claude-workflows-viz-workflow-meta-to-svg-and-png — read 04-rasterize-to-png-and-wire-the-cli-end-to-end.md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief."
  ```

**Outcome:** Claude lineage run via the `feature-dev:code-reviewer` subagent pointed at the worktree (the sanctioned fallback, to dodge `/code-review` mis-rooting to planview) — no material findings; it positively verified the never-execute invariant, the binary-to-stdout guard, `process.exit` non-truncation, resvg usage, and all output-routing combinations. codex (GPT) found **one Medium**: the Windows `--open` path used `cmd /C start`, and `cmd` re-parses metacharacters, so a path with `&` (e.g. from a maliciously-named workflow file) could be interpreted as a command — **fixed** by opening via `explorer.exe` (literal CreateProcess arg, no shell). Both lineages confirmed no path executes the workflow file. 25 tests green.
---
See `progress.md` for the cursor and overall plan state.
