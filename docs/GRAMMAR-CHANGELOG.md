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
   the two artifacts that define the grammar's surface, read straight from the
   locally installed package — nothing is executed:
   - **`workflow-tool-description.txt`** — the Workflow tool description prose (the
     authoring contract for `meta` / `agent` / `parallel` / `pipeline` / `phase`),
     extracted as text from the compiled `bin/claude.exe`.
   - **`workflow-input-schema.d.ts`** — the `WorkflowInput` / `WorkflowOutput`
     declarations sliced from the shipped `sdk-tools.d.ts`.

   The snapshot lands dated and version-stamped under
   `spec/upstream/<YYYY-MM-DD>-cc-<version>/`, with a `manifest.json`.

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

### Level 1 — baseline (`cc-2.1.173`, captured 2026-06-23)

The first pinned grammar. Everything the recognizer understands today is, by
definition, **level 1**.

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
       time, and the lock above stays green.
   - **Anchors moved** (the capture can't find the prose start/end or a named
     interface) → it fails loud with a "reconcile manually" message; the extraction
     itself needs attention before a hash comparison is even meaningful.

This is a **local / dev-machine** ritual: it needs the installed `claude` binary to
capture from, which a generic CI runner does not have.

> **Implemented.** `npm run check-grammar` (the `scripts/capture-grammar.mjs --check`
> mode) re-captures from the installed package and compares each artifact's sha256
> against the latest `spec/upstream/` snapshot (the checked-in baseline, read from
> disk) — exit **0** in sync, **non-zero** on any drift, and a loud failure if
> `claude` isn't installed or an anchor moved.
> As noted above, it runs only where the `claude` binary lives, never on a generic CI
> runner. Its CC-independent companion — the lexicon ↔ recognizer consistency test
> (`ts/__tests__/grammar.test.ts`, asserting the wired vocabulary still matches what the
> recognizer dispatches) — needs no install, and so is the half that *does* run in
> ordinary `vitest` CI.
