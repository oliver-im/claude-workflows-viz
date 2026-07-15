# Usage

`claude-workflows-viz` renders a Claude Code **dynamic workflow** `.js` file's
static structure as a diagram — SVG primary, PNG rasterized from it — and
**never executes the workflow**. This doc is the **operator surface**: how to
install it, drive the CLI, build it from source, and cut a release. For the
*what/why* see [`design-context.md`](./design-context.md); for the shape of the
input file see [`workflow-js-structure.md`](./workflow-js-structure.md).

## Install

```sh
npm install -g claude-workflows-viz
```

Or run it without installing:

```sh
npx claude-workflows-viz <workflow.js>
```

Runtime: Node ≥ 20.

## CLI

```sh
claude-workflows-viz <workflow.js> [-o <out>] [--format svg|png|html|json] [--view workflow|topology|phases] [--scale <n>] [--open] [--share] [--include-source]
```

| Option | Description |
| --- | --- |
| `-o, --out <file>` | Write the diagram to this path. Omit it and SVG/HTML/JSON stream to **stdout**. |
| `--format <fmt>` | `svg` (default), `png`, `html`, or `json`. Inferred from `--out`'s extension when omitted. `json` dumps the static analysis (meta + body topology) for tooling/skills. |
| `--view <view>` | `workflow` (default) draws phase context beside the agent graph; `topology` renders the inferred graph only; `phases` renders the meta-only cards. |
| `--scale <n>` | PNG rasterization scale, `0 < n ≤ 10` (default `2`). Higher is sharper and larger; lower is smaller. PNG only — SVG/HTML are vector. |
| `--open` | Open the rendered output in your default app after writing. |
| `--share` | Upload the rendered SVG (or PNG when `--format png` is selected) as a secret GitHub gist; requires the GitHub CLI and `gh auth login`. Use with `--view`; omit `--out` and `--open`. |
| `--include-source` | With `--share`, also upload the original workflow as `workflow.js`. The flag is opt-in because source may contain sensitive prompts or instructions. |
| `-v, --version` | Print the version. |

### Output routing

- An explicit `--out` always wins; the tool prints `Wrote <path>` to **stderr**.
- With no `--out`, text formats (`svg`/`html`/`json`) stream to **stdout** so the
  tool composes in pipelines. A `png` is binary and can't stream, so an unrouted
  PNG is written to a derived `./<stem>.png`.
- `--open` forces a real file (a temp file when `--out` is absent), then opens it.
- A file that needs a newer grammar level — or awaits an unrecognized
  orchestration call — prints a one-line **stderr** warning and still renders
  (exit 0). See [`GRAMMAR-CHANGELOG.md`](./GRAMMAR-CHANGELOG.md).

### Examples

```sh
# SVG to stdout (composable)
claude-workflows-viz your-workflow.js > diagram.svg

# SVG to a file
claude-workflows-viz your-workflow.js -o diagram.svg

# PNG — format inferred from the .png extension
claude-workflows-viz your-workflow.js -o diagram.png

# Render a PNG and open it immediately
claude-workflows-viz your-workflow.js --format png --open

# Dump the static analysis for tooling / the readable-diagrams authoring pass
claude-workflows-viz your-workflow.js --format json | jq .topology.steps

# Share the rendered workflow as an SVG gist
claude-workflows-viz your-workflow.js --share

# Share a PNG instead, and include the original workflow source
claude-workflows-viz your-workflow.js --share --format png --include-source
```

Sharing creates a secret (unlisted, not access-controlled) gist containing the
rendered image for the selected view. SVG is the default; use `--format png`
when a consumer does not preview SVG well. The original workflow source is
uploaded only with `--include-source`; review it for sensitive content before
sharing.

A sample workflow ships with the package. From a clone of this repo:

```sh
claude-workflows-viz examples/level-1/review-pr.js --open
```

After a global install, reference it where npm placed it:

```sh
claude-workflows-viz "$(npm root -g)/claude-workflows-viz/examples/level-1/review-pr.js" --open
```

The bundled workflows are catalogued in [`examples/README.md`](../examples/README.md).

## From source

```sh
npm install
npm run build      # bundles ts/cli.ts -> dist/cli.js
npm test
node dist/cli.js examples/level-1/review-pr.js -o review.svg
```

`dist/` is gitignored and built on demand (also rebuilt on `pretest`, and on
`prepack` so the npm tarball always carries a fresh bundle). Other scripts:
`npm run typecheck` (`tsc --noEmit`), `npm run regen-examples` (rebuild the
committed corpus renders), and `npm run check-grammar` (the upstream-drift check
— needs a local Claude Code install, so it is *not* run in CI).

## Releasing

Published to npm on tag push by
[`.github/workflows/release.yml`](../.github/workflows/release.yml), via npm
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no stored
token) with [provenance](https://docs.npmjs.com/generating-provenance-statements).
Cut a release:

```sh
npm version patch        # or minor / major / an explicit 0.1.1 — bumps package.json, commits, tags
git push origin main     # land the bump commit
git push origin v0.1.1   # push the tag → CI guards the version, runs the gate, publishes, opens a Release
```

**One-time bootstrap** (Trusted Publishing can't perform the very first publish of
a new name):

1. `npm publish --access public` locally to create `claude-workflows-viz` on npm.
   (No `--provenance` here — it requires a CI runner with OIDC; the workflow adds
   it to every release after this one.)
2. On npmjs.com → the package → *Settings → Trusted Publisher* → GitHub Actions,
   repo `oliver-im/claude-workflows-viz`, workflow `release.yml`.

After that, the tag-push flow above is fully hands-off.
