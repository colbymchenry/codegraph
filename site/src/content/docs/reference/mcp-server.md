---
title: MCP Server
description: The tools CodeGraph exposes to AI agents over MCP.
---

CodeGraph runs as a [Model Context Protocol](https://modelcontextprotocol.io/) server. Agents configured by the installer launch it automatically — you don't start it by hand:

```bash
codegraph serve --mcp
```

The tools stay available even when the server's root has **no** `.codegraph/` index — a monorepo root, or a session that started before you ran `codegraph init`. In that case call `codegraph_projects` to list the projects that are indexed, then pass one of their paths as `projectPath`. A path with no index returns clean guidance to use built-in tools, and indexing stays your decision.

## Two tools by default: `codegraph_explore` and `codegraph_projects`

By default the server exposes two tools:

- **`codegraph_explore`** is Read-equivalent: give it a natural-language question or a bag of symbol and file names, and it returns the **verbatim, line-numbered source** of the relevant symbols grouped by file — the same shape the `Read` tool gives you — plus the call paths between them (including dynamic-dispatch hops like callbacks, React re-render, and JSX children that grep can't follow) and a blast-radius summary of what depends on them. One call usually answers the whole question.
- **`codegraph_projects`** lists every CodeGraph project registered on the machine — its path, when it was last indexed, file/node/edge counts, and whether the index is up to date with the working tree — so an agent working outside a project can discover the ones it can query by `projectPath`.

Keeping the query surface to one strong tool is deliberate. Measured agent behavior showed that one well-aimed tool steers agents to a direct answer better than a menu of narrower ones — fewer mis-picks — and agents reach for it both when answering questions and while editing code. `codegraph_projects` is the one question `codegraph_explore` cannot answer at all: which *other* projects exist.

Projects are registered by `codegraph init` and removed by `codegraph uninit`, in a machine-wide registry at `~/.codegraph/projects.json` (set `CODEGRAPH_PROJECTS_PATH` to use a different file). The same listing is available from the CLI as `codegraph projects`.

## The other tools

Seven more tools exist and stay fully functional, but are **unlisted by default** — everything they return already arrives inline on a `codegraph_explore` response (its blast-radius section, the relationship map, a symbol's body and its callee list):

| Tool | Purpose |
|---|---|
| `codegraph_node` | One symbol's source + caller/callee trail, or a whole file read with line numbers (Read-parity). Returns every overload's body for an ambiguous name. |
| `codegraph_search` | Find symbols by name across the codebase (locations only) |
| `codegraph_callers` | Find what calls a function |
| `codegraph_callees` | Find what a function calls |
| `codegraph_impact` | Analyze what code is affected by changing a symbol |
| `codegraph_files` | Get the indexed file structure (faster than filesystem scanning) |
| `codegraph_status` | Check index health and statistics |

Re-enable any of them with the `CODEGRAPH_MCP_TOOLS` environment variable — a comma-separated allowlist of short names that replaces the default:

```bash
CODEGRAPH_MCP_TOOLS=explore,node,search,callers
```

Each also has a CLI equivalent (`codegraph node` / `query` / `callers` / `callees` / `impact` / `files` / `status`) for scripts and non-MCP harnesses.

## How agents should use it

CodeGraph *is* the pre-built search index. For "how does X work?", architecture, a flow ("how does X reach Y"), or where-is-X questions — and while editing code — an agent should answer with `codegraph_explore` and stop, typically with **zero file reads**, rather than re-deriving the answer with `grep` + `Read`. A direct CodeGraph answer is one to a few calls; a grep/read exploration is dozens.

The MCP server delivers this guidance to the main agent automatically, in the MCP `initialize` response. Because subagents and non-MCP harnesses never see that response, the installer also writes a short marker-fenced section into each agent's instructions file pointing at the `codegraph explore` CLI equivalent.
