---
title: Your First Graph
description: Build an index and run your first queries against it.
---

Once CodeGraph is installed, building and exploring a graph takes three commands.

## Index a project

```bash
cd your-project
codegraph init -i      # initialize + index in one step
```

`init` creates the `.codegraph/` directory; `-i` (or `--index`) immediately builds the full index. For an existing project you can re-index any time:

```bash
codegraph index          # full index
codegraph sync           # incremental update of changed files
```

## Check it worked

```bash
codegraph status
```

This reports the node/edge/file counts, the active SQLite backend, and the journal mode — a quick health check that the index is ready.

## Run a query

```bash
codegraph query UserService          # find symbols by name
codegraph callers handleRequest      # what calls a function
codegraph callees handleRequest      # what a function calls
codegraph impact AuthMiddleware      # what a change would affect
codegraph context "fix the login flow"   # build task-focused context
```

Each accepts `--json` for machine-readable output. See the full [CLI reference](/codegraph/reference/cli/).

## Hand it to your agent

With a `.codegraph/` directory present and an agent configured (see [Installation](/codegraph/getting-started/installation/)), your agent uses the [MCP tools](/codegraph/reference/mcp-server/) automatically — no extra step.
