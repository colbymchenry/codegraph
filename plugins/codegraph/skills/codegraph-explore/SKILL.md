---
name: codegraph-explore
description: >-
  Answer code questions with CodeGraph instead of grep-and-read loops: the
  codegraph_explore MCP tool and the explore, node, query, callers, callees,
  impact, implementations, files and cycles CLI commands. Use when asked how
  something works, who calls a symbol, what a change would break, or how a
  request flows through an indexed codebase.
---

# Exploring code with CodeGraph

Requires an indexed project (`.codegraph/` exists; see `codegraph-setup`).

## Prefer one `codegraph_explore` call

The MCP server exposes a single default tool, `codegraph_explore`. One call
returns the relevant symbols' verbatim source grouped by file, the call paths
between them and a blast-radius summary, including dynamic-dispatch hops
(callbacks, React re-renders, interface to implementation) that grep misses.

Good queries:

- "How does a request reach the database?"
- "How does `checkout` reach `chargeCard`?"
- "Who calls `toValidURL`?" (returns every call site with its enclosing function)
- "src/auth/session.ts" (returns line-numbered current source)

Use it before opening files one by one. Re-read only what the answer did not
include.

Querying another indexed project (a monorepo sub-service or second repo) in
the same session: pass `projectPath`.

Narrower tools (`codegraph_node`, `codegraph_search`, `codegraph_callers`,
`codegraph_callees`, `codegraph_impact`, `codegraph_files`,
`codegraph_status`) are unlisted by default. Enable them with
`CODEGRAPH_MCP_TOOLS=explore,node,search,callers` only if needed.

## CLI equivalents

```bash
codegraph explore "how does login work"
codegraph context "fix login bug" --format markdown
codegraph node UserService           # source + callers, or a file with line numbers
codegraph query UserService --kind class --limit 5
codegraph callers handleRequest --json
codegraph callees handleRequest
codegraph impact parseConfig --depth 2
codegraph implementations Repository
codegraph files --format tree --max-depth 2 --no-tests
codegraph cycles                     # circular imports; exits 1 if any
```

## Before changing code

1. `codegraph impact <symbol>` (or ask `codegraph_explore` about it) to see
   what depends on it.
2. Make the change.
3. Run the tests `codegraph affected` reports (see `codegraph-affected`).

## Library use

```ts
import CodeGraph from '@colbymchenry/codegraph';
const cg = await CodeGraph.open('/path/to/project');
const hits = cg.searchNodes('UserService');
const callers = cg.getCallers(hits[0].node.id);
const ctx = await cg.buildContext('fix login bug', { maxNodes: 20, includeCode: true, format: 'markdown' });
cg.close();
```

Needs Node 22.5+ (built-in `node:sqlite`).
