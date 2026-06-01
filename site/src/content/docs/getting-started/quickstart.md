---
title: Get Started
description: Get up and running with CodeGraph in seconds.
---

Get up and running with CodeGraph in seconds.

## No Node.js required — one command grabs the right build for your OS

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

## Already have Node? Use npm instead (works on any version)

```bash
npx @colbymchenry/codegraph        # zero-install, or:
npm i -g @colbymchenry/codegraph
```

CodeGraph bundles its own runtime — nothing to compile, no native build, works the same everywhere.

## Wire Up Your Agent

```bash
codegraph install
```

The interactive installer writes the MCP server config for your agent(s) — Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, Kiro. If you are using the zero-install npm flow, run `npx @colbymchenry/codegraph` for the same setup. Restart your agent afterwards so it loads the new MCP server.

## Initialize Projects

```bash
cd your-project
codegraph init -i
```

`codegraph init` creates the local `.codegraph/` index directory; adding `-i` (`--index`) also builds the initial graph in the same step. It does not install CodeGraph into your agent by itself.

Next: build [Your First Graph](/codegraph/getting-started/your-first-graph/), or see the full [Installation](/codegraph/getting-started/installation/) options.
