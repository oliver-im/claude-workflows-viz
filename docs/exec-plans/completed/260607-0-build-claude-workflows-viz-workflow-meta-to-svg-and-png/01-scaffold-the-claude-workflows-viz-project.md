# Unit 01 — Scaffold the claude-workflows-viz project
**Blocked by:** none**Agents involved:** main only**Topology:** none
## Summary

Stand up a new standalone TypeScript CLI project, cribbing planview's build/CLI/test scaffolding, with a stubbed command surface so `--help` works and `npm run build`/`npm test` are green.

### Tasks
- Create a new project directory `claude-workflows-viz/` as a **new git repo, sibling to planview** (not a subdir — this is the split we discussed).
- `package.json`: name `claude-workflows-viz`, `type: module`, `bin: { "claude-workflows-viz": "dist/cli.js" }`, engines node ≥ 20. deps: `commander`, `zod`, `@resvg/resvg-js`, `acorn`. devDeps: `esbuild`, `typescript`, `vitest`, `@types/node`. Scripts mirror planview: `build` (esbuild), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `pretest` → build.
- `scripts/build.mjs`: adapt planview's (esbuild bundle `ts/cli.ts` → `dist/cli.js`; platform node, target node20, esm; shebang + `createRequire` banner; version `define`; `chmod 755`).
- `tsconfig.json`, `vitest.config.ts`: copy planview's.
- `ts/cli.ts`: commander skeleton — `.name("claude-workflows-viz")`, default command `<workflow>` with options `-o, --out <file>`, `--format <svg|png|html>` (default `svg`), `--open`. Action is a stub until Unit 04.
- `README.md` stub: one-paragraph what/why + usage placeholder.

### Acceptance
- `npm install && npm run build` produces an executable `dist/cli.js`.
- `node dist/cli.js --help` lists the command + options; `--version` works.
- `npm test` runs (a trivial smoke test is fine).

### Notes
- The stub action is an **intentional forward-reference** — wired end-to-end in Unit 04. A reviewer seeing the stub here should expect that.
- Set up `bin` + shebang now so `npx`/global install works from the start (the "easy install" requirement).

## Review pipeline

- [ ] `/code-review`
---
See `progress.md` for the cursor and overall plan state.
