---
name: codegraph-usage
description: Community field guide for working with CodeGraph effectively — when to reach for it, which tool answers which question, known gotchas and workarounds, and what CodeGraph is NOT for. Use when working in a repo that has a .codegraph/ index, or when CodeGraph tool calls return confusing or incomplete results.
---

# CodeGraph usage — community field guide

CodeGraph is a local SQLite knowledge graph of every symbol, call edge, and
file in an indexed project. One query returns verbatim line-numbered source
plus the call paths between symbols and a blast-radius summary — replacing a
grep + read loop with a single round-trip.

This skill collects usage patterns, gotchas, and workarounds reported by real
users. It complements (does not replace) the MCP server instructions.

## When to reach for CodeGraph

- "How does X work?" / "Where is X defined?" / "What happens when X runs?"
- Before editing a symbol: get its source, callers, and blast radius in one call.
- Tracing a flow between two points: name both endpoints in one query
  (e.g. `mutateElement renderScene`) — it finds the path, including
  dynamic-dispatch hops (callbacks, React re-renders) grep can't follow.
- Impact assessment before a refactor, when answering "is this safe to change?",
  or when evaluating a PR's risk — not only when you are the one refactoring.

## When NOT to reach for CodeGraph

- **Semantic/conceptual search.** The graph knows calls, imports, and
  definitions — structure, not meaning. "Find code conceptually similar to X"
  or "where do we handle billing edge cases?" are not its job; use your own
  reasoning over `explore` results, or plain search.
- **Unindexed content.** Configs, docs, lockfiles, data files, generated code
  — use Read/Grep for those.
- **Trivial single-file tasks.** If you already know the exact file and line
  ("fix the typo in README", "bump the version string"), calling CodeGraph
  first adds a round-trip for nothing. A quick edit does not need a graph.
- **Correctness validation.** The graph has no type checking or test running.
  The compiler, test suite, and linter still own "is this right?" — CodeGraph
  supplements them with structural context.

## Which tool answers which question

The default MCP surface is `codegraph_explore` alone; the narrower tools below
are available via the CLI (`codegraph <command>`) and re-enablable over MCP
with `CODEGRAPH_MCP_TOOLS`.

| You want to know | Use | Not |
|---|---|---|
| Almost anything: how X works, where X is, survey an area | `explore` | grep + read loop |
| One symbol's source + direct callers | `node` | reading the whole file |
| "What calls X?" (direct, one hop) | `callers` | `impact` |
| "What does X call?" | `callees` | reading X's body and grepping each name |
| "What depends on X **transitively**?" — blast radius | `impact` | chaining `callers` by hand |
| "Which tests are affected by these changed files?" | `affected` | running the full suite to find out |
| File/module layout of an area | `files` | `ls -R` + reading each file |
| Symbol lookup by name/kind | `query` | grep |

**`impact` vs `callers` is the one people mix up:** `callers` is one hop;
`impact` walks the graph transitively and covers dependents that manual
tracing misses. If the question is "what could break?", it's `impact`.

## Gotchas & workarounds (community-reported)

### Don't over-call explore on small tasks
One `explore` call usually answers the whole question — treat the source it
returns as already read. If the task is small and the first call answered it,
stop. Repeated exploratory calls on a task that needed none make sessions
slower and burn tokens (reported against agent harnesses that call
before every minor edit). Rule of thumb: call when you have a genuine
structural question, not as a reflex before every change.

### Trust results — don't re-verify with grep
Results come from a full AST parse. Re-checking them with grep is slower,
less accurate (grep can't see dynamic dispatch), and wastes context. The one
exception is the staleness banner, below.

### The staleness banner is per-file, not global
When a response starts with "⚠️ Some files referenced below were edited since
the last index sync…", only the **listed** files are stale — Read those
directly; keep trusting the graph for every file not listed. The rarer
"auto-sync is DISABLED" banner means the whole index is frozen — Read
directly until it's resolved.

### Overloaded / same-named symbols
A bare name that exists in several places returns every matching definition.
Disambiguate by adding the file path or a neighboring symbol to the query
rather than picking the first result.

### Monorepos: pass projectPath
If the MCP server started somewhere with no `.codegraph/` of its own, tools
still work per project — pass `projectPath` pointing into any directory that
has an index. No restart needed after a new `codegraph init`.

### Containers & subagents: use the CLI, skip MCP
The full CLI works standalone with no MCP server: `codegraph explore`,
`node`, `query`, `callers`, `callees`, `impact`, `affected` — same output as
the MCP tools. If your agent runs commands in a container, install codegraph
in the container and call the CLI against the container's filesystem; no
host/container MCP wiring needed. Keep the index fresh with `codegraph sync`
(or a git hook) since the watcher may not run there. Add `--json` to `query`,
`callers`, `callees`, and `impact` for machine-readable output.

### Index freshness outside agent sessions
The file watcher keeps the graph current (~1s lag) during normal sessions.
When scripting against the index (CI, hooks, containers), run
`codegraph sync` first — an incremental update, cheap. `codegraph index` is
a full rebuild and only needed when things look wrong.

### Not indexed? Stop asking
If a tool reports no `.codegraph/` for a project, stop calling CodeGraph
there for the rest of the session and use built-in tools. Indexing is the
user's call — suggest `codegraph init` if relevant, don't run it yourself.

## Contributing to this skill

This file is built from user experience. Hit an edge case, a misuse pattern,
or a workaround worth sharing? PRs welcome — add a short entry under
"Gotchas & workarounds" with the symptom, the cause if known, and the
workaround. Date-stamp entries tied to a specific version (behavior may be
fixed later).
