---
title: CLI
description: Every CodeGraph command and the flags it accepts.
---

```bash
codegraph                         # Run interactive installer
codegraph install                 # Run installer (explicit)
codegraph uninstall               # Remove CodeGraph from your agents (inverse of install)
codegraph init [path]             # Initialize a project + build its graph (one step)
codegraph uninit [path]           # Remove CodeGraph from a project (--force to skip prompt)
codegraph index [path]            # Full re-index from scratch (--force, --quiet, --verbose)
codegraph sync [path]             # Incremental update (--quiet)
codegraph status [path]           # Show statistics (--json)
codegraph ui [path]               # Open the browser viewer for an indexed project (alias: web; --port, --no-open)
codegraph unlock [path]           # Remove a stale lock file that's blocking indexing
codegraph query <search>          # Search symbols (--kind, --limit, --json)
codegraph explore <query>         # Relevant symbols' source + call paths in one shot (same output as the codegraph_explore MCP tool)
codegraph node <symbol|file>      # One symbol's source + callers, or read a file with line numbers (same output as codegraph_node)
codegraph files [path]            # Show file structure (--format, --filter, --pattern, --max-depth, --json)
codegraph callers <symbol>        # Find what calls a function/method (--limit, --json)
codegraph callees <symbol>        # Find what a function/method calls (--limit, --json)
codegraph impact <symbol>         # Analyze what code is affected by changing a symbol (--depth, --json)
codegraph affected [files...]     # Find test files affected by changes (see below)
codegraph daemon                  # Manage background daemons — pick one to stop (alias: daemons)
codegraph telemetry [on|off]      # Show or change anonymous usage telemetry
codegraph upgrade [version]       # Update to the latest release (--check, --force)
codegraph version                 # Print the installed version (also -v, --version)
codegraph help [command]          # Show help, optionally for one command
```

The MCP server (`codegraph serve --mcp`) is launched automatically by your agent — you don't run it by hand. See [MCP Server](/codegraph/reference/mcp-server/).

## init, index, and sync

`codegraph init` creates the local `.codegraph/` directory **and** builds the full graph in one step. (The old `-i`/`--index` flag is now a no-op, accepted only so existing scripts don't break.) After that the file watcher keeps the graph current automatically — `index` (a full rebuild from scratch) and `sync` (an incremental update) are only needed when the watcher is disabled or you're scripting against the index outside an agent session.

## Query commands

`query`, `callers`, `callees`, and `impact` all accept `--json` for machine-readable output.

```bash
codegraph query UserService --kind class --limit 10
codegraph callers handleRequest --json
codegraph impact AuthMiddleware --depth 3
```

`explore` and `node` are the CLI faces of the `codegraph_explore` and `codegraph_node` MCP tools — same output — so subagents and non-MCP harnesses can reach the graph from a shell.

## affected

Traces import dependencies transitively to find which test files are affected by changed source files. See [Affected Tests in CI](/codegraph/guides/affected-tests/) for options and a CI example.

## ui

`codegraph ui` opens the [browser viewer](/codegraph/guides/viewer/) for a project you have already indexed: callers on the left, the symbol's source in the middle, and what it calls on the right at the height of the line that calls it.

```bash
codegraph ui                     # the project you're standing in
codegraph ui ~/code/my-app       # a project indexed elsewhere
codegraph ui --port 8080         # pin a port (fails if it's taken)
codegraph ui --no-open           # just print the URL (headless boxes, SSH)
codegraph ui --read-only         # refuse every write, including saved trails
```

Without `--port` it takes 4747, or the next free port. `CODEGRAPH_BROWSER=<command>` chooses which browser opens; `CODEGRAPH_BROWSER=none` never opens one. `codegraph web` is an alias.

The viewer listens on `127.0.0.1` only: it opens an index that already exists, never creates one, never changes your graph or a line of your code, and sends nothing anywhere. The one thing it writes is a trail you asked it to save, under `.codegraph/ui/trails/`; `--read-only` refuses even that.
