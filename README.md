# claude-workflows-viz

Render a Claude Code **dynamic workflow** `.js` file's static structure into a clean diagram — SVG primary, PNG rasterized from it.

![A workflow rendered by claude-workflows-viz](examples/review-pr.png)

Dynamic workflows are JavaScript files that begin with `export const meta = { name, description, phases }` and then orchestrate subagents in the body. `claude-workflows-viz` reads the declarative `meta` block **and statically analyzes the imperative body — without ever executing the workflow** — then draws it as a **swimlane table** — one rounded white card (matching the header above it), split into a hairline-separated row per phase, with the phase label (chip, title, detail, and a quiet muted `model:` line) in a left cell and that phase's slice of the agent graph in the right cell. The graph itself is **one continuous flow top-to-bottom** — fan-outs into a barrier, pipeline stages, decision diamonds, and loops summarized as local "↻ repeat" badges — and a cross-phase edge is just a short ordinary edge, because phases are rows beside the graph, not containers it has to break out of. Everything is read straight off the parsed AST as static data: no `eval`, no `vm`, no `import()`, and no headless browser.

> The topology view is the default. `--view phases` renders the original meta-only phase cards (preserved byte-for-byte).

## Install

```sh
npm install -g claude-workflows-viz
```

Or run it without installing:

```sh
npx claude-workflows-viz <workflow.js>
```

## Usage

```
claude-workflows-viz <workflow.js> [-o <out>] [--format svg|png|html|json] [--view topology|phases] [--open]
```

| Option | Description |
| --- | --- |
| `-o, --out <file>` | Write the diagram to this path. Omit it and SVG/HTML/JSON stream to **stdout**. |
| `--format <fmt>` | `svg` (default), `png`, `html`, or `json`. Inferred from `--out`'s extension when omitted. |
| `--view <view>` | `topology` (default) draws the body as a swimlane table — phase labels beside the agent graph; `phases` renders the original meta-only phase cards. |
| `--open` | Open the rendered output in your default app after writing. |
| `-v, --version` | Print the version. |

### Examples

Point it at your own workflow file:

```sh
# SVG to stdout (composable)
claude-workflows-viz your-workflow.js > diagram.svg

# SVG to a file
claude-workflows-viz your-workflow.js -o diagram.svg

# PNG — format inferred from the .png extension
claude-workflows-viz your-workflow.js -o diagram.png

# Render a PNG and open it immediately
claude-workflows-viz your-workflow.js --format png --open
```

A sample workflow ships with the package. From a clone of this repo:

```sh
claude-workflows-viz examples/review-pr.js --open
```

After a global install, reference it where npm placed it:

```sh
claude-workflows-viz "$(npm root -g)/claude-workflows-viz/examples/review-pr.js" --open
```

Each phase badge is colored by its `model`: opus, sonnet, and haiku each get a swatch — matched even inside a full id like `claude-opus-4-8` — and any other model falls back to a neutral badge. Agent circles inside the graph are colored the same way.

## Example gallery

The eight bundled workflows cover the common orchestration patterns; each links to its committed renders.

| Workflow | Pattern | Render |
| --- | --- | --- |
| [`review-pr.js`](examples/review-pr.js) | review pipeline — staged lanes, no inter-stage barrier (the hero above) | [SVG](examples/review-pr.svg) · [PNG](examples/review-pr.png) |
| [`triage-issue.js`](examples/triage-issue.js) | classify-and-act — a decision routes to one of several specialists | [SVG](examples/triage-issue.svg) · [PNG](examples/triage-issue.png) |
| [`summarize-codebase.js`](examples/summarize-codebase.js) | fanout-and-synthesize — ×N readers, barrier, one synthesizer | [SVG](examples/summarize-codebase.svg) · [PNG](examples/summarize-codebase.png) |
| [`verify-fix.js`](examples/verify-fix.js) | adversarial verification — named skeptic lanes converge on a barrier | [SVG](examples/verify-fix.svg) · [PNG](examples/verify-fix.png) |
| [`name-the-feature.js`](examples/name-the-feature.js) | generate-and-filter — diverse generators, one filter | [SVG](examples/name-the-feature.svg) · [PNG](examples/name-the-feature.png) |
| [`choose-approach.js`](examples/choose-approach.js) | tournament — drafts, then a pairwise-judging loop until one stands | [SVG](examples/choose-approach.svg) · [PNG](examples/choose-approach.png) |
| [`hunt-bugs.js`](examples/hunt-bugs.js) | loop-until-done — keep spawning finders until rounds come up dry | [SVG](examples/hunt-bugs.svg) · [PNG](examples/hunt-bugs.png) |
| [`dual-lineage-review.js`](examples/dual-lineage-review.js) | dual-lineage — two independent reviewer lineages, merged verdicts | [SVG](examples/dual-lineage-review.svg) · [PNG](examples/dual-lineage-review.png) |

## Making a diagram readable

The renderer is deliberately **literal**: it draws what the body *says*, verbatim. A fan-out labeled `` `draft:${p}` `` renders as `draft:simplest`; a branch on `!b` shows `!b`; a loop badge quotes its raw condition. That honesty is the point — the tool never guesses what your code "means" — but it also means a cryptic workflow makes a cryptic diagram. Readable diagrams come from readable **source**, not from the binary paraphrasing your code at render time.

One nuance keeps the graph uncluttered now that phases are rows: **a node shows text only when *you* labeled it.** An `agent()` call with an explicit `label` (including a template like `` `draft:${p}` ``) is drawn with that label; an unlabeled `agent()` — where the tool would otherwise slice a label out of the prompt — is drawn as a **bare node, named by the phase row it sits in.** So `` `draft:fastest to ship` `` stays, but an unlabeled `` agent(`Document the winning approach: ${x}`) `` in a *Write up the winner* row becomes a plain dot. Nothing is lost: the prompt still rides along in `--format json` (as `labelExplicit: false` with the full label) and as the node's hover `<title>`. The rule is simply *want a node named? Label it* — the same nudge the skill below automates.

Two pieces close that gap without compromising determinism:

- **`--format json`** dumps the full static analysis — the validated `meta` plus the body's topology tree (every label, count, condition, and source span, plus the file's `requiredDialect`/`recognizerTarget` epoch pair — see [Dialect tracking](#dialect-tracking)) — as machine-readable JSON. It is the read contract for tooling that wants the structure without scraping SVG.

  ```sh
  claude-workflows-viz your-workflow.js --format json | jq .topology.steps
  ```

- **The `workflow-readability` skill** (in [`skills/workflow-readability/`](skills/workflow-readability/SKILL.md)) is a Claude skill that reads that JSON, finds the code-shaped labels and thin phase details, and rewrites the workflow's *own authored strings* (`agent(..., { label })`, `meta.phases[].detail`) into prose — an authoring pass you review and commit. The binary then renders the now-clearer source, still deterministically. Prose generation lives in the skill; the binary stays a faithful renderer.

  A worked before/after lives in [`skills/workflow-readability/example/`](skills/workflow-readability/example/): the same tournament workflow with `draft:${p}` → `Draft the ${p} approach`, `match:${i / 2}` → `Judge this pairing`, and `!b` → `!opponent` ([before](skills/workflow-readability/example/choose-approach.before.png) · [after](skills/workflow-readability/example/choose-approach.after.png)) — only strings changed, the bracket logic is identical.

## How it works

1. Parse the file with [acorn](https://github.com/acornjs/acorn) and locate the top-level `export const meta`.
2. Evaluate **only** that object as a static literal — every executable construct (calls, identifiers, getters, spreads, template expressions) is rejected, never run. This is what makes "never execute the workflow" hold.
3. Validate the result with [zod](https://zod.dev), lay out the cards, and emit SVG.
4. For the topology view, the body is **statically analyzed off the same AST — never executed** into a nested tree, then placed as one continuous vertical agent graph and rendered as a **swimlane table**: `agent()`/`workflow()` calls, `parallel()` fan-outs and barriers, `pipeline()` stages, loops, and branches become a single graph, and each phase becomes a co-registered row — its label cell on the left, its slice of the graph on the right (phase-as-row, not phase-as-container — so loops stay local "↻ repeat" badges and a cross-phase edge is just a short ordinary edge). The analysis never invents what it can't prove: counts come only from literals (an unresolvable fan-out renders as `×N`), condition labels are verbatim source slices, unrecognized orchestration degrades to an honest opaque step, and a body with nothing recovered falls back byte-for-byte to the plain meta-only phases page.
5. For `--format png`, rasterize the SVG with [`@resvg/resvg-js`](https://www.npmjs.com/package/@resvg/resvg-js) — a native renderer, no browser.

## Dialect tracking

The workflow grammar — the `meta` block plus the `agent` / `workflow` / `parallel` / `pipeline` / `phase` body — is owned by Claude Code and **not** formally versioned upstream. This tool recognizes a static subset of it and pins that moving target under its own monotonic **dialect epoch** (`D1`, `D2`, …), reconciled against a captured upstream baseline. The recognizer currently targets **D1** (`cc-2.1.173`); the ledger — what each epoch pins and how a bump is minted when upstream drifts — is [`docs/DIALECT-CHANGELOG.md`](docs/DIALECT-CHANGELOG.md), and the drift check is `npm run check-dialect` (run it wherever Claude Code is installed).

Per-file **feature detection** rides on that pin. When a workflow awaits a call the recognizer doesn't know — or otherwise leans on constructs newer than the targeted epoch — the CLI prints a one-line warning to **stderr** and still renders (exit 0); the unrecognized parts may degrade to opaque steps. It's a heads-up, never a failure:

```
claude-workflows-viz: warning: awaited `race` not recognized as orchestration — possibly newer than dialect D1
```

The same reading rides along in `--format json` as `topology.requiredDialect` (the minimum epoch the file needs) and `topology.recognizerTarget` (the epoch the recognizer targets) — a caniuse-style pair, so tooling can spot drift without scraping the warning text.

## From source

```sh
npm install
npm run build      # bundles ts/cli.ts -> dist/cli.js
npm test
node dist/cli.js examples/review-pr.js -o review.svg
```

## Status

**0.1.0** (beta). Renders the body's statically-inferred agent topology by default as a swimlane table — one continuous vertical graph in a right column, with each phase a co-registered row whose label cell sits to its left (`--view phases` keeps the original meta-only cards, byte-identical). Node text now shows only for author-supplied labels; an unlabeled agent is a bare node named by its phase row (the prompt stays in `--format json` and the hover `<title>`). The layout is a small hand-rolled, phase-driven placement — no dagre/elk dependency; adopting one stays on the roadmap (only if graphs outgrow the phase-structured dialect), as does a trace mode that renders an *actual* run from its `agent-*.jsonl` journal.
