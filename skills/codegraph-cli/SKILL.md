---
name: codegraph-cli
description: Use the standalone CodeGraph CLI to answer structural codebase questions without MCP. Use when an agent can run shell commands in a repository with codegraph on PATH and should prefer codegraph index, sync, status, query, files, context, callers, callees, impact, and affected over grep/read loops for symbol lookup, call relationships, impact analysis, focused context, indexed file lists, and affected tests.
---

# CodeGraph CLI

Use the `codegraph` CLI directly when an MCP server is unavailable, awkward to
wire through a container, or unnecessary for the task. CodeGraph stores a local
AST-derived index in `.codegraph/codegraph.db`; query that index before scanning
whole files with grep/read.

## Workflow

1. Check for an initialized index:
   ```bash
   codegraph status --json
   ```
2. If the project is not initialized and the user wants CodeGraph for this repo,
   build the index:
   ```bash
   codegraph init -i
   ```
3. If files changed since the index was built, refresh it:
   ```bash
   codegraph sync --quiet
   ```
4. Answer structural questions with the read commands below. Treat returned
   source, symbols, and paths as the starting context; only fall back to raw file
   reads for details the CLI did not return.

Most read commands accept `-p, --path <path>` when your shell cwd is not the
project root. Setup commands such as `init`, `index`, `sync`, `status`,
`uninit`, and `unlock` take the project path as a positional argument.

## Command Selection

| Intent | Command |
| --- | --- |
| Build or rebuild the index | `codegraph index [path] --force` |
| Refresh changed files | `codegraph sync [path] --quiet` |
| Check index health and counts | `codegraph status [path] --json` |
| Find a symbol by name | `codegraph query <search> --kind <kind> --limit <n>` |
| List indexed files | `codegraph files --format tree --max-depth <n>` |
| Get task-focused code context | `codegraph context <task> --max-nodes <n> --max-code <n>` |
| Find incoming calls | `codegraph callers <symbol> --limit <n>` |
| Find outgoing calls | `codegraph callees <symbol> --limit <n>` |
| Estimate change blast radius | `codegraph impact <symbol> --depth <n>` |
| Find tests affected by changed files | `codegraph affected [files...] --quiet` |
| Clear a stale indexing lock | `codegraph unlock [path]` |

## Read Commands

### `status`

```bash
codegraph status --json
codegraph status ../repo
```

`--json` returns whether the project is initialized plus file, node, edge,
language, pending-change, backend, and journal-mode fields.

### `files`

```bash
codegraph files --format tree --max-depth 3
codegraph files --format flat --filter src --no-metadata
codegraph files --pattern "**/*.test.ts" --json
codegraph files --path ../repo --format grouped
```

Use this instead of filesystem scans when you need indexed source files. Text
output is `tree`, `flat`, or `grouped`; `--json` returns file path, language,
symbol count, and size.

### `query`

```bash
codegraph query UserService --kind class --limit 10
codegraph query handleRequest --json
codegraph query AuthMiddleware --path ../repo
```

Use this before grep when looking for definitions by name. Text output includes
kind, name, score, file path, line number, and signature when available.
`--json` returns the raw search results.

### `context`

```bash
codegraph context "fix the login flow" --max-nodes 30 --max-code 6
codegraph context "how requests reach the database" --format json
codegraph context "authentication middleware" --path ../repo --no-code
```

Use this to map a feature or task in one call. Markdown is the default output;
`--format json` is available for structured downstream processing. `--no-code`
keeps only the symbol/context metadata.

### `callers` and `callees`

```bash
codegraph callers handleRequest --limit 20
codegraph callers AuthMiddleware --json
codegraph callees handleRequest --limit 20
codegraph callees AuthMiddleware --path ../repo --json
```

Use `callers` for incoming edges and `callees` for outgoing edges. Text output
lists each related symbol with kind and location. JSON output is shaped as
`{ "symbol": "...", "callers": [...] }` or `{ "symbol": "...", "callees": [...] }`.

### `impact`

```bash
codegraph impact AuthMiddleware --depth 3
codegraph impact UserService --path ../repo --json
```

Use this before editing shared code. Depth is clamped by the CLI; JSON output
includes the queried symbol, depth, node count, edge count, and affected symbols.

### `affected`

```bash
codegraph affected src/utils.ts src/api.ts --quiet
git diff --name-only | codegraph affected --stdin --quiet
codegraph affected src/auth.ts --filter "e2e/*" --json
```

Use this to choose tests for changed files. `--quiet` prints only affected test
paths; `--json` returns changed files, affected tests, and the number of
dependents traversed.

## Maintenance Commands

```bash
codegraph init -i
codegraph index --force
codegraph sync
codegraph unlock
codegraph uninit --force
```

Run `init -i` once per project. Use `index --force` after major dependency or
extractor changes, `sync` after ordinary edits, and `unlock` only when a stale
lock blocks indexing. `uninit --force` deletes `.codegraph/`; do not run it
unless the user asked to remove the project index.

## Container Notes

For containerized agents, mount or work inside the same project tree that holds
`.codegraph/`, install `codegraph` on the container PATH, and call the CLI
directly. No MCP server, host networking, or volume-shared stdio process is
required for the commands in this skill.
