# CodeGraph Architecture

**Audience:** maintainers extending CodeGraph internals.
**Scope:** the local indexing engine, SQLite graph store, query layer, MCP server,
installer surface, and auto-sync path.

CodeGraph is a local code-intelligence engine for AI coding agents. It turns a
workspace into a SQLite-backed symbol graph, then exposes that graph through CLI,
SDK, and MCP tools. The central product choice is to pay the parsing and
resolution cost once during indexing, so an agent can answer architecture and
flow questions with one graph query instead of many filesystem searches.

---

## High-level shape

```text
              install/configure                  query
Agent config ---------------------> MCP host ------------+
   ^                                launches             |
   |                                                     v
installer targets            codegraph serve --mcp   MCP session(s)
   |                                                     |
   +-----------------------> MCPEngine ------------------+
                              |
                              v
                         CodeGraph facade
                              |
          +-------------------+-------------------+
          |                   |                   |
          v                   v                   v
   ExtractionOrchestrator  ReferenceResolver  Context/Graph queries
          |                   |                   |
          +-------------------+-------------------+
                              |
                              v
                    .codegraph/codegraph.db
                    nodes, edges, files, FTS5
                              ^
                              |
                      FileWatcher / sync
```

The top-level `CodeGraph` class in `src/index.ts` is the composition root for the
engine. It owns:

- a `DatabaseConnection` and `QueryBuilder`;
- an `ExtractionOrchestrator`;
- a `ReferenceResolver`;
- a `GraphQueryManager` and `GraphTraverser`;
- a `ContextBuilder`;
- a cross-process `FileLock`;
- an optional `FileWatcher`.

The CLI in `src/bin/codegraph.ts` is a thin command surface over the same class.
The MCP server in `src/mcp/` is another surface over the same class, with extra
session, daemon, freshness, and output-budget handling.

---

## Data model

The graph is stored in `.codegraph/codegraph.db`. The schema is defined in
`src/db/schema.sql`.

| Table | Purpose |
|---|---|
| `nodes` | Code symbols and file nodes. Examples: `file`, `class`, `struct`, `function`, `method`, `route`, `component`. |
| `edges` | Relationships between nodes. Examples: `contains`, `calls`, `imports`, `extends`, `implements`, `references`, `instantiates`. |
| `files` | Indexed source-file metadata: language, content hash, size, mtime, node count, extraction errors. |
| `unresolved_refs` | References captured during extraction but not yet resolved to concrete target node IDs. |
| `nodes_fts` | FTS5 virtual table for name, qualified-name, docstring, and signature search. |
| `project_metadata` | Advisory version/provenance stamps, including extraction-version metadata. |

The graph is intentionally symbol-oriented, not AST-oriented. Tree-sitter syntax
nodes are an input format. Persisted `Node` and `Edge` records are the stable
query API.

Important invariants:

- A `file` node exists for every indexed file that participates in the graph.
- `contains` edges encode file/type/member containment.
- Cross-file dependency queries use resolved symbol-level edges, not raw import
  declarations alone.
- `unresolved_refs` is a staging area; resolved refs are converted to `edges` and
  then deleted from the unresolved table.
- Heuristic or synthetic relationships use `provenance: 'heuristic'` with
  explanatory metadata instead of pretending to be direct syntax facts.

---

## Indexing lifecycle

Full indexing starts through `CodeGraph.indexAll()` or `codegraph init -i`.

```text
scan files
  |
  v
detect frameworks from file layout/content
  |
  v
load only needed tree-sitter grammars
  |
  v
parse each file, usually in parse-worker
  |
  v
insert file records, nodes, direct edges, unresolved refs
  |
  v
re-detect frameworks against populated DB
  |
  v
framework postExtract passes
  |
  v
batched reference resolution
  |
  v
synthesized dynamic-dispatch edges
  |
  v
SQLite maintenance and metadata stamps
```

`ExtractionOrchestrator` handles scanning, grammar loading, worker management,
per-file parsing, and persistence of extraction results. It deliberately detects
frameworks before parsing so framework-specific extractors can add route or
configuration nodes during the same pass.

`ReferenceResolver` runs after extraction. It resolves imports, calls, type
references, inheritance, framework patterns, path aliases, workspace packages,
and language-specific lookup rules. It uses LRU-bounded caches for file content,
node lookups, import mappings, re-export chains, and known-name prefilters so
large repos do not require loading every node object into memory.

`synthesizeCallbackEdges()` runs after normal resolution in the full-index
batched path. These edges close dynamic-dispatch gaps such as callback stores,
event emitters, framework lifecycle calls, interface dispatch, and C++ override
dispatch. The pass is additive: failure to synthesize must not fail the index.

---

## Incremental sync and freshness

`CodeGraph.sync()` asks the orchestrator to compare the current filesystem state
against the `files` table by path, size, mtime, and content hash. Added and
modified files are re-extracted; removed files are deleted from the graph.

MCP sessions keep the index fresh through three mechanisms:

1. **Connect-time catch-up.** `MCPEngine` starts a background `sync()` after
   opening the project and gates the first tool call on it.
2. **File watcher.** `FileWatcher` uses native OS events and a debounce window to
   trigger incremental `sync()` after edits.
3. **Staleness banners.** If a tool response would include a file still pending
   debounce/indexing, `ToolHandler` prefixes the response with a warning and asks
   the agent to read only that file directly.

The design accepts that there is a short window where the graph can lag the
filesystem. It makes that lag explicit instead of silently returning stale source.

---

## Query surfaces

### CLI

The CLI is the human/operator surface:

- project lifecycle: `init`, `uninit`, `index`, `sync`, `status`, `unlock`;
- graph queries: `query`, `files`, `callers`, `callees`, `impact`, `affected`;
- agent integration: `install`, `uninstall`, `serve --mcp`;
- distribution: `upgrade`.

The CLI prints progress and summaries, but it does not own core behavior. It
delegates to `CodeGraph`.

### SDK

The package entry point exports `CodeGraph` and selected lower-level building
blocks for embedding. SDK consumers can initialize/open a project, index, search,
walk callers/callees, build context, compute impact, and start/stop the watcher.

### MCP

The MCP server is the agent-facing surface. It exposes:

- `codegraph_explore` as the primary tool for architecture, flow, and subsystem
  questions;
- `codegraph_search` for location-only symbol lookup;
- `codegraph_node` for one symbol's details and source;
- `codegraph_callers` and `codegraph_callees` for targeted call queries;
- `codegraph_impact` for change-impact traversal;
- `codegraph_files` for indexed project layout;
- `codegraph_status` for index health.

`MCPEngine` owns the default project instance and watcher. In daemon mode, one
engine serves multiple socket sessions so multiple agent clients share one DB
connection strategy and one OS watch set. This is a resource-control design: MCP
session lifecycle is separate from indexing-engine lifecycle.

---

## Retrieval strategy

CodeGraph has two different retrieval paths:

1. **Symbol search.** `QueryBuilder.searchNodes()` uses exact/name/FTS lookup and
   returns ranked symbol hits.
2. **Context exploration.** `ContextBuilder` and `ToolHandler.handleExplore()`
   combine query term extraction, FTS, exact symbol matching, graph expansion,
   relationship summarization, source slicing, and adaptive output caps.

`codegraph_explore` is intentionally opinionated. It returns source grouped by
file and includes line numbers so the result can serve the same role as a `Read`
tool call. Output budgets scale with project size, but stay below the inline
tool-result ceiling so agents do not have to read an externalized payload back
from disk.

---

## Framework and dynamic-dispatch architecture

Static parsing is not enough for real application flows. CodeGraph closes known
gaps in two layers:

| Layer | When used | Examples |
|---|---|---|
| `FrameworkResolver` | A named reference or file convention can be resolved with framework rules. | Routes to handlers, React components, Django descriptors, React Native bridges. |
| Whole-graph synthesizer | The runtime edge has no named reference at the dispatch site and requires cross-site correlation. | Callback stores, event emitters, lifecycle render calls, C++ override dispatch. |

The resolver layer answers "what does this named thing point to?" The synthesizer
layer answers "what runtime edge is missing even though no direct syntax reference
exists?" Keeping those mechanisms separate makes dynamic coverage extensible
without overloading per-reference resolution.

---

## Installer and agent integration

`src/installer/targets/` contains one `AgentTarget` per supported host. Targets
detect whether an agent is installed, then write the host-specific MCP config.
JSON-shaped hosts share `getMcpServerConfig()`:

```json
{
  "type": "stdio",
  "command": "codegraph",
  "args": ["serve", "--mcp"]
}
```

Codex uses TOML, and each target owns its idempotency and uninstall behavior.
The runtime MCP server delivers usage instructions in its initialize response, so
installer targets should avoid duplicating long tool guidance in host instruction
files.

---

## Error handling and concurrency

Index writes are guarded in two layers:

- an in-process `Mutex`, preventing overlapping operations in one `CodeGraph`
  instance;
- a cross-process `FileLock`, preventing the CLI, MCP server, watcher, or git
  hook from writing the same DB concurrently.

SQLite runs with WAL where available so readers can proceed while a writer is
active. Tool input is length-checked and path-validated before query execution.
MCP handlers support cross-project `projectPath`, but paths are validated before
opening a different project.

Parse failures are recorded as extraction errors for the file where possible.
Worker crashes and timeouts reject the current parse request, restart the worker,
and keep the overall index bounded rather than letting one pathological file
bring down the whole run.

---

## Extension points

Use the smallest extension point that matches the problem:

| Need | Extension point |
|---|---|
| Add a language with a tree-sitter grammar | `src/extraction/grammars.ts`, `src/extraction/languages/<lang>.ts`, tests. |
| Add a file format without a grammar | Custom extractor like Svelte, Vue, Liquid, Razor, MyBatis XML, or DFM. |
| Add framework routes/config edges | `src/resolution/frameworks/<framework>.ts` with `detect`, optional `extract`, `resolve`, `postExtract`. |
| Improve import or path semantics | `src/resolution/import-resolver.ts`, path alias/workspace helpers. |
| Close an unnamed runtime dispatch gap | `src/resolution/callback-synthesizer.ts`. |
| Change agent-visible output | `src/mcp/tools.ts` and, for shared context generation, `src/context/`. |
| Change DB shape | `src/db/schema.sql` plus migrations and query updates. |

Do not add a framework rule to the synthesizer if a named unresolved reference
already exists. Do not add a resolver rule if the edge requires whole-graph
correlation and has no concrete reference name.

---

## Current trade-offs

- **Reachability over exact runtime instance precision.** Some synthesized edges
  are conservative over-approximations. This is acceptable for "what could be
  affected?" and architecture exploration, but should be fan-out capped.
- **Local SQLite over centralized service.** This keeps source private and setup
  simple, but every workspace owns its own index lifecycle.
- **Tree-sitter portability over compiler-grade semantics.** CodeGraph is fast
  and cross-platform, but it does not type-check like Clang, TypeScript, Rustc,
  or javac.
- **Primary explore tool over many narrow tools.** This matches agent behavior:
  one rich answer generally beats a sequence of search/read calls. The cost is
  more logic in `handleExplore()`.
- **Best-effort framework coverage.** Framework resolvers improve practical
  flows, but each framework shape needs explicit tests and real-repo validation.

---

## Related documents

- [`callback-edge-synthesis.md`](./callback-edge-synthesis.md)
- [`dynamic-dispatch-coverage-playbook.md`](./dynamic-dispatch-coverage-playbook.md)
- [`adaptive-explore-sizing.md`](./adaptive-explore-sizing.md)
- [`cpp-graph-generation.md`](./cpp-graph-generation.md)
