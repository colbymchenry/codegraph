---
name: codegraph-setup
description: Sets up and manages CodeGraph (a local code knowledge graph served to coding agents over MCP) for the user — installs the CLI, wires the MCP server into the agent either globally or for one project only, builds or refreshes a project's index, checks its status, and removes it again. Use when the user asks to "add codegraph to this project", "set up / enable / install codegraph", "enable codegraph only for this project", "index this repo with codegraph", "reindex / update the codegraph index", "is codegraph working", or "remove / disable codegraph". Not for answering questions about code — use the `codegraph_*` tools (or `codegraph explore`) for that.
---

# CodeGraph setup

CodeGraph has two parts, and both are needed:

1. **Agent wiring** — the `codegraph` MCP server registered with the agent, either **globally** (every project the agent opens) or **per-project** (only this one).
2. **A project index** — `.codegraph/` at the project's root, built by `codegraph init`. While the MCP server runs, it keeps the index in sync with file changes by itself.

Every step below is idempotent: check the current state first, do only what is missing, and tell the user what was already in place. Run commands from the project root. The CLI documents itself — when a flag below is rejected, read `codegraph <command> --help` for the user's version instead of guessing.

## 1. Check the CLI

Run `codegraph --version`.

If it is missing, **ask before installing** — it is a program on the user's machine. Offer the standalone installer (bundles its own Node runtime):

- macOS / Linux: `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh`
- Windows (PowerShell): `irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex`
- Or, with Node already installed: `npm i -g @colbymchenry/codegraph`

A fresh install may not be on this shell's `PATH` yet; if `codegraph` is still not found, use the path the installer printed or ask the user to open a new terminal.

## 2. Choose global or per-project

- If `codegraph_*` tools are already available in this session, the agent is already wired — skip to step 4.
- If the user said which they want ("only for this project", "everywhere"), do that.
- Otherwise ask once, explaining the trade-off:
  - **Global** — set up once, then any project only needs an index. The server also starts in projects that have no index (it just tells the agent the project isn't indexed).
  - **Per-project** — the server starts only where the user turned it on; each new project needs this step again.

Pick the target id for the agent you are running in:

| Agent | id | per-project |
|---|---|---|
| Claude Code | `claude` | yes |
| Codex CLI | `codex` | yes |
| Gemini CLI | `gemini` | yes |
| opencode | `opencode` | yes |
| Cursor | `cursor` | yes |
| Kiro | `kiro` | yes |
| GitHub Copilot in VS Code | `copilot-vscode` | yes |
| Antigravity IDE | `antigravity` | global only |
| Hermes Agent | `hermes` | global only |
| GitHub Copilot CLI / JetBrains | `copilot-cli` / `copilot-jetbrains` | global only |

`codegraph install --help` lists the ids your version knows. Use `auto` (every agent detected on the machine) only if the user asks for all of them.

## 3a. Global wiring

```bash
codegraph install --target <id> --location global --yes
```

- `--yes` is required: without it the installer waits on prompts an agent cannot answer.
- With `--yes`, Claude Code also gets an auto-allow list so CodeGraph tools don't trigger permission prompts. Add `--no-permissions` if the user doesn't want that.
- The installer writes a short CodeGraph block into the agent's own instructions file (e.g. `~/.claude/CLAUDE.md`). **Do not** add your own CodeGraph section to the project's `CLAUDE.md` / `AGENTS.md` — it would duplicate it.
- Re-running is safe: an already-configured agent is reported as unchanged.

## 3b. Per-project wiring

There are two ways; ask which one if the user didn't say.

**Private — nothing in the repository changes (Claude Code).** Recommended when only this user wants CodeGraph here:

```bash
claude mcp add --scope local codegraph -- codegraph serve --mcp
```

- Check `claude mcp list` first; if `codegraph` is already there for this project, skip.
- `--scope local` stores the entry in the user's own Claude config for this project only. Don't use `--scope project`: it creates `.mcp.json` in the repo, and teammates without CodeGraph get a broken server.
- To skip permission prompts for CodeGraph tools, add `"mcp__codegraph"` to `permissions.allow` in `.claude/settings.local.json`. A hand-made `settings.local.json` is not ignored by git on its own — step 4 covers that.
- If the server shows as failed on Windows, re-create the entry as `claude mcp add --scope local codegraph -- cmd /c codegraph serve --mcp`.

**Project files — the config lives in the repository (any agent marked "yes" above).** Use this when the team should get the same setup, or for agents other than Claude Code:

```bash
codegraph install --target <id> --location local --yes
```

- It writes the agent's MCP config and instructions into project files (for Claude Code: `.mcp.json`, `.claude/settings.json`, `.claude/CLAUDE.md`) and prints which ones. Tell the user these may get committed; if they want to keep them private, add those paths to `.git/info/exclude`.
- Codex CLI applies a project's `.codex/config.toml` only in a project marked trusted in Codex — pass that note on.

## 4. Index the project

- Make sure you are in a real project: `git rev-parse --show-toplevel`, and work from that root. Never index a home directory, Desktop or a filesystem root — `codegraph init` refuses these; do not override it with `--force` unless the user explicitly insists.
- If `.codegraph/` does not exist: `codegraph init --yes` (creates it and builds the full graph in one step). A large repository can take a while — wait for it and report the summary it prints.
- If `.codegraph/` already exists, leave it alone and check it with `codegraph status`.

`.codegraph/` carries its own `.gitignore`, so the index itself is never committed. That `.gitignore` is the one file `git status` shows as new — it is meant to be committed, so the index stays ignored for everyone. In a **private per-project** setup, where the repository should not change at all, run `git status --short` and add what CodeGraph created to `.git/info/exclude` (local to this clone, never committed): `.codegraph/`, plus `.claude/settings.local.json` if you created it and it shows up.

## 5. Report back

Tell the user, briefly:

- what was done and what was already in place, and whether CodeGraph is now global or per-project;
- that the agent loads MCP servers at startup, so **the `codegraph_*` tools appear only after the agent is restarted** (in Claude Code, `/mcp` can reconnect without a restart);
- which files changed: in the repository, only `.codegraph/.gitignore` for a global setup, nothing for a private per-project one (everything went to `.git/info/exclude`), and the files the installer listed for a project-files setup.

Until the restart, `codegraph explore "<symbols or question>"` gives the same answers from the shell.

## Refreshing the index

Normally there is nothing to do: the running MCP server watches files and updates the graph. Refresh by hand only when the user asks, or when answers clearly disagree with the code (e.g. after a `git pull` or branch switch made while no agent session was running):

- `codegraph sync` — incremental update of changed files (fast; the usual choice).
- `codegraph index` — full rebuild, when sync is not enough or the user asks for it.

If `sync` fails because the database "is locked by another process", a CodeGraph server is running for this project and is already keeping the index current — confirm with `codegraph status` instead of forcing it. Don't run `codegraph unlock` or delete the lock file while that process is alive.

If the project has no `.codegraph/` yet, this is a setup, not a refresh — follow steps 2–4.

## Troubleshooting

- `codegraph status` shows whether the project is indexed and what the index holds.
- MCP server listed as failed in the agent: check that `codegraph --version` works in a new terminal, then redo step 3a or 3b.
- `codegraph upgrade` updates the CLI; it also refreshes what earlier `codegraph install` runs wrote into agent configs.

## Removing (only when the user asks)

Undo the same kind of wiring that was set up:

- Global: `codegraph uninstall --target <id> --location global --yes --keep-cli`.
- Per-project, private (Claude Code): `claude mcp remove codegraph --scope local`, and take `"mcp__codegraph"` out of `.claude/settings.local.json` if it was added.
- Per-project, project files: `codegraph uninstall --target <id> --location local --yes --keep-cli`.
- The CLI itself: drop `--keep-cli` from a `codegraph uninstall` above, only if the user also wants it removed.
- A project's index: `codegraph uninit --force` (deletes `.codegraph/`). A CodeGraph server still running for the project keeps its files open, and on Windows `uninit` then fails with `EPERM`. Run `codegraph daemon` first: without a terminal it prints one `pid … <project root>` line per running server. Stop only the one whose root is this project (`kill <pid>`, or `taskkill /PID <pid> /F` on Windows), or wait about 5 minutes for it to exit on its own once no agent is connected, then run `uninit`.

The current agent session keeps its connection to the server until it restarts.
