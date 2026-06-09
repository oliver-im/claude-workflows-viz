# claude-workflows-viz

Render a Claude Code **dynamic workflow** `.js` file's static structure into a pretty diagram — SVG primary, PNG rasterized from it.

Dynamic workflows are JavaScript files that begin with `export const meta = { name, description, phases }` and then orchestrate subagents in the body. `claude-workflows-viz` reads the declarative `meta` block — **without executing the workflow** — and draws its phase flow. (v1 renders `meta` only; visualizing the imperative body's agent graph is future work.)

It emits SVG directly (no Mermaid, no headless browser) and rasterizes to PNG with [`@resvg/resvg-js`](https://www.npmjs.com/package/@resvg/resvg-js).

## Usage

```
claude-workflows-viz <workflow.js> [-o <out>] [--format svg|png|html] [--open]
```

_Usage examples and a rendered sample land in Unit 05._

## Status

v1, in progress. See the build plan (units): scaffold → extract `meta` → render SVG → rasterize PNG + wire CLI → sample/docs.
