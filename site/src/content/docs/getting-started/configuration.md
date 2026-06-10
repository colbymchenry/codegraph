---
title: Configuration
description: CodeGraph is zero-config — there are no config files.
---

There isn't any — CodeGraph is **zero-config**, with **no config file** to write or keep in sync. Language support is automatic from the file extension; there's nothing to wire up per language.

## What it skips out of the box

- **Dependency, build, and cache directories** — `node_modules`, `vendor`, `dist`, `build`, `target`, `.venv`, `Pods`, `.next`, and the like across every [supported stack](/codegraph/reference/languages/) — so the graph is your code, not third-party noise. This holds even with no `.gitignore`.
- **Anything in your `.gitignore`** — honored in git repos via git, and in non-git projects by reading `.gitignore` directly (root and nested).
- **Files larger than 1 MB** — generated bundles, minified JS, vendored blobs.

## Excluding or including more

To keep something else out, add it to `.gitignore`. To pull a default-excluded directory back **in** (e.g. you really want a vendored dependency indexed), add a negation — `!vendor/`.

The defaults apply uniformly, so committing a dependency or build directory doesn't force it into the graph — the `.gitignore` negation is the explicit opt-in.

## Where data lives

Per-project data lives in a `.codegraph/` directory at your project root, containing the SQLite database (`codegraph.db`). Nothing leaves your machine.
