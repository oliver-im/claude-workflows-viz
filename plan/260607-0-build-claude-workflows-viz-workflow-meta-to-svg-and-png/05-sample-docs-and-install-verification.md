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

- [ ] `/code-review`
---
See `progress.md` for the cursor and overall plan state.
