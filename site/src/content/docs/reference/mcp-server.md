---
title: MCP Server
description: The tools CodeGraph exposes to AI agents over MCP.
---

CodeGraph runs as a [Model Context Protocol](https://modelcontextprotocol.io/) server. Agents configured by the installer launch it automatically — you don't start it by hand:

```bash
codegraph serve --mcp
```

The server introduces itself with a display name, CodeGraph, and its logo, so an agent or editor that shows them, like the Codex app, lists it by name and logo.

When a `.codegraph/` index exists, the agent gets the tool below. It's listed in a workspace with **no** index of its own too: a call can name any indexed project — a service inside a monorepo, say — with its `projectPath` argument, and for a project that isn't indexed, CodeGraph tells the agent to carry on with its built-in tools. Indexing stays your decision.

## One tool by default: `codegraph_explore`

By default the server exposes a **single tool**, `codegraph_explore`. It's Read-equivalent: give it a natural-language question or a bag of symbol and file names, and it returns the **verbatim, line-numbered source** of the relevant symbols grouped by file — the same shape the `Read` tool gives you — plus the call paths between them (including dynamic-dispatch hops like callbacks, React re-render, and JSX children that grep can't follow) and a blast-radius summary of what depends on them. One call usually answers the whole question.

When the query names something the index has never seen — a name written the way code is, like `ChangelogParser` or `build_report` — the answer lists those names at the top, ahead of the code, and points to `codegraph status` and to how a folder CodeGraph skips by default [can be included](/codegraph/getting-started/configuration/#excluding-or-including-more). Code named in Chinese, Japanese or Korean is found too, and the call paths follow it.

Exposing a single strong tool is deliberate. Measured agent behavior showed that one well-aimed tool steers agents to a direct answer better than a menu of narrower ones — fewer mis-picks — and agents reach for it both when answering questions and while editing code.

## The other tools

Seven more tools exist and stay fully functional, but are **unlisted by default** — everything they return already arrives inline on a `codegraph_explore` response (its blast-radius section, the relationship map, a symbol's body and its callee list):

| Tool | Purpose |
|---|---|
| `codegraph_node` | One symbol's source + caller/callee trail, or a whole file read with line numbers (Read-parity). Returns every overload's body for an ambiguous name. |
| `codegraph_search` | Find symbols by name across the codebase (locations only) |
| `codegraph_callers` | Find what calls a function: each caller at every line it makes the call, and a function that calls itself, marked as such |
| `codegraph_callees` | Find what a function calls |
| `codegraph_impact` | Analyze what code is affected by changing a symbol |
| `codegraph_files` | Get the indexed file structure (faster than filesystem scanning). `format: "package"` groups files by the nearest `package.json` or `composer.json` that names a package, so a monorepo splits into its workspaces. |
| `codegraph_status` | Check index health and statistics, including the CodeGraph version that built the index and the version running |

The tools that take a symbol name accept a qualified one, like `Format.Price`, or one written with its package, like `gin.Context.Next`, and answer for the symbol spelled that way only — `Format.Price` doesn't bring in `LegacyFormat.Price`.

Re-enable any of them with the `CODEGRAPH_MCP_TOOLS` environment variable — a comma-separated allowlist of short names that replaces the default:

```bash
CODEGRAPH_MCP_TOOLS=explore,node,search,callers
```

Each also has a CLI equivalent (`codegraph node` / `query` / `callers` / `callees` / `impact` / `files` / `status`) for scripts and non-MCP harnesses.

## When the index is older than CodeGraph

After you upgrade CodeGraph, an index built by an older engine misses what the new one adds. The first answer your agent gets for such a project, once per session, opens with a warning naming the version that built the index and the version running, and saying you can rebuild it with `codegraph index`. `codegraph_status` shows both versions every time, and whether a re-index is recommended. See [Indexing a Project](/codegraph/guides/indexing/#after-an-upgrade).

## Server options

Add these to the server's arguments in your agent's MCP config, after `serve --mcp`:

- `--no-telemetry` sends no usage telemetry from this server, the same as setting `CODEGRAPH_TELEMETRY=0` for it, so a shared MCP config can opt out without an environment variable.
- `--no-watch` turns off the file watcher, so the index is no longer synced as you edit. It's meant for slow filesystems like WSL2's `/mnt` drives.

## Sensitive folders

The server never uses a sensitive folder, such as `~/.ssh`, `/etc` or `C:\Windows`, as a project. A tool call that names one is refused however the path reaches it: through a link or junction, with different capitalization, as a `\\?\` path, or as a missing folder inside one. Nor does the server take one as a session's default project, whether it came from the agent's workspace, the folder the server started in, or `--path`.

## How agents should use it

CodeGraph *is* the pre-built search index. For "how does X work?", architecture, a flow ("how does X reach Y"), or where-is-X questions — and while editing code — an agent should answer with `codegraph_explore` and stop, typically with **zero file reads**, rather than re-deriving the answer with `grep` + `Read`. A direct CodeGraph answer is one to a few calls; a grep/read exploration is dozens.

The MCP server delivers this guidance to the main agent automatically, in the MCP `initialize` response. Because subagents and non-MCP harnesses never see that response, the installer also writes a short marker-fenced section into each agent's instructions file pointing at the `codegraph explore` CLI equivalent.
