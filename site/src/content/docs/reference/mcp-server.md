---
title: MCP Server
description: The tools CodeGraph exposes to AI agents over MCP.
---

CodeGraph runs as a [Model Context Protocol](https://modelcontextprotocol.io/) server. Start it with:

```bash
codegraph serve --mcp
```

Agents configured by the installer launch this automatically. When a `.codegraph/` index exists, the agent uses the focused default tool below.

## Tools

| Tool | Purpose |
|---|---|
| `codegraph_explore` | Return source for several related symbols grouped by file, plus a relationship map, in one call |

`codegraph_node`, `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_files`, and `codegraph_status` remain implemented but are not listed by default. Set `CODEGRAPH_MCP_TOOLS` to change the exposed MCP surface:

| Value | Exposed tools |
|---|---|
| unset or `default` | `explore` |
| `compact` | `explore,node,search` |
| `core` | `explore,node,search,callers` |
| `full` | every defined MCP tool |
| custom list | e.g. `explore,node,search,callers,impact` |

## How agents should use it

CodeGraph *is* the pre-built search index. For "how does X work?", architecture, trace, or where-is-X questions, an agent should answer in a handful of CodeGraph calls and stop — typically with **zero file reads** — rather than re-deriving the answer with `grep` + `Read`. A direct CodeGraph answer is a handful of calls; a grep/read exploration is dozens.

The installer writes this guidance into each agent's instructions file automatically.
