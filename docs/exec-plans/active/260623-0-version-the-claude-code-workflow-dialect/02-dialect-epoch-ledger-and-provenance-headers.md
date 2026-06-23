# Unit 02 — Dialect epoch ledger and provenance headers
**Blocked by:** 01-capture-machinery-and-the-d1-baseline-snapshot**Agents involved:** main only
## Summary

Establish the versioning *scheme* in docs: a `DIALECT-CHANGELOG.md` that defines the epoch concept and records D1, plus provenance headers on the recognizer spec declaring what it targets. This front-loads the vocabulary later units use.

**Tasks**
- New `docs/DIALECT-CHANGELOG.md`: define the epoch model (capture → hash → epoch; bump only
  on a *grammar-relevant* upstream diff, with a one-line delta per bump). Record **D1 =
  baseline**, citing `cc-2.1.173`, the capture date, and the prose/schema sha256s from
  Unit 01's manifest. State plainly that the epoch is *this project's tracking version of an
  externally-owned grammar, not an official Anthropic dialect number*. Include a "How to
  reconcile" section describing the `npm run check-dialect` ritual — **forward-reference:**
  that script is implemented in Unit 05; call this pointer out so it isn't a surprise in
  review.
- Add a provenance header to `docs/workflow-js-structure.md` (the recognizer spec): "Recognizer
  targets dialect ≤ **D1**; reconciled against `cc-2.1.173` on <date>. Upstream snapshots in
  `spec/upstream/`; epoch ledger in `docs/DIALECT-CHANGELOG.md`." Cross-link its existing
  §5 Maintenance (`workflow-js-structure.md:189-206`).
- Update `docs/glossary.md` §A so the dialect's "authority" line also names the epoch ledger
  and `spec/upstream/` alongside the two recognizer files.

**Acceptance**
- D1's shas in `DIALECT-CHANGELOG.md` match Unit 01's `manifest.json` exactly.
- The recognizer-owned vs upstream-tracked distinction is explicit and cross-referenced; the
  single forward-reference (to `check-dialect`) is labeled as deferred.

**Notes / files**
- Docs-only unit; reviewable as a read-only pass for internal consistency.

## Review pipeline

- [ ] `/code-review`
- [ ] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
