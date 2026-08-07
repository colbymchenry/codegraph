---
title: Integrations
description: Supported agents, and manual MCP setup.
---

The interactive installer auto-detects and configures each supported agent — wiring the CodeGraph MCP server into each. For the agents that use an instructions file, it also writes a short marker-fenced CodeGraph section (`CLAUDE.md`, `AGENTS.md`, or `GEMINI.md`) so subagents and non-MCP harnesses learn the `codegraph explore` command; `codegraph uninstall` removes it.

## Supported agents

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**
- **Gemini CLI**
- **Antigravity IDE**
- **Kiro**

Run `npx @colbymchenry/codegraph` and pick your agent(s); see [Installation](/codegraph/getting-started/installation/) for the non-interactive flags.

To configure agents for an already-running Streamable HTTP MCP server instead
of stdio, run:

```bash
codegraph install --target=all --transport=http --mcp-url=http://127.0.0.1:3333/mcp
```

## Manual setup

If you'd rather wire it up yourself, install globally:

```bash
npm install -g @colbymchenry/codegraph
```

Add the MCP server to `~/.claude.json`:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

For HTTP MCP, start the server with a fixed indexed project path:

```bash
codegraph serve --mcp --transport http --path /absolute/path/to/project
```

Then configure the client with its HTTP form. For example, Claude Code uses:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "http",
      "url": "http://127.0.0.1:3333/mcp"
    }
  }
}
```

Optionally auto-allow CodeGraph's tools in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__*"
    ]
  }
}
```

One wildcard auto-approves every CodeGraph tool. The server lists a single tool by default — `codegraph_explore` — but if you re-enable others via the `CODEGRAPH_MCP_TOOLS` environment variable, they're already permitted with no prompt.

:::tip
Cursor launches MCP subprocesses with the wrong working directory. The installer handles this for you by injecting a `--path` argument; if you wire Cursor up by hand, pass the project path explicitly.
:::
