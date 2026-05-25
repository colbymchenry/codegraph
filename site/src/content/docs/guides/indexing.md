---
title: Indexing a Project
description: Full index, incremental sync, and the file watcher.
---

## Initialize and index

```bash
cd your-project
codegraph init -i      # initialize + full index
```

`init` creates `.codegraph/`; `-i`/`--index` builds the index immediately. To initialize without indexing, drop the flag and run `codegraph index` later.

## Full vs. incremental

```bash
codegraph index           # full index of the whole project
codegraph index --force   # re-index from scratch
codegraph sync            # incremental — only changed files
```

`sync` is fast because it only reparses what changed. Use it after a branch switch or a batch of edits.

## Stay fresh automatically

When the MCP server is running, CodeGraph watches your project with native OS file events and syncs in the background — debounced, and filtered to source files only. You don't need to run `sync` by hand during an agent session.

## Check status

```bash
codegraph status
```

Reports node/edge/file counts, the active SQLite backend, and the journal mode.

## What gets indexed

Every file whose extension maps to a [supported language](/codegraph/reference/languages/), minus dependency/build directories excluded by default (`node_modules`, `vendor`, `dist`, …), anything your `.gitignore` excludes, and files over 1 MB. See [Configuration](/codegraph/getting-started/configuration/).
