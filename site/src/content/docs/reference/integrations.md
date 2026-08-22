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
- **DeepSeek Harness** (`dsh`) — writes the MCP server into `~/.dsh/cordis.patch.yml`, which applies to every dsh profile at once

Run `npx @colbymchenry/codegraph` and pick your agent(s); see [Installation](/codegraph/getting-started/installation/) for the non-interactive flags.

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

### DeepSeek Harness (dsh)

dsh configures MCP servers as plugin rows in layered YAML patch files, not `mcpServers` JSON. Add the entry to `~/.dsh/cordis.patch.yml` (`$DSH_HOME/cordis.patch.yml` if you've moved the home) — the home-level layer, which applies to every dsh profile at once:

```yaml
- insert:
    - id: mcp-codegraph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: codegraph
        transport: stdio
        command: codegraph
        args:
          - serve
          - --mcp
        failOnStartupError: false
```

The file must stay a valid top-level YAML array — `[]` is the empty state, and a comments-only file fails to load. A running dsh session picks the change up without a restart. dsh doesn't pass a workspace root to MCP servers, so point CodeGraph at your project with `projectPath`.
