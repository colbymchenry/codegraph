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

CodeGraph bundles its own runtime — nothing to compile, no native build, works the same everywhere. The interactive installer auto-configures your agent(s) — Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, Kiro.

## Initialize Projects

```bash
cd your-project
codegraph init -i
```

That's it — your agent will use CodeGraph tools automatically when a `.codegraph/` directory exists.

Next: build [Your First Graph](/codegraph/getting-started/your-first-graph/), or see the full [Installation](/codegraph/getting-started/installation/) options.
