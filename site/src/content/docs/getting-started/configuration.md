---
title: Configuration
description: CodeGraph is zero-config — here's what that means in practice.
---

There isn't any — CodeGraph is **zero-config**. It indexes every file whose extension maps to a [supported language](/codegraph/reference/languages/) and **respects your `.gitignore`**: in git repos via git itself, and in non-git projects by reading `.gitignore` files directly (root and nested, the same way git would).

## What that means in practice

- Anything git ignores — `node_modules`, build output, secrets in `.env` — is never indexed. **To keep something out of the graph, add it to `.gitignore`.**
- There's no config file to write or keep in sync, and nothing to wire up per language: support is automatic from the file extension.
- Files larger than 1 MB are skipped (generated bundles, minified JS, vendored blobs) — they cost parse budget for no useful symbols.

:::note
Committed files that aren't gitignored *are* indexed, even under `vendor/` or a committed `dist/`. If you commit a dependency or build directory you don't want in the graph, add it to `.gitignore`.
:::

## Where data lives

Per-project data lives in a `.codegraph/` directory at your project root, containing the SQLite database (`codegraph.db`). Nothing leaves your machine.
