# Documentation

| Document | Audience | Contents |
|---|---|---|
| [Usage](usage.md) | Users / operators | Install, the CLI (flags, output routing, examples), building from source, and releasing |
| [Workflow JS structure](workflow-js-structure.md) | Both | The **input** file's shape — the `meta` block and the body constructs the tool reads, with a maintenance edit-map |
| [Readable diagrams](readable-diagrams.md) | Authors | The prose-authoring pass — how each caption is derived, so you edit the right string to make a cryptic diagram read clearly |
| [Glossary](glossary.md) | Both | The two vocabularies (workflow grammar vs. tool internals) and the JS → tree IR → geometry → pixels bridge |
| [Grammar changelog](GRAMMAR-CHANGELOG.md) | Both | The grammar-level ledger and the upstream-drift reconciliation ritual |
| [Design context](design-context.md) | Both | The *why* — decisions, rejected alternatives, prior art, roadmap, and the render evolution |

Install, the CLI, building from source, and releasing all live in
[Usage](usage.md). Architecture and the "when implementing" guarantees live in
[`AGENTS.md`](../AGENTS.md); the prose-authoring pass — how to make a cryptic
diagram read clearly — is [Readable diagrams](readable-diagrams.md). The
bundled workflows are catalogued in [`examples/README.md`](../examples/README.md).
Completed build-plan history is under
[`exec-plans/completed/`](./exec-plans/completed/).
