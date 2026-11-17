---
title: Installation
description: Install CodeGraph and configure your AI coding agents.
---

## 1. Run the installer

```bash
npx @colbymchenry/codegraph
```

The installer will:

- Ask which agent(s) to configure — auto-detecting installed ones from **Claude Code**, **Cursor**, **Codex CLI**, **opencode**, **Hermes Agent**, **Gemini CLI**, **Antigravity IDE**, **Kiro**, **GitHub Copilot** (VS Code, Copilot CLI, JetBrains IDEs), **IBM Bob**, **Factory Droid**, **Windsurf**, **Qwen Code**, **DeepSeek Harness**, **Grok Build**, **Kimi Code**, **Qoder CLI**, and **Pi**.
- Prompt to install `codegraph` on your `PATH` (so agents can launch the MCP server).
- Ask whether configs apply to all your projects or just this one.
- Write each chosen agent's MCP server config ([Integrations](/codegraph/reference/integrations/) lists the file for each agent). Claude Code, Codex CLI, Gemini CLI, opencode, Factory Droid, Qwen Code, DeepSeek Harness, Grok Build, Kimi Code and Pi also get a small marker-fenced CodeGraph section in their instructions file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `QWEN.md`, or `rules/codegraph.md` for Grok Build); the others get the MCP config only. Removed cleanly by `codegraph uninstall`.
- Set up auto-allow permissions when Claude Code or Qwen Code is one of the targets.

The installer **wires up your agents only — it does not index your code.** After it finishes, build each project's graph yourself with `codegraph init` (step 3 below).

## Non-interactive (scripting / CI)

```bash
codegraph install --yes                              # auto-detect agents, install global
codegraph install --target=cursor,claude --yes       # explicit target list
codegraph install --target=auto --location=local     # detected agents, project-local
codegraph install --print-config codex               # print snippet, no file writes
```

| Flag | Values | Default |
|---|---|---|
| `--target` | `auto`, `all`, `none`, or csv (`claude,cursor,…`) | prompt |
| `--location` | `global`, `local` | prompt |
| `--yes` | (boolean) | prompt every step |
| `--no-permissions` | (boolean) skip the auto-allow list (Claude Code, Qwen Code) | permissions on |
| `--print-config <id>` | dump snippet for one agent and exit | — |
| `--init` | (boolean) after wiring agents, also run `codegraph init` in the current folder | off |
| `--refresh` | (boolean) rewrite what earlier installs configured, for agents already set up; `codegraph upgrade` runs it for you | off |

## 2. Restart your agent

Restart your agent (Claude Code / Cursor / Codex CLI / opencode / Hermes Agent / Gemini CLI / Antigravity IDE / Kiro / VS Code, the Copilot CLI, or your JetBrains IDE for GitHub Copilot / IBM Bob / Factory Droid / Windsurf / Qwen Code / DeepSeek Harness / Grok Build / Kimi Code / Qoder CLI / Pi) for the MCP server to load.

## 3. Initialize projects

```bash
cd your-project
codegraph init
```

`codegraph init` creates the local `.codegraph/` directory and builds the full graph in the same step — one command. A single global `codegraph install` covers every project; you run `codegraph init` once per project.

## Supported platforms

Every release ships a self-contained build (bundled Node runtime — nothing to compile) for all three desktop OSes, on both x64 and arm64:

| Platform | Architectures | Install |
|---|---|---|
| Windows | x64, arm64 | PowerShell installer or npm |
| macOS | x64, arm64 | shell installer or npm |
| Linux | x64, arm64 | shell installer or npm |

As of CodeGraph 1.6.3 the bundled runtime is Node.js 24.22.1, Node's October 2026 security release, which fixes CVE-2026-111497. Every release checks the Node.js it bundles against the checksums nodejs.org publishes.

## Uninstall

Changed your mind? One command removes CodeGraph from every agent it configured **and** the CLI itself: every install it finds (standalone bundle, npm global package, launcher link), shown to you before anything is deleted. Pass `--keep-cli` to remove only the agent configurations:

```bash
codegraph uninstall
```

This reverses the installer — stripping CodeGraph's MCP server config, instructions, and permissions from each configured agent. Your project indexes (`.codegraph/`) are left untouched; remove those per-project with `codegraph uninit`. Use `--target` to remove from specific agents, or `--yes` to run non-interactively.
