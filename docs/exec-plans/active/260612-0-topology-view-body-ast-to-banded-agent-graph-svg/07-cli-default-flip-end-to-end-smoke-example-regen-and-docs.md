# Unit 07 — CLI default flip, end-to-end smoke, example regen, and docs
**Blocked by:** 06-banded-layout-engine-topology-renderer**Agents involved:** main only**Topology:** none
## Summary

Wire the pipeline into the CLI with topology as the default view, regenerate all committed renders, and update docs. This closes every forward reference (Units 02–06 modules all become live).

### Deliverables

1. **`ts/cli.ts`**: read the file once (`readWorkflowSource`) → `parseWorkflowSource` → `extractMetaFromProgram` → analyzer+flattener inside try/catch (any throw → one-line stderr warning + `EMPTY_IR`, i.e. v1-equivalent output, exit 0) → `--view <view>` option, `topology` (default) | `phases` (forces `renderSvg`); unknown value → existing `fail()` path. stdout/file/`--open`/PNG/HTML routing untouched.
2. **Smoke tests** (`cli.smoke.test.ts` additions): default on `examples/summarize-codebase.js` → output contains `agent-node` + `barrier`; `--view phases` → no `agent-node`, byte-stable v1; bad `--view` → exit 1 + message; `--help` lists `--view`; PNG via topology path still magic-byte-valid.
3. **Regenerate** all `examples/*.svg` through the default (topology) view; regenerate `examples/review-pr.png` (hero: pipeline ×3 named lanes + ×N verify + barrier). Eyeball each PNG/SVG render before committing (Read the PNGs).
4. **README.md**: hero swap; `--view` row in the options table; "Examples" gallery section — a table linking all 8 workflows to their committed SVGs with one-line pattern names (classify-and-act, fanout-and-synthesize, adversarial verification, generate-and-filter, tournament, loop-until-done, dual-lineage, review-pr); "How it works" gains one paragraph: the body is statically analyzed (never executed) and unrecoverable structure degrades honestly (×N, opaque steps, v1 cards).
5. **`docs/design-context.md`**: §7 roadmap — mark body-AST topology landed (v2), note the constraint-first hand-rolled layout choice (dagre/elk still the upgrade path); §8 updated: the Six-Patterns look is now the default for recognized idioms.
6. `npm pack --dry-run` sanity: dist + README + examples (js/svg/png) all shipped.

### Acceptance

Full suite green; all 8 examples render in both views without warnings; the analyzer-failure fallback proven by a smoke fixture (a meta-only file with an exotic body still exits 0 and renders v1-style); README images resolve to committed paths.

Review focus: the default flip's blast radius (every code path that previously produced v1 SVG), the try/catch fallback honesty (warning visible, never silent), docs accuracy against actual behavior.

## Verification (plan-wide)

1. `npm test` green at every unit boundary; the v1 `render-svg` snapshot stays byte-identical from Unit 02 onward (`--view phases` is the permanent regression surface).
2. After Unit 07: `node dist/cli.js examples/<each>.js -o /tmp/x.svg` (and `--format png`) for all 8 — zero stderr warnings, then visually inspect the PNGs (Read tool) — expect: fan-out circles + barrier (summarize, verify-fix, name-the-feature), named expanded labels (verify-fix, choose-approach), pipeline lanes crossing bands (review-pr), gutter loop arcs (hunt-bugs, choose-approach), decision diamonds with yes/no (triage, hunt-bugs), two-band parallel branches (dual-lineage).
3. `node dist/cli.js examples/triage-issue.js --view phases | diff - <(git show <pre-plan>:examples/triage-issue.svg)` — confirms v1 preserved end-to-end. (Any of the seven committed v1 SVGs works here; review-pr has no committed SVG — only the PNG hero.)
4. `npm pack --dry-run` lists examples; `npx . examples/triage-issue.js --open` spot check.

## Review pipeline

- [ ] `/code-review`
- [ ] `codex exec -s read-only 'Second opinion on the working-tree diff. Plan at {plan_dir} — read the relevant unit md for intent-match; deferred forward-references it notes are expected, not bugs. Flag local correctness + intent-drift; be brief.'` — **exec**: the resuming agent runs this via the Bash tool, then surfaces the findings

_Template steps are recorded verbatim; the **resuming agent** substitutes their placeholders per the resume protocol before running — the renderer never substitutes._
---
See `progress.md` for the cursor and overall plan state.
