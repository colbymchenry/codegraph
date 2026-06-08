---
title: The Knowledge Graph
description: The node and edge kinds the graph is built from.
---

CodeGraph stores three things: **nodes** (symbols and files), **edges** (relationships between them), and **files**. Every node and edge carries an exact `kind`, drawn from a fixed vocabulary so queries are consistent across languages.

## Node kinds

`file`, `module`, `class`, `struct`, `interface`, `trait`, `protocol`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`.

## Edge kinds

`contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.

## Provenance

Most edges come straight from the AST. A few — at dynamic-dispatch boundaries that static parsing can't follow — are **synthesized** and marked with `provenance: 'heuristic'` plus the wiring site that created them. These are surfaced inline in `explore` and the `node` trail, so an agent can see exactly where a connection came from.

## Querying it

- **Search** symbols by name (FTS5).
- **Callers / callees** walk the call graph one hop at a time.
- **Impact** computes the transitive radius affected by a change.
- **Explore** returns source for several related symbols grouped by file, plus the call path among them, in one call.

See the [CLI](/codegraph/reference/cli/) and [MCP Server](/codegraph/reference/mcp-server/) references for how to run these.
