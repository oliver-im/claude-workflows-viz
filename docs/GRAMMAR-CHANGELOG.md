# Grammar-level changelog

The **workflow grammar** is the language of a Claude Code dynamic-workflow `.js`
file — the `meta` block plus the `agent` / `workflow` / `parallel` / `pipeline` /
`phase` orchestration body. Claude Code **owns** that grammar and ships it inside
the `@anthropic-ai/claude-code` package; it is **not** formally versioned upstream.

`claude-workflows-viz` recognizes a static subset of that grammar
(`ts/extract-meta.ts` + `ts/analyze-body.ts`). To track something we don't control,
we pin the moving target and name the pin ourselves. This file is the ledger of
that pinning.

## What a grammar level is

A **grammar level** (`1`, `2`, …) is *this project's* monotonic tracking version
of the externally-owned grammar. It is **not** an official Anthropic number —
Anthropic publishes none. We mint it so the recognizer, the docs, and the per-file
feature-detection have one stable handle to point at. (It is a *capability level*,
checked with `requiredLevel ≤ recognizerLevel`, not a release number — the concrete
Claude Code release a level is reconciled against is recorded as provenance below,
not as the key.)

A level is minted from a **capture**, not from a Claude Code release number:

1. **Capture.** `npm run capture-grammar` (`scripts/capture-grammar.mjs`) snapshots
   the artifacts that define the grammar's surface, read straight from the locally
   installed package — nothing is executed. They come in two pairs.

   The **Workflow** tool — the authoring contract for a dynamic-workflow file:
   - **`workflow-tool-description.txt`** — the Workflow tool description prose (the
     authoring contract for `meta` / `agent` / `parallel` / `pipeline` / `phase`),
     extracted as text from the compiled `bin/claude.exe`.
   - **`workflow-input-schema.d.ts`** — the `WorkflowInput` / `WorkflowOutput`
     declarations sliced from the shipped `sdk-tools.d.ts`.

   The **Agent** tool — the *subagent* surface an `agent()` call spawns onto
   ([added 2026-07-25](#capture-surface--the-agent-tool-added-2026-07-25-no-level-change)):
   - **`agent-tool-description.fragments.txt`** — the Agent tool description's prose
     fragments. Not a verbatim slice: that description is *built*, not stored, so
     this is an inventory (see the subsection below).
   - **`agent-input-schema.d.ts`** — the `AgentInput` / `AgentOutput` declarations.

   The snapshot lands dated and version-stamped under
   `spec/upstream/<YYYY-MM-DD>-cc-<version>/`, with a `manifest.json`. Snapshots
   predating an artifact simply lack it, and cannot be back-filled once that
   install is gone; `ts/__tests__/grammar.test.ts` enforces the one rule that
   matters — the capture surface may grow, never shrink.

2. **Hash.** Each artifact is content-hashed (sha256); that hash is the fingerprint.
   The Claude Code version and capture date travel along as **provenance metadata**,
   not as the primary key — two CC releases that ship a byte-identical grammar share
   one level.

3. **Level.** We **bump** the level (`1` → `2`) only on a **grammar-relevant**
   upstream diff: a new orchestration call, a new `meta` field, a new agent option,
   a new fan-out idiom — anything the recognizer would have to learn (the edit-site
   map is [`workflow-js-structure.md` §5](./workflow-js-structure.md#5-maintenance-what-a-grammar-change-touches)).
   A capture that changes only incidental wording (a typo fix, a reflowed paragraph)
   does **not** earn a new level; it is re-captured and noted against the current
   one. Each bump records a one-line delta below.

## Levels

### Level 2 — `agent()` gains `effort` (`cc-2.1.219`, captured 2026-07-24)

Delta: **`agent(prompt, opts)` accepts `opts.effort`** — a per-agent reasoning-effort
override (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`; omitted ⇒ inherits the
session effort). A new agent option, which is exactly the trigger named above, so it
earns the level. The recognizer reads it as a string literal like `model`, and it
**draws**: a muted badge to the left of the agent node, mirroring the ×N badge on the
right. Like `model`, it is taken verbatim rather than checked against the five
documented tiers — a workflow that writes an unknown tier gets its own word back.

| Artifact | Bytes | sha256 |
| --- | --- | --- |
| `workflow-tool-description.txt` | 19581 | `212f59ac753f5c2fc4e9deb9ad7f31f08035928c5dc93d630b92e2e1370fdfb8` |
| `workflow-input-schema.d.ts` | 3064 | `fe6f86e00a7f739fc606aa758a4cc04c17c85a12a5ca30c3d441a190558f44a2` |

Snapshot: [`spec/upstream/2026-07-24-cc-2.1.219/`](../spec/upstream/2026-07-24-cc-2.1.219/).
The input schema is **byte-identical to level 1** — `WorkflowInput`/`WorkflowOutput`
did not move; `effort` is a script-level `agent()` option, documented only in the
tool-description prose, so only that artifact's hash changed.

The rest of the `cc-2.1.173` → `cc-2.1.219` prose diff was **not** grammar-relevant
and is recorded here only so a future reader doesn't re-litigate it: minifier
identifier renames inside the interpolations (`${w53}` → `${fj_}` and friends), "Use
the Agent tool **(if available)**", the `agentType` example changing from `'Explore'`
to `'general-purpose'`, and a new Resume-section sentence about reading
`<transcriptDir>/journal.jsonl` before diagnosing an empty result.

Corpus: [`examples/level-2/tier-the-effort.js`](../examples/level-2/tier-the-effort.js)
— an effort-tiered triage pipeline (skim `low` → root-cause `max` → cross-examine
`high` → digest `low`) — and [`examples/level-2/review-pr.js`](../examples/level-2/review-pr.js),
**promoted** from level 1 for this level. The README hero always sits at the newest
level, so minting one means teaching the hero its new construct and moving it, not
just adding a sample beside it; that promotion is part of the ritual below.

#### Re-captures (same level)

| Capture | Bytes | sha256 (`workflow-tool-description.txt`) | Why it stays level 2 |
| --- | --- | --- | --- |
| [`cc-2.1.220`](../spec/upstream/2026-07-25-cc-2.1.220/) (2026-07-25) | 19581 | `54a255eba06f67ac…` | Four minifier identifier renames inside the prose's interpolations (`${fj_}`→`${bj_}`, `${uj_}`→`${gj_}`, `${dj_}`→`${_j_}`, `${pj_}`→`${yj_}`). Each is 3 characters, so the byte count is unchanged and only the hash moved. Normalize every `${…}` to a placeholder and the two captures are byte-identical; the input schema is untouched. No vocabulary change, so the recognizer is unaffected. |

`RECOGNIZER_LEVEL_CC` tracks the newest baseline (`2.1.220`), not the version the
level was minted at (`2.1.219`) — the level is the primary key, the version is
provenance.

#### Capture surface — the Agent tool (added 2026-07-25, no level change)

A workflow's `agent()` call spawns a **subagent**, so the Agent tool's surface is
part of what a workflow *means*: `opts.agentType` resolves against that tool's
registry, and `opts.model`'s enum lives in its `AgentInput`, not in `WorkflowInput`.
Level 2's own closing footnote already leaned on that fact — and asserted it against
an artifact the baseline never captured. That is also why `fable` reached us by
accident rather than through the gate. Two artifacts close the hole:

| Artifact | Bytes | sha256 |
| --- | --- | --- |
| `agent-tool-description.fragments.txt` | 17282 | `6c7c4751ca45e15b4000db617e7ae013be52b5b6061da84f1d0a82e23cc66ba6` |
| `agent-input-schema.d.ts` | 4154 | `98f41956ca06800972e387697970192f9ca2365a981a34768985ec7b701d20de` |

Captured into [`spec/upstream/2026-07-25-cc-2.1.220/`](../spec/upstream/2026-07-25-cc-2.1.220/),
in place: it is the same install, now pinned more completely, and the two Workflow
artifacts came back byte-identical. The two earlier snapshots predate this pair and
can never be back-filled — those installs are gone.

**This is not a level bump.** A level tracks the vocabulary a workflow *file* may
use, and the recognizer learned nothing here; `requiredLevel ≤ recognizerLevel` is
untouched. Widening what we *pin* is not widening what we *parse*.

**Why `.fragments.txt` and not `-description.txt`.** The Agent tool description is
not stored anywhere — a builder function assembles it. At cc-2.1.220 that is **10
runtime gates** (fork support, background vs. synchronous, plan tier, teammate
context, remote sandbox…) driving **29 branch points** over **60 string/template
literals**, of which 44 are non-empty. So there is no string to slice, and which of
them apply depends on runtime state. Executing the builder to find out is not on the
table. The capture therefore does what the renderer does with a workflow body: parse
it (acorn), and report only what the source literally says — every string and
template literal in source order, one per fragment, each `${…}` collapsed to a
placeholder. Every variant is present; the conditions that select them are not. The
name says so, because a file called `agent-tool-description.txt` would read as a
rendered description, and it is not one.

Finding the builder is where this could go quietly wrong, so it refuses instead of
guessing. Its name is minified, so the capture walks back over *every*
`function <ident>(` within 1 MB of the anchor, parses each, and requires that
**exactly one** encloses the anchor. Taking the nearest match would be the obvious
shortcut and fails silently: if upstream ever nests the anchor-bearing fragment in a
helper while other literals stay in the outer builder, the nearest match is that
helper, and the capture inventories a subtree — yielding an artifact that is short
but perfectly self-consistent, with a valid hash, a valid manifest, and passing
tests. Two enclosing candidates is therefore a "reconcile manually", not a
tie-break. `ts/__tests__/capture-grammar.test.ts` drives that rule and the anchor and
slicing rules against crafted fixtures, since the real binary only exists on a
machine with Claude Code installed and cannot be made to fail on purpose.

**Why one file and not 44.** Fragments have no stable identity upstream, so any
per-file layout has to invent one. Measured against the two edits upstream actually
makes — rewording a fragment, and inserting one at position 22 of 44:

| Layout | Reworded | Inserted |
| --- | --- | --- |
| one file | 1 file, +1/−1 | 1 file, +2 |
| `fragment-07.txt` | 1 file, +1/−1 | **24 files, +54/−53** |
| content-hashed name | 1 file, +1/−1 (rename-detected) | 1 file, +1 |

Numbering is disqualified: an insertion renumbers everything after it, and git reports
two dozen rewritten files instead of one insertion hunk. Content-hashing is *not* —
it diffs as well as one file on both shapes, rename detection included. It loses on
the other two counts. Source order is the only structure this artifact has, and a
directory of hex-named files has none; recovering it needs an index file, which is
the single file again plus 44 satellites. And the artifact exists to answer one
question — did the prose surface move — for which one hash is the whole answer;
44 manifest entries would make the gate reconcile set membership on top of content
for no extra signal.

Naming them semantically would sidestep the order problem, but means deciding which
gate each fragment belongs to and inventing a label — the enclosing variables are
minified (`g`, `m`, `y`, `C`, `T`…), so any such name is ours, not upstream's, and
this project does not paraphrase what it captures.

Capturing the *assembled* variants instead — one file per flag combination — is the
one option that is not merely a trade: choosing a combination means evaluating those
10 gates, which is running the builder.

> **Known noise.** The Workflow prose is hashed *raw* and minified, so any release
> that reshuffles the identifiers inside its `${…}` trips the gate with nothing to
> reconcile (see the re-capture row above). The Agent prose is immune by
> construction — collapsing every interpolation is exactly the normalization
> proposed here, and it had to happen there because that artifact is mostly *code*,
> so a raw slice would churn on essentially every release. Retrofitting it to the
> Workflow artifact is still open, and is deliberately not a free win: it would move
> that artifact's bytes, and the two snapshots whose hashes it would invalidate
> (cc-2.1.173, cc-2.1.219) can no longer be re-captured to match. The cost of the
> normalization either way is not detecting a change that is *purely* an
> interpolation swap — which by construction carries no grammar meaning.

*Not a grammar change, landed alongside:* the Claude 5 family added a fourth model,
so `fable` joined `opus`/`sonnet`/`haiku` in the swatch table. Model names are not
part of the *workflow* grammar (`opts.model` is an unenumerated string in the prose;
the `"sonnet" | "opus" | "haiku" | "fable"` enum lives in the **Agent** tool's
`sdk-tools.d.ts` entry, not the Workflow tool's), so this earns no level — it is a
rendering-fidelity fix, not a vocabulary change. That enum is no longer unpinned,
though: it is captured as of the subsection above, so the next family to appear
should reach `MODEL_SWATCHES` through the gate rather than by observation.

### Level 1 — baseline (`cc-2.1.173`, captured 2026-06-23)

The first pinned grammar — everything the recognizer understood at the time this
ledger opened is, by definition, **level 1**.

| Artifact | Bytes | sha256 |
| --- | --- | --- |
| `workflow-tool-description.txt` | 19078 | `15e8f8554313bd3ceb5ed082ad07fe78e613a80e46bd9d17ca628111db9b8732` |
| `workflow-input-schema.d.ts` | 3064 | `fe6f86e00a7f739fc606aa758a4cc04c17c85a12a5ca30c3d441a190558f44a2` |

Snapshot: [`spec/upstream/2026-06-23-cc-2.1.173/`](../spec/upstream/2026-06-23-cc-2.1.173/).
Its `manifest.json` holds the authoritative hashes; the table above must match it
byte-for-byte.

Delta: *baseline — nothing precedes it.*

## How to reconcile (when upstream drifts)

Claude Code updates land silently: the package upgrades and the embedded grammar can
move with no signal to us. The reconciliation ritual is how we catch that.

1. Run **`npm run check-grammar`** wherever Claude Code is installed. It re-captures
   from the current install and compares the fresh hashes against the latest
   `spec/upstream/` baseline.
   - **Hashes match** → nothing to do; the recognizer is still reconciled.
   - **Hashes differ** → the upstream grammar moved. Inspect the diff:
     - *Incidental wording only* → re-capture, commit the new snapshot, note it stays
       on the current level.
     - *Grammar-relevant change* → teach the recognizer (per
       [`workflow-js-structure.md` §5](./workflow-js-structure.md#5-maintenance-what-a-grammar-change-touches)),
       commit the new snapshot, **mint the next level** with a delta line above, and
       bump the recognizer's `RECOGNIZER_LEVEL` (and `RECOGNIZER_LEVEL_CC`). Then
       **grow the example corpus**: the shipped workflows are versioned by level under
       `examples/level-N/` (today `examples/level-1/`), and each file also declares its
       level in-file (a `* Grammar level: 1` header line). `ts/__tests__/examples.grammar.test.ts`
       enforces that the directory and the stamp agree, that no example *uses* a
       construct newer than it *declares*, and that what it declares is ≤ the
       recognizer's level. After minting level N, add an `examples/level-N/` directory
       whose specimens showcase the new constructs (stamped `Grammar level: N`) — so the
       corpus becomes a versioned record of how the grammar, and its renders, change over
       time, and the lock above stays green. Finally **promote the README hero**
       (`review-pr.js`) to level N as well — the front page advertises the current
       vocabulary, not a subset of it — which means teaching it the new construct,
       `git mv`-ing it and its four renders, repointing the paths listed in `AGENTS.md`,
       and re-tuning the anatomy pins against the moved base.
   - **Anchors moved** (the capture can't find the prose start/end or a named
     interface) → it fails loud with a "reconcile manually" message; the extraction
     itself needs attention before a hash comparison is even meaningful.

This is a **local / dev-machine** ritual: it needs the installed `claude` package to
capture from, which a generic CI runner does not have.

Finding that package is not always as simple as following `claude` on `PATH` —
multiplexers and version managers shadow it with a wrapper script that lives
elsewhere and re-execs the real CLI, and a wrapper's `realpath` is the wrapper, so
walking up from it finds nothing. The capture script therefore tries three
strategies in order: `CLAUDE_CODE_DIR` if set, then the walk-up from `PATH`, then
`npm root -g`. A candidate only counts if it holds **both** capture artifacts, so a
package directory that can't actually be captured from is reported as such instead of
silently passing. (Layouts with no package scaffolding at all — the native
installer's `~/.local/share/claude/versions/<ver>` is a self-contained binary — are
rejected earlier, on the `package.json` test.) If all three miss, the error lists
what was tried; set `CLAUDE_CODE_DIR` to the package root to settle it.

> **Implemented.** `npm run check-grammar` (the `scripts/capture-grammar.mjs --check`
> mode) re-captures from the installed package and compares each artifact's sha256
> against the latest `spec/upstream/` snapshot (the checked-in baseline, read from
> disk) — exit **0** in sync, **non-zero** on any drift, and a loud failure if
> `claude` isn't installed or an anchor moved.
> As noted above, it runs only where the `claude` binary lives, never on a generic CI
> runner. Its CC-independent companion is `ts/__tests__/grammar.test.ts`, which needs
> no install and so is the half that *does* run in ordinary `vitest` CI: it asserts
> the wired vocabulary still matches what the recognizer dispatches, **and** holds
> every committed snapshot to its own manifest (bytes and sha256, in both directions)
> so the baseline is verifiably reproducible offline rather than merely committed.
