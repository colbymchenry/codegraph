---
title: Configuration
description: CodeGraph is zero-config by default, with one optional file for mapping custom extensions.
---

Next to none — CodeGraph is **zero-config by default**, with nothing to write or keep in sync to get started. Language support is automatic from the file extension; there's nothing to wire up per language. The one optional file is for mapping [custom file extensions](#custom-file-extensions).

## What it skips out of the box

- **Dependency, build, and cache directories** — `node_modules`, `vendor`, `dist`, `build`, `target`, `.venv`, `Pods`, `.next`, and the like across every [supported stack](/codegraph/reference/languages/) — so the graph is your code, not third-party noise. This holds even with no `.gitignore`.
- **Anything in your `.gitignore`** — honored in git repos via git, and in non-git projects by reading `.gitignore` directly (root and nested).
- **Files larger than 1 MB** — generated bundles, minified JS, vendored blobs.

## Excluding or including more

To keep something else out, add it to `.gitignore`. To pull a default-excluded directory back **in** (e.g. you really want a vendored dependency indexed), add a negation — `!vendor/`.

The defaults apply uniformly, so committing a dependency or build directory doesn't force it into the graph — the `.gitignore` negation is the explicit opt-in.

## Custom file extensions

If your project uses a non-standard extension for a [supported language](/codegraph/reference/languages/) — say `.dota_lua` for Lua, or `.tpl` for PHP — those files are skipped by default, because the extension isn't one CodeGraph recognizes. Map them with an optional `codegraph.json` at your project root:

```json
{
  "extensions": {
    ".dota_lua": "lua",
    ".tpl": "php"
  }
}
```

Each value is a supported language id. The mappings merge on top of the built-in defaults and win on conflict, so you can also re-point a built-in (e.g. `".h": "cpp"`). Commit the file to share the mapping with your team.

A typo'd language or a malformed file is warned about and skipped — it never breaks indexing — and a project with no `codegraph.json` behaves exactly as before. Re-index (`codegraph index`) after adding or changing mappings.

## Where data lives

Per-project data lives in a `.codegraph/` directory at your project root, containing the SQLite database (`codegraph.db`). Nothing leaves your machine.
