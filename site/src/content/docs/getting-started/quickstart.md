---
title: Get Started
description: Get up and running with CodeGraph in seconds.
---

Get up and running with CodeGraph in seconds.

## 1. Install the CLI

No Node.js required — one command grabs the right build for your OS:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

Already have Node? `npm i -g @colbymchenry/codegraph` works on any version. CodeGraph bundles its own runtime — nothing to compile, no native build, works the same everywhere. The installer puts `codegraph` on your `PATH` but doesn't change your current shell — open a new terminal before the next step.

## 2. Wire up your agent(s)

```bash
codegraph install
```

Auto-detects and configures Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, and Kiro — wiring the CodeGraph MCP server into each. This step connects your agents only; it does **not** index any code. (Shortcut: `npx @colbymchenry/codegraph` downloads and runs the installer in one go.)

## 3. Initialize each project

```bash
cd your-project
codegraph init
```

`codegraph init` creates the local `.codegraph/` directory and builds the full graph in the same step — one command, done. Your agent will use CodeGraph tools automatically when a `.codegraph/` directory exists.

Next: build [Your First Graph](/codegraph/getting-started/your-first-graph/), or see the full [Installation](/codegraph/getting-started/installation/) options.
