---
title: How It Works
description: The extraction, storage, resolution, and auto-sync pipeline.
---

CodeGraph turns source code into a queryable graph in four stages.

```
files → Extraction (tree-sitter) → DB (nodes/edges/files)
            ↓
      Resolution (imports, name-matching, framework patterns)
            ↓
      Graph queries (callers, callees, impact)
            ↓
      Context building (markdown / JSON for AI consumption)
```

## 1. Extraction

[tree-sitter](https://tree-sitter.github.io/) parses source into ASTs. Language-specific queries extract **nodes** (functions, classes, methods, types…) and **edges** (calls, imports, extends, implements). Heavy parsing runs off the main thread.

## 2. Storage

Everything goes into a local SQLite database (`.codegraph/codegraph.db`) with FTS5 full-text search. CodeGraph uses native `better-sqlite3` when available and transparently falls back to a WASM backend; `codegraph status` shows which is live.

## 3. Resolution

After extraction, references are resolved: function calls → definitions, imports → source files, class inheritance, and framework-specific patterns. Some dynamic-dispatch boundaries (callbacks, observers, React re-render, JSX children) are bridged by synthesizers so flows connect end-to-end. See [Resolution & Frameworks](/codegraph/core-concepts/resolution/).

## 4. Auto-sync

The MCP server watches your project using native OS file events (FSEvents / inotify / ReadDirectoryChangesW). Changes are debounced, filtered to source files, and incrementally synced — the graph stays fresh as you code, with no configuration.
