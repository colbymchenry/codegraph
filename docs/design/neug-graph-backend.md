# Design: NeuG graph database backend

**Status:** SHIPPED — the NeuG backend is gated behind
`codegraph init --backend neug`. SQLite remains the default.

**Motivation:** replace SQLite's relational graph simulation with a native
property-graph store that supports Cypher queries and CSR-optimized traversal,
while keeping full backward compatibility.

---

## TL;DR for a new session

CodeGraph can now store its knowledge graph in NeuG instead of SQLite.
`NeuGQueryBuilder` implements the same public API as `QueryBuilder` via
duck typing — all CLI commands and MCP tools work unchanged on either backend.
The NeuG backend additionally exposes `executeCypher()` and the
`codegraph cypher` CLI subcommand for arbitrary Cypher queries.

**Key files:**
- `src/db/neug-backend.ts` — `NeuGQueryBuilder` + `NeuGConnectionWrapper`
- `src/db/index.ts` — `NeuGDatabaseConnection` + backend selection
- `src/index.ts` — `CodeGraph.executeCypher()` public method
- `src/bin/codegraph.ts` — `cypher` CLI subcommand
- `__tests__/neug-backend.test.ts` — 61 integration tests

---

## Why: SQLite as a graph store

CodeGraph models code as a **property graph** — nodes (symbols) and edges
(calls, imports, extends, etc.) with typed properties. SQLite stores this in
two flat tables (`nodes`, `edges`) with B-tree indexes.

This works, but has two inherent limitations:

### 1. Multi-hop traversal = N rounds of SQL

`GraphTraverser.traverseBFS()` does application-level BFS: each layer calls
`getOutgoingEdges(nodeId)` → `SELECT * FROM edges WHERE source = ?`. An N-hop
path requires N separate SQL queries plus application-level queue management.

SQLite has no native variable-length path operator — `WITH RECURSIVE` CTEs
exist but are awkward for graph patterns and not used in the codebase.

### 2. No graph query language

Questions like "all paths from A to B", "all nodes within 3 hops of X", or
"all classes implementing interface Y with their methods" cannot be expressed
in a single SQL statement. They require multiple queries and application-level
assembly. The MCP tool set (search/callers/callees/impact/explore) covers the
common cases but cannot expose arbitrary structural queries.

---

## What: NeuG

[NeuG](https://github.com/alibaba/neug) is a lightweight, embeddable graph
database.

Key properties relevant to CodeGraph:

1. **CSR-optimized storage** — Compressed Sparse Row format for adjacency,
   making neighbor lookups O(1) random access rather than B-tree index scans.

2. **Industry-standard Cypher** — Declarative graph pattern matching. Multi-hop
   paths, variable-length traversal, and complex structural patterns in a single
   query.

3. **Lightweight & embeddable** — Single-process, no external server. The
   `neug` npm package ships platform-specific native binaries (macOS ARM64,
   Linux x86_64, Linux ARM64). Incremental updates via WAL-like mechanism.

4. **Native C++ extension framework** — Graph algorithms (Connected Components,
   PageRank, ShortestPath, Louvain community detection etc.) can be added as extensions without
   modifying CodeGraph. These are planned for upcoming NeuG releases.

---

## How: implementation

### Duck-typing the QueryBuilder interface

`NeuGQueryBuilder` implements every public method of `QueryBuilder` with
equivalent Cypher queries. CodeGraph's facade (`src/index.ts`) casts it:

```typescript
this.queries = new NeuGQueryBuilder(conn) as unknown as QueryBuilder;
```

All downstream consumers (`GraphTraverser`, `GraphQueryManager`,
`ContextBuilder`, MCP tools, CLI commands) work unchanged.

### Schema

NeuG uses a labeled property graph schema:

```cypher
CREATE NODE TABLE CodeNode (id STRING PRIMARY KEY, kind STRING, name STRING, ...)
CREATE NODE TABLE CodeFile (path STRING PRIMARY KEY, ...)
CREATE NODE TABLE UnresolvedRef (id STRING PRIMARY KEY, ...)
CREATE NODE TABLE ProjectMeta (key STRING PRIMARY KEY, ...)
CREATE NODE TABLE SchemaVersion (version STRING PRIMARY KEY, ...)
CREATE REL TABLE CodeEdge (FROM CodeNode TO CodeNode, kind STRING, metadata STRING, ...)
```

The schema mirrors SQLite's approach: a single `CodeEdge` relationship table
with a `kind` property distinguishes all 7 edge kinds (calls, contains,
references, imports, instantiates, extends, implements). This keeps the
duck-typing straightforward — both backends use the same logical model.

### Backend selection

```
codegraph init --backend neug     # creates .codegraph/codegraph.neug/
codegraph init                    # creates .codegraph/codegraph.db (SQLite, default)
```

On `CodeGraph.open()`, the presence of `codegraph.neug/` vs `codegraph.db`
determines which backend is used. Both can coexist in the same `.codegraph/`
directory but only one is active.

### New capabilities (NeuG-only)

- `codegraph cypher <query>` CLI subcommand — execute arbitrary Cypher,
  output as tab-separated table or `--json`
- `CodeGraph.executeCypher(query, params?)` — programmatic API

---

## Testing

61 integration tests in `__tests__/neug-backend.test.ts` cover every
`QueryBuilder` method:

- Node CRUD (insert, update, delete, batch, query by name/kind/file/qualified name)
- Edge CRUD (insert, batch, delete, outgoing/incoming/between-nodes)
- File operations (upsert, delete, stale detection)
- Metadata (set, get, getAll)
- Unresolved references (full lifecycle: insert, query, batch, delete by node/name/specific)
- Search (FTS-like CONTAINS, exact name, substring)
- Stats (getStats, getNodeAndEdgeCount)
- Status methods (getDominantFile, getTopRouteFile, getRoutingManifest)
- Graph traversal (BFS, getCallers, getCallees, getImpactRadius via GraphTraverser)
- Raw Cypher execution (executeCypher)

Tests run outside vitest due to NeuG's C++ runtime incompatibility with
vitest's worker pool (glog double-initialization). Run via:

```bash
npm run test:neug
```

---

## Current status

- All CLI commands and MCP tools verified working on NeuG backend
- Validated on CodeGraph's own codebase (2,761 nodes, 12,355 edges)
- Platform binaries: macOS ARM64 (shipping), Linux x86_64 and Linux ARM64
  (planned for upcoming release)
