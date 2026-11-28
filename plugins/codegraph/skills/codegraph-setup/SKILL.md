---
name: codegraph-setup
description: >-
  Install the CodeGraph CLI, wire its MCP server into coding agents, index a
  project with codegraph init, and tune what gets indexed with codegraph.json
  (exclude, include, deprioritize) and .gitignore. Use when setting up
  CodeGraph, when an index is missing, stale or locked, or when removing it.
---

# Setting up CodeGraph

Reference: `README.md` ("Get Started", "CLI Reference", "Configuration",
"Troubleshooting").

## Install the CLI

```bash
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh   # macOS/Linux
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex         # Windows
npm i -g @colbymchenry/codegraph                                                           # with Node
```

Open a **new terminal** afterwards so `codegraph` resolves. Upgrade with
`codegraph upgrade` (`--check` to only look).

## Wire agents

```bash
codegraph install
```

Detects supported agents (Claude Code, Cursor, Codex CLI, opencode, Gemini CLI,
GitHub Copilot and more) and adds the MCP server (`codegraph serve --mcp`) to
each. It does not index anything.

## Index a project

```bash
cd your-project
codegraph init               # creates .codegraph/ and builds the graph
codegraph init --local-only  # keep .codegraph/ out of git
codegraph status             # stats; --json for scripts
```

Auto-sync keeps the graph fresh while the MCP server runs. Manual tools:
`codegraph sync` (incremental), `codegraph index` (full rebuild, needed after
an upgrade changes the index format), `codegraph unlock` (stale lock file).

## What gets indexed

Skipped by default: dependency/build/cache directories (`node_modules`,
`vendor`, `dist`, `target`, `.venv`, ...), anything in `.gitignore`, and files
over 4 MB (`codegraph status` lists them).

`codegraph.json` at the repo root:

```json
{
  "exclude": ["static/", "**/vendor/**"],
  "include": ["Tools/"],
  "deprioritize": ["scripts/"]
}
```

- `exclude`: drop committed directories `.gitignore` can't.
- `include`: force gitignored source back in (exclude still wins).
- `deprioritize`: keep searchable but rank below product code.
- `!vendor/` in `.gitignore` opts a default-excluded directory back in.

## Remove

```bash
codegraph uninit           # remove .codegraph/ from a project
codegraph uninstall        # remove agent configs and the CLI (--keep-cli to keep it)
```
