---
title: Introduction
description: What CodeGraph is, and why it makes AI coding agents faster and cheaper.
---

CodeGraph is a **local-first code-intelligence tool**. It parses your codebase with [tree-sitter](https://tree-sitter.github.io/), stores every symbol, edge, and file in a local SQLite database, and exposes the result as a queryable **knowledge graph** — over the [Model Context Protocol (MCP)](/codegraph/reference/mcp-server/), a CLI, and a TypeScript library.

It exists to make AI coding agents — Claude Code, Cursor, Codex CLI, opencode, and Hermes Agent — **answer structural questions without scanning files**. Instead of fanning out across `grep`, `glob`, and `Read` to reconstruct how code fits together, an agent queries a pre-built index and gets the answer in a handful of calls.

## Why it matters

When an agent explores a codebase, it spends most of its budget on *discovery* — finding the right files before it can read them. CodeGraph removes that step: symbol relationships, call graphs, and structure are already indexed.

Tested across 7 real-world open-source codebases (median of 4 runs per arm), giving an agent CodeGraph was on average:

- **35% cheaper**
- **57% fewer tokens**
- **46% faster**
- **71% fewer tool calls**

The gains scale with codebase size — on large repos the agent answers from the index with **zero file reads**.

## What's in the graph

- **Symbols** — functions, classes, methods, types, routes, components, and more.
- **Edges** — calls, imports, inheritance, references, and framework-specific relationships.
- **Files** — structure plus full-text search (FTS5).

Extraction is **deterministic** — derived from the AST, never LLM-summarized.

## 100% local

No data leaves your machine. No API keys, no external services — just a SQLite database in `.codegraph/`.

Ready to try it? Head to the [Quickstart](/codegraph/getting-started/quickstart/).
