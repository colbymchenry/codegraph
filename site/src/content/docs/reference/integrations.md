---
title: Integrations
description: Supported agents, where the installer writes each one's config, and manual MCP setup.
---

The interactive installer auto-detects and configures each supported agent — wiring the CodeGraph MCP server into each. For the agents that use an instructions file, it also writes a short marker-fenced CodeGraph section (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `QWEN.md`, or Grok Build's `rules/codegraph.md`) so subagents and non-MCP harnesses learn the `codegraph explore` command; `codegraph uninstall` removes it.

## Supported agents

Each agent's `--target` id is in parentheses, followed by where the installer writes its MCP server entry: the global file, which covers every project, then the file a project install (`--location=local`) writes. "Global only" means the agent has no project-level config.

- **Claude Code** (`claude`) — `~/.claude.json`, or `.mcp.json` in a project; with `CLAUDE_CONFIG_DIR` set, `$CLAUDE_CONFIG_DIR/.claude.json`
- **Cursor** (`cursor`) — `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project
- **Codex CLI** (`codex`) — the Codex IDE extension reads the same config: a global install writes `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`), and a local install writes `.codex/config.toml`, which Codex uses only in a project you've marked as trusted
- **opencode** (`opencode`) — `opencode.jsonc` in `~/.config/opencode` (under `$XDG_CONFIG_HOME` when that's set), or in the project; an `opencode.json` already there is used instead
- **Hermes Agent** (`hermes`) — global only: `$HERMES_HOME/config.yaml` (default `~/.hermes`)
- **Gemini CLI** (`gemini`) — `~/.gemini/settings.json`, or `.gemini/settings.json` in a project
- **Antigravity IDE** (`antigravity`) — global only: `~/.gemini/config/mcp_config.json`, or `~/.gemini/antigravity/mcp_config.json` for an Antigravity that hasn't moved its config there yet
- **Kiro** (`kiro`) — `~/.kiro/settings/mcp.json`, or `.kiro/settings/mcp.json` in a project
- **GitHub Copilot in VS Code** (`copilot-vscode`) — VS Code's user `mcp.json` (in `~/Library/Application Support/Code/User/` on macOS, `%APPDATA%\Code\User\` on Windows, `~/.config/Code/User/` on Linux), or `.vscode/mcp.json` in a project
- **GitHub Copilot CLI** (`copilot-cli`) — global only: `$COPILOT_HOME/mcp-config.json` (default `~/.copilot`)
- **GitHub Copilot in JetBrains IDEs** (`copilot-jetbrains`) — global only: `~/.config/github-copilot/intellij/mcp.json`, or `%LOCALAPPDATA%\github-copilot\intellij\mcp.json` on Windows
- **IBM Bob** (`bob`) — Bob IDE and Bob Shell: `~/.bob/settings/mcp.json`, or `.bob/mcp.json` in a project
- **Factory Droid** (`droid`) — `~/.factory/mcp.json`, or `.factory/mcp.json`, which is meant to be committed; Droid reloads the file on its own
- **Windsurf** (`windsurf`) — global only: `~/.codeium/windsurf/mcp_config.json`, which Devin, Windsurf's new name, imports by default
- **Qwen Code** (`qwen`) — `settings.json` in `$QWEN_HOME` (default `~/.qwen`) or `.qwen/`, keeping any comments in it; with auto-allow on, CodeGraph's tools are allowed by the rule `mcp__codegraph`
- **DeepSeek Harness** (`dsh`) — global only: one entry in `$DSH_HOME/cordis.patch.yml` (default `~/.dsh`) covers every profile
- **Grok Build** (`grok`) — `$GROK_HOME/config.toml` (default `~/.grok`), or `.grok/config.toml`, which Grok uses only in a trusted folder
- **Kimi Code** (`kimi`) — `$KIMI_CODE_HOME/mcp.json` (default `~/.kimi-code`), or `.kimi-code/mcp.json`, which Kimi Code uses only in a trusted folder
- **Qoder CLI** (`qoder`) — `$QODER_CONFIG_DIR/settings.json` (default `~/.qoder`), or `.qoder/settings.local.json`, which Qoder loads only in a trusted folder
- **Pi** (`pi`) — `mcp.json` in Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`), or `.pi/mcp.json`, which Pi reads once you trust the project; `exposure: "direct"` keeps `codegraph_explore` on the model's tool list

Claude Code, Codex CLI, Gemini CLI, opencode, Factory Droid, Qwen Code, DeepSeek Harness, Grok Build, Kimi Code and Pi also get the CodeGraph section in an instructions file. A global install writes it in the agent's own folder, such as `~/.claude/CLAUDE.md` or `~/.gemini/GEMINI.md`. A project install writes it at the project root, except Claude Code's, which goes in `.claude/CLAUDE.md`, and Grok Build's, in `.grok/rules/codegraph.md`.

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

For any other agent, `codegraph install --print-config <id>` prints the entry the installer would write, and the file it goes in, without writing anything. To turn off usage telemetry for one server entry, add `--no-telemetry` to its arguments: `"args": ["serve", "--mcp", "--no-telemetry"]`.

:::tip
Cursor launches MCP subprocesses with the wrong working directory. The installer handles this for you by injecting a `--path` argument; if you wire Cursor up by hand, pass the project path explicitly.
:::
