# Making a workflow diagram readable

`claude-workflows-viz` is a **literal** renderer: it draws what the body *says*,
verbatim, and never guesses what your code "means". A label written
`` `draft:${p}` `` renders as `draft:simplest`; a branch on `!b` shows `!b`. That
honesty is the whole point — the diagram is always a faithful picture of the code
— but it means **a cryptic workflow yields a cryptic diagram.**

So you don't make the *binary* smarter. You make the *source* clearer, and the
binary renders the clearer source. Making a diagram readable is an **authoring
pass** over the workflow's *own strings*: rewrite labels and phase descriptions
into prose, leave behavior untouched, and review it as an ordinary source diff.
It is a plain editing task — you (or your own agent) can do it with nothing but a
text editor and this page; there is no bundled tool, and deliberately no way to
inject a separate "display" layer (an overlay could drift from the code, which is
exactly what static rendering exists to prevent).

## Two hard rules

- **Never change orchestration logic.** Edit string literals and (only when
  clearly safe) variable names. Do not touch control flow, counts, conditions'
  meaning, `parallel`/`pipeline`/`agent` structure, or which agents run.
- **Never make a label say more than the code does.** A readable label must stay
  *true*. Don't promise "Validate against the schema" if the agent just drafts
  text. Lean on the prompt and surrounding code to learn what each step actually
  does — a wrong-but-confident label is worse than a terse-but-true one.

A good correctness check: re-dump `--format json` before and after. The topology
kinds, counts, phases, and analyzer notes should be **unchanged** (zero new
opaque steps or notes). If the structure shifted, an edit changed behavior —
revert it.

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

A tournament workflow whose node labels read like code. **Before:**

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

**After** — only strings change; the bracket logic is identical:

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
