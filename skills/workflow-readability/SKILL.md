---
name: workflow-readability
description: Make a Claude Code dynamic-workflow diagram human-readable. Use this whenever someone wants to improve, clean up, "humanize", or de-jargon a workflow .js file or its claude-workflows-viz diagram — for example cryptic node labels like draft:${p}, match:${i / 2}, gen:literal, read:${m}, a !b or confidence < 0.5 branch, raw loop conditions, or phases with thin or missing descriptions. Also use it when asked to make a workflow's SVG/PNG render clearer, add readable labels, explain a workflow visually to non-authors, or turn terse orchestration code into a diagram someone other than the author can follow. Renders before/after with the bundled binary.
---

# Workflow readability

Turn a terse dynamic-workflow `.js` file into one whose **diagram reads clearly** —
by improving the workflow's *own authored strings*, then re-rendering with
`claude-workflows-viz`.

## The one idea that makes this safe

`claude-workflows-viz` is a **literal** renderer: it draws what the body *says*,
verbatim, and never guesses what your code "means". A label written
`` `draft:${p}` `` renders as `draft:simplest`; a branch on `!b` shows `!b`. That
honesty is a feature — the diagram is always a faithful picture of the code — but
it means **a cryptic workflow yields a cryptic diagram.**

So you don't make the *binary* smarter. You make the *source* clearer, and the
binary renders the clearer source. Your job is an **authoring pass**: rewrite
labels and phase descriptions into prose, leaving behavior untouched, and let the
author review the diff. You are the prose generator; the binary stays
deterministic.

Two hard rules follow from this:

- **Never change orchestration logic.** Edit string literals and (only when
  clearly safe) variable names. Do not touch control flow, counts, conditions'
  meaning, `parallel`/`pipeline`/`agent` structure, or which agents run.
- **Never make a label say more than the code does.** A readable label must stay
  *true*. Don't promise "Validate against the schema" if the agent just drafts
  text. Lean on the prompt and surrounding code to learn what each step actually
  does.

## The loop

### 1. See the "before" and get the facts

Render the current diagram and dump the static analysis. Invoke the tool as
`claude-workflows-viz` if it's installed (global or `npx`); from a clone of this
repo use `node dist/cli.js`.

```sh
claude-workflows-viz path/to/workflow.js -o /tmp/before.svg      # or --open
claude-workflows-viz path/to/workflow.js --format json > /tmp/wf.json
```

The JSON (schema `claude-workflows-viz/analysis@1`) is the full picture: the
validated `meta`, and the body's topology tree — every label, count, condition,
prompt preview, and source span.

### 2. Get a worklist

Pipe the JSON through the bundled report script. It flags the code-shaped labels,
the verbatim conditions, the phases missing a `detail`, and any analyzer notes —
and tells you *how* each one is fixed within the dialect.

```sh
claude-workflows-viz path/to/workflow.js --format json \
  | node <skill-dir>/scripts/readability_report.mjs
```

Read the worklist top to bottom. It is advisory (a heuristic — it's allowed to
over-flag), so use judgment: a label that already reads as a phrase needs nothing.

### 3. Decide the prose, then edit the source

For each flagged item, work out the *honest* readable phrasing from the prompt
preview and surrounding code, then edit the workflow file. Which string you edit
depends on the construct — see "How labels are derived" below. Keep edits minimal
and reviewable.

### 4. Re-render and confirm

```sh
claude-workflows-viz path/to/workflow.js --format json \
  | node <skill-dir>/scripts/readability_report.mjs   # worklist should shrink
claude-workflows-viz path/to/workflow.js -o /tmp/after.svg
```

Re-running the analysis is also a **correctness check**: the topology kinds,
counts, phases, and "Analyzer notes" should be unchanged (zero new opaque steps
or notes). If the structure shifted, an edit changed behavior — revert it. Show
the author the before/after renders and the source diff, and iterate on feedback.

## How labels are derived (so you edit the right string)

The renderer picks each node's caption by fixed rules. To change what's drawn,
change the input to the rule — not a separate "display" layer (there isn't one,
and inventing one would let the diagram drift from the code).

| The cryptic thing | Why it looks that way | How to make it readable |
| --- | --- | --- |
| An **agent label** like `gen:literal`, `Document…` | label = `opts.label` → else the prompt's literal/first line → else `"agent"` | Add or edit `agent(prompt, { label: "…" })`. The label wins over the prompt, so a short imperative phrase here is the cleanest fix. |
| A **fan-out member** `` `draft:${p}` `` → `draft:simplest`, … | a `` `tag:${param}` `` template over **named** items expands per name, but only when every `${…}` is the bare fan-out/stage parameter | Rewrite the **template**, keeping `${param}`: `` label: `Draft the ${p} design` `` → "Draft the simplest design", "Draft the most scalable design", … Don't replace `${p}` with a fixed word — you'd collapse the members into one phrase. |
| A label `` `match:${i / 2}` `` that stays raw | `i / 2` is not the bare parameter, so it can't expand — it's kept verbatim | Replace the whole label with a static phrase: `label: "Judge this pairing"`. |
| A **branch / loop condition** `!b`, `confidence < 0.5`, `bracket.length > 1` | conditions are **verbatim source slices** — the renderer never paraphrases them, on purpose | Don't fake prose here. If it's genuinely cryptic, rename the *code* (e.g. `b` → `opponent`, so `!b` → `!opponent`) only when that's an obviously safe, semantics-preserving rename. Otherwise leave it. |
| A **phase** with a thin/blank blurb | `meta.phases[].detail` is shown in the overview cards and `--view phases` | Write a one-line `detail` for each phase; tighten `description` / `whenToUse` while you're there. |
| An **opaque box** / an "Analyzer notes" entry | the analyzer couldn't read that orchestration structurally | This is a code-shape issue, not a label one. Usually it means an `agent` call is hidden behind a helper, a non-inline thunk, or a computed option — surface it inline if you can. Report it; don't paper over it with a label. |

`meta` must stay a pure data literal (strings/numbers/arrays/objects only — no
calls, identifiers, or `${…}`), so phase `detail`s are plain strings.

## Worked example

A complete, runnable before/after pair ships in [`example/`](example/) — render
both and compare:

```sh
claude-workflows-viz example/choose-approach.before.js -o /tmp/before.svg
claude-workflows-viz example/choose-approach.after.js  -o /tmp/after.svg
```

Before (`example/choose-approach.before.js`, abridged):

```js
phase("Draft the contenders");
await parallel(PRIORITIES.map((p) => () =>
  agent(`Design the ${p} approach to: ${args.problem}`, { label: `draft:${p}` })));

phase("Judge pairwise");
while (bracket.length > 1) {
  for (let i = 0; i < bracket.length; i += 2) {
    const a = bracket[i], b = bracket[i + 1];
    if (!b) { winners.push(a); continue; }
    agent(`Pick the stronger approach…\nA: ${a}\nB: ${b}`, { label: `match:${i / 2}` });
  }
}
```

After — only strings change; the bracket logic is identical:

```js
phase("Draft the contenders");
await parallel(PRIORITIES.map((p) => () =>
  agent(`Design the ${p} approach to: ${args.problem}`, { label: `Draft the ${p} approach` })));

phase("Judge pairwise");
while (bracket.length > 1) {
  for (let i = 0; i < bracket.length; i += 2) {
    const a = bracket[i], opponent = bracket[i + 1];
    if (!opponent) { winners.push(a); continue; }
    agent(`Pick the stronger approach…\nA: ${a}\nB: ${opponent}`, { label: "Judge this pairing" });
  }
}
```

What changed and why:

- `` `draft:${p}` `` → `` `Draft the ${p} approach` `` — the template still expands
  per priority, so the four members now read "Draft the simplest approach", "Draft
  the most scalable approach", … instead of `draft:simplest`.
- `` `match:${i / 2}` `` → `"Judge this pairing"` — `i / 2` couldn't expand, so a
  static phrase is clearer and just as honest.
- `b` → `opponent` — a safe rename, so the diagram's branch reads `!opponent`
  ("no opponent → bye") instead of `!b`. Behavior is unchanged.

Re-render and the tournament reads as a tournament — without the renderer ever
guessing.

## Scope reminders

- Improve **strings and safe renames**, never logic. If a "fix" requires changing
  what runs, stop and ask the author.
- Keep the workflow **runnable**: don't break the `meta` data-literal contract or
  the `agent()/parallel()/pipeline()` call shapes.
- When unsure what a step does, read its prompt and the surrounding code rather
  than guessing — a wrong-but-confident label is worse than a terse-but-true one.
