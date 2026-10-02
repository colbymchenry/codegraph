# Codex CLI setup notes

This guide covers a small, Codex-focused setup path for CodeGraph. It assumes you already have Codex CLI installed and want CodeGraph available as an MCP server across your projects.

## Install CodeGraph

Use the platform installer if you do not want to manage Node.js yourself:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

If you already use Node.js, the npm package works too:

```bash
npx @colbymchenry/codegraph
# or
npm install -g @colbymchenry/codegraph
```

## Configure Codex CLI

Run the installer and choose Codex CLI when prompted. For a non-interactive setup, target Codex directly:

```bash
codegraph install --target=codex --location=global --yes
```

Codex CLI uses global configuration, so CodeGraph writes its MCP server entry under your home Codex config directory. If you want to inspect the config before writing it, print the snippet first:

```bash
codegraph install --print-config codex
```

After installation, restart Codex CLI so it reloads the MCP server configuration.

## Initialize a project index

From the repository you want Codex to understand, build the local CodeGraph index:

```bash
cd your-project
codegraph init -i
```

The `-i` flag initializes `.codegraph/` and builds the first index in one step. Without it, run `codegraph index` afterwards.

## Verify the index

Use the CLI status command from the project root:

```bash
codegraph status
```

Inside Codex, ask a codebase question after the restart. When `.codegraph/` exists, CodeGraph's MCP tools should be available for structural search, context, callers, callees, impact, and status queries.

## Windows and WSL notes

- Run the Windows PowerShell installer from Windows projects, and the shell installer from Linux or WSL projects.
- Keep the project and its `.codegraph/` directory on the same filesystem where you work. For WSL, prefer the Linux filesystem for WSL-based development rather than repeatedly crossing `/mnt/c`.
- If `codegraph status` reports a journal mode other than `wal` on a mounted or network filesystem, move the project to a local disk before relying on concurrent reads and writes.

## Uninstall or clean up

Remove CodeGraph from configured agents:

```bash
codegraph uninstall --target=codex --yes
```

Remove a project's local index when you no longer need it:

```bash
codegraph uninit
```

The uninstall command removes the Codex MCP server config. `codegraph uninit` removes the per-project `.codegraph/` index.