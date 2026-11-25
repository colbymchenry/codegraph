---
title: Troubleshooting
description: Fixes for the most common CodeGraph issues.
---

## "CodeGraph not initialized"

Run `codegraph init` in your project directory first.

## Indexing is slow

Check that `node_modules` and other large directories are excluded (they are, if gitignored). Use `--quiet` to reduce output overhead.

## MCP hits `database is locked`

Current builds shouldn't: CodeGraph bundles its own Node runtime and uses Node's built-in `node:sqlite` in WAL mode, where concurrent reads never block on a writer. If you still see it:

- **You're on an old (pre-0.9) install.** Reinstall to get the bundled runtime — `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh` (macOS/Linux), `irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex` (Windows), or `npm i -g @colbymchenry/codegraph@latest`.
- **`codegraph status` shows `Journal:` other than `wal`** — WAL couldn't be enabled on this filesystem (common on network shares and WSL2 `/mnt`), so reads can block on writes. Move the project (with its `.codegraph/` folder) onto a local disk.

## MCP server not connecting

Your agent starts the server itself, so you don't launch it by hand. Make sure the project is initialized and indexed (`codegraph status`) and that the path in your MCP config is correct. If it still won't connect, re-run `codegraph install` to rewrite the config.

## Missing symbols

The MCP server auto-syncs on save (wait a couple of seconds). Run `codegraph sync` manually if needed. Check that the file's language is [supported](/codegraph/reference/languages/) and isn't inside a `.gitignore`d or default-excluded directory (e.g. `node_modules`, `dist`).

## Sharing one checkout between Windows and WSL

Don't point both at the same `.codegraph/`: the background-server lock and the SQLite index are tied to the OS that wrote them, and SQLite locking across the WSL2/Windows filesystem boundary is unreliable (WSL reports it as a `disk I/O error`). For a project on a Windows drive (a `/mnt/c/…` path), WSL keeps its own index automatically: an index first built from WSL goes in `.codegraph-wsl/`, leaving `.codegraph/` to Windows. An index already in `.codegraph/` stays where it is, so if Windows built that one, give WSL its own by setting `CODEGRAPH_DIR=.codegraph-wsl` in WSL and running `codegraph init` there. `CODEGRAPH_DIR` always picks the name when set, on either side. CodeGraph skips any sibling `.codegraph-*` directory when indexing and watching, so the two never trip over each other.
