# claude-workflows-viz

Render a Claude Code **dynamic workflow** `.js` file's static structure into a clean diagram — SVG primary, PNG rasterized from it.

![A workflow rendered by claude-workflows-viz](examples/review-pr.png)

Dynamic workflows are JavaScript files that begin with `export const meta = { name, description, phases }` and then orchestrate subagents in the body. `claude-workflows-viz` reads the declarative `meta` block — **without ever executing the workflow** — and draws its phase flow. The `meta` is read straight off the parsed AST as static data: no `eval`, no `vm`, no `import()`, and no headless browser.

> v1 renders the `meta` block (name, description, optional "when to use", and the phases with their per-phase model). Visualizing the imperative body's agent graph is future work.

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
claude-workflows-viz <workflow.js> [-o <out>] [--format svg|png|html] [--open]
```

| Option | Description |
| --- | --- |
| `-o, --out <file>` | Write the diagram to this path. Omit it and SVG/HTML stream to **stdout**. |
| `--format <fmt>` | `svg` (default), `png`, or `html`. Inferred from `--out`'s extension when omitted. |
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

Each phase badge is colored by its `model`: opus, sonnet, and haiku each get a swatch — matched even inside a full id like `claude-opus-4-8` — and any other model falls back to a neutral badge.

## How it works

1. Parse the file with [acorn](https://github.com/acornjs/acorn) and locate the top-level `export const meta`.
2. Evaluate **only** that object as a static literal — every executable construct (calls, identifiers, getters, spreads, template expressions) is rejected, never run. This is what makes "never execute the workflow" hold.
3. Validate the result with [zod](https://zod.dev), lay out the cards, and emit SVG.
4. For `--format png`, rasterize the SVG with [`@resvg/resvg-js`](https://www.npmjs.com/package/@resvg/resvg-js) — a native renderer, no browser.

## From source

```sh
npm install
npm run build      # bundles ts/cli.ts -> dist/cli.js
npm test
node dist/cli.js examples/review-pr.js -o review.svg
```

## Status

v1. Renders the `meta` block to SVG/PNG (HTML is a thin wrapper for browser viewing). Out of scope for v1, on the roadmap: parsing the imperative body into an agent graph, a real layout engine, and a trace mode that renders an actual run.
