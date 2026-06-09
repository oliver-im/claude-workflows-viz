# Unit 02 — Extract and validate the workflow `meta` block
**Blocked by:** 01-scaffold-the-claude-workflows-viz-project**Agents involved:** main only**Topology:** none
## Summary

Parse a workflow `.js` file and extract ONLY the `meta` object literal — without executing the module body — then validate it into a typed model with zod.

### Tasks
- `ts/extract-meta.ts`: read the file; parse to an AST with `acorn`; locate the `export const meta = <ObjectExpression>` initializer; evaluate ONLY that object expression in a sandbox (`node:vm` `runInNewContext` on the isolated literal). Do **NOT** `import()` or run the module — the body has top-level `await agent(...)` against undefined globals and will throw.
- `ts/model.ts`: zod schema + types. `Meta = { name: string; description: string; whenToUse?: string; phases: Phase[] }`, `Phase = { title: string; detail?: string; model?: string }`. Normalize missing `phases` → `[]`. Friendly errors for: no `meta` export, `meta` not an object literal, missing `name`/`description`.
- `ts/__tests__/extract-meta.test.ts` + fixtures under `ts/__tests__/fixtures/`: (a) full workflow with name/description/phases/models; (b) no `phases`; (c) a body with top-level `await agent(...)` to undefined globals — assert extraction still succeeds (proves the body is never executed); (d) malformed/missing-meta — assert a clear error.

### Acceptance
- Tests pass; the throwing-body fixture parses cleanly; invalid inputs yield clear, typed errors (not stack traces).

### Notes
- Keep the extractor pure (string in → model out) so the core path is unit-testable without filesystem access.

## Review pipeline

- [ ] `/code-review`
---
See `progress.md` for the cursor and overall plan state.
