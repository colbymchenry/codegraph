# CodeGraph jcode Integration Plan & Architecture Review

**Status:** Plan / design document — no source code has been modified yet.  
**Date:** 2026-07-30  
**Author:** Jcode (analysis agent)  

---

## 1. Executive Summary

This document records the critical architecture problems found in the `D:\project\codegraph` repository and proposes a concrete integration plan for **jcode** (the Rust-based coding-agent harness at https://jcode.sh) that matches the existing Claude Code integration surface.

The primary goal is to make CodeGraph a first-class jcode citizen while **optimizing token consumption** (fewer, higher-quality tool calls) and **improving coding quality** (impact-aware edits, test-aware changes, and graph-driven context instead of blind grep/read loops).

---

## 2. Architecture Problems Found (Recorded, Not Fixed)

These were identified by static source analysis. `node_modules` was not present, so builds and tests were not executed.

### 2.1 Runtime dependency mismatch — hard crash on Node 20/21
- **Location:** `src/db/sqlite-adapter.ts` requires `node:sqlite`.
- **Issue:** `node:sqlite` is only available in Node **22.5+**, but `package.json` declares `"engines": { "node": ">=20.0.0 <25.0.0" }`.
- **Impact:** The package installs successfully on Node 20 and 21, then crashes at runtime when the database layer loads.
- **Severity:** Critical.

### 2.2 Circular module dependencies between the public API and MCP layer
- **Cycle:** `src/index.ts` exports `MCPServer` from `./mcp`; `src/mcp/engine.ts` and `src/mcp/tools.ts` import `CodeGraph` from `../index`.
- **Issue:** The public API and the MCP server layer are mutually dependent. While the imports are `type`-only today, the architecture is fragile and makes load-order reasoning and refactoring risky.
- **Severity:** High.

### 2.3 Massive god classes / files violating single-responsibility

| File | Approx. lines | Concerns mixed in one file |
|------|--------------|---------------------------|
| `src/extraction/tree-sitter.ts` | ~6,375 | All-language parsing, node/edge extraction, WASM grammar coordination |
| `src/mcp/tools.ts` | ~4,400 | Every MCP tool handler |
| `src/resolution/callback-synthesizer.ts` | ~3,591 | Multiple synthesis strategies |
| `src/extraction/index.ts` | ~2,574 | File scanning, git integration, ignore logic, framework detection, sync, store writing |
| `src/db/queries.ts` | ~2,321 | Entire SQL surface |
| `src/resolution/index.ts` | ~2,264 | Reference resolution, batching, caching |
| `src/resolution/name-matcher.ts` | ~2,181 | Name matching heuristics |
| `src/bin/codegraph.ts` | ~2,216 | All CLI commands in one function |
| `src/index.ts` | ~1,671 | `CodeGraph` facade that owns DB, extraction, resolution, graph, context, search |

- **Impact:** The codebase is hard to test, review, and extend. A single bug in one concern often requires understanding the whole file.
- **Severity:** High (maintainability crisis).

### 2.4 Multi-package repo without workspace tooling
- **Issue:** The repository contains three packages (`root`, `site`, `telemetry-worker`) each with their own `package.json` and `package-lock.json`. There is no `workspaces` field, no shared scripts, and no shared dependency management.
- **Impact:** The docs site and telemetry worker can drift out of sync with the core package; routine upgrades and security patches are manual.
- **Severity:** High.

### 2.5 Non-portable build script
- **Location:** `package.json` `"build:kernel": "bash scripts/build-kernel.sh"`.
- **Issue:** Requires a POSIX shell; fails on Windows without WSL. The current environment is Windows.
- **Severity:** Medium.

### 2.6 Storage layer typed as `any`
- **Location:** `src/db/sqlite-adapter.ts` defines `SqliteStatement`/`SqliteDatabase` with `any` for parameters, rows, and the private `_db` field.
- **Issue:** With `strict: true` enabled project-wide, this leaks unsafe typing into the entire persistence layer and undermines static analysis.
- **Severity:** Medium.

### 2.7 Misleading dependency declaration
- **Location:** `package.json` lists `@types/better-sqlite3` as a dev dependency but does not list `better-sqlite3` itself.
- **Issue:** The project uses `node:sqlite`, not `better-sqlite3`, so the types package is unnecessary and confusing.
- **Severity:** Medium.

---

## 3. jcode Integration Plan

### 3.1 Goal

Add jcode as a native installer target so that `codegraph install --target jcode` (or `--target=all`) produces the same first-class integration that already exists for Claude Code, Cursor, Codex CLI, opencode, etc.

In addition, optimize the integration for **jcode's specific design** to reduce token spend and raise code-change quality:

- jcode reads project instructions from **`AGENTS.md`** (repo root) and global instructions from **`~/AGENTS.md`**.
- jcode reads MCP servers from **`.jcode/mcp.json`** (project) and **`~/.jcode/mcp.json`** (global).
- jcode supports **stdio MCP servers only** (CodeGraph already ships as a stdio server).
- jcode has a **skill system** under `~/.jcode/skills/<skill>/SKILL.md` that auto-injects via semantic embedding when the conversation matches the skill topic.
- jcode renders **mermaid diagrams inline** and has a **side panel**, which can display structured CodeGraph output.
- jcode has slash commands (`/review`, `/test`, `/commit`) that naturally pair with CodeGraph's impact, affected-tests, and callers/callees tools.

### 3.2 Files the installer should write

For a **global** jcode install:
- `~/.jcode/mcp.json` — MCP server entry for `codegraph`.
- `~/AGENTS.md` — short, token-efficient CodeGraph instructions.
- `~/.jcode/skills/codegraph/SKILL.md` — optional skill for semantic auto-injection.

For a **project-local** jcode install:
- `.jcode/mcp.json` — project-local MCP server entry.
- `AGENTS.md` — project-root instructions (same content, but scoped to the repo).

### 3.3 Proposed code changes

1. **Extend the installer target abstraction**
   - Add `'jcode'` to the `TargetId` union in `src/installer/targets/types.ts`.

2. **Create `src/installer/targets/jcode.ts`**
   - Implement `AgentTarget` for jcode.
   - Write JSON MCP config to `~/.jcode/mcp.json` and `.jcode/mcp.json` using the `mcpServers` key.
   - Write the CodeGraph instructions block to `~/AGENTS.md` and `AGENTS.md` using the existing marker-delimited section helpers.
   - Optionally install/update the `~/.jcode/skills/codegraph/SKILL.md` skill file.
   - Implement `detect`, `install`, `uninstall`, `printConfig`, `describePaths`, and `supportsLocation` (jcode supports both global and local).

3. **Register the target**
   - Import `jcodeTarget` in `src/installer/targets/registry.ts` and add it to `ALL_TARGETS`.

4. **Add a jcode-optimized instructions block**
   - Either add a new exported block in `src/installer/instructions-template.ts` or make `upsertInstructionsEntry` accept a custom body.
   - The jcode block should be even shorter than the generic one and explicitly mention slash-command pairings (`/review`, `/test`, `/commit`) and the skill auto-injection behavior.

5. **Add tests**
   - Mirror the existing installer tests in `__tests__/` for the new target.

6. **Update documentation**
   - Add jcode to the README install matrix and `install --target` help.

### 3.4 Token-consumption optimization strategy

1. **One-shot tool preference**
   - Instruct jcode to call `codegraph_explore` once instead of chaining many `grep`/`read` calls. `explore` returns relevant symbols, source, and call paths in a single response.

2. **Bounded output by default**
   - Encourage use of `maxFiles`, `limit`, and `depth` parameters so responses fit in the context window without truncation.

3. **Avoid redundant reads**
   - Tell jcode that `codegraph_explore` and `codegraph_node` already return verbatim source with line numbers, so it should not re-read the same file to confirm line numbers.

4. **Skill-based conditional injection**
   - The `codegraph` skill is only injected when the conversation is about code exploration, impact, refactoring, or debugging. This prevents the instructions from being loaded into every unrelated turn.

5. **Concise instructions**
   - Keep the `AGENTS.md` block under ~40 lines and the `SKILL.md` under ~60 lines. jcode reads `AGENTS.md` every turn, so every extra line costs tokens.

### 3.5 Coding-quality optimization strategy

1. **Impact-first edits**
   - Before modifying a symbol, use `codegraph_impact` to identify affected callers and tests.

2. **Test-aware changes**
   - Use `codegraph_affected` (or the `affected` CLI) to find tests that should be run or updated after a change.

3. **Dependency-aware navigation**
   - Use `codegraph_callers` and `codegraph_callees` to understand how a symbol is used instead of guessing from imports.

4. **Freshness check**
   - Check `codegraph status` (or the MCP status tool) before relying on the graph; if the index is stale, run `codegraph sync` or `codegraph index`.

5. **Daemon/watch mode**
   - When running as an MCP server, CodeGraph's file watcher keeps the graph fresh. The instructions should tell jcode to rely on the daemon for incremental updates rather than re-triggering full indexing.

### 3.6 Optional future enhancements

1. **Mermaid output format**
   - Add a `format: 'mermaid'` option to `codegraph_impact` and `codegraph_callers`/`callees` so jcode can render call graphs and impact diagrams in the side panel. This is high-value for visual reasoning but is a new feature, not just installer wiring.

2. **jcode skill auto-endorsement**
   - If jcode exposes a way to endorse skills programmatically, the installer could register the `codegraph` skill so it appears in `/skills` recommendations.

3. **Memory-graph integration**
   - jcode already maintains a semantic memory graph. A future integration could push CodeGraph summaries into jcode memory so cross-session context survives without re-indexing.

---

## 4. Proposed Instruction Content

### 4.1 `AGENTS.md` block (loaded every turn — must be short)

```markdown
<!-- CODEGRAPH_START -->
## CodeGraph

In repositories with a `.codegraph/` directory at the root, use CodeGraph before grep or file reads when you need to understand, locate, or modify code:

- **Explore:** `codegraph_explore` returns the relevant symbols, their source, and the call paths between them in one call. Prefer it over separate grep/read chains.
- **Symbol focus:** `codegraph_node` gives one symbol's source plus its callers and callees.
- **Impact:** `codegraph_impact` before editing shows what a change would break.
- **Tests:** `codegraph_affected` finds test files that depend on changed source.
- **Status:** `codegraph_status` reports whether the index is fresh; if it is stale, run `codegraph sync` before exploring.

If no `.codegraph/` directory exists, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
```

### 4.2 `~/.jcode/skills/codegraph/SKILL.md` (auto-injected when relevant)

```markdown
# CodeGraph skill

Use when the user asks about code structure, impact, callers/callees, symbol search, refactoring, debugging, or finding tests for a change.

## One-shot exploration
- Prefer `codegraph_explore <query>` over a chain of `grep` + `read` calls. It returns ranked symbols, source snippets, and call paths in a single response.
- Use `maxFiles` to keep the response bounded.

## Before modifying code
1. Run `codegraph_impact <symbol>` to see affected callers and files.
2. Run `codegraph_affected <files...>` to find tests to update or run.
3. After the change, use `codegraph_status` to confirm the index is still fresh.

## Navigation
- `codegraph_node <symbol>` — source, callers, and callees for one symbol.
- `codegraph_callers <symbol>` / `codegraph_callees <symbol>` — focused traversal.
- `codegraph_status` — check index freshness and last indexed time.

## Avoid
- Do not re-read a file just to get line numbers when `codegraph_explore` or `codegraph_node` already returned the source.
- Do not run a full `codegraph index` unless the index is missing or the user explicitly asks; prefer `codegraph sync` for incremental updates.
```

---

## 5. Implementation Steps (Ready to Execute)

1. **Create `src/installer/targets/jcode.ts`**
   - Implement `JcodeTarget` class matching the `AgentTarget` interface.
   - Use `getMcpServerConfig()` from `./shared.ts` but omit the `type` field when writing to jcode's JSON config (jcode's example does not include `type`).
   - Use `upsertInstructionsEntry` (or a new jcode-specific helper) to write the `AGENTS.md` block.
   - Add a helper to write the skill file under `~/.jcode/skills/codegraph/SKILL.md`.

2. **Update `src/installer/targets/types.ts`**
   - Add `'jcode'` to `TargetId`.

3. **Update `src/installer/targets/registry.ts`**
   - Import and include `jcodeTarget` in `ALL_TARGETS`.

4. **Update `src/installer/instructions-template.ts` (optional)**
   - Add a `JCODE_CODEGRAPH_INSTRUCTIONS_BLOCK` that is shorter and slash-command aware.

5. **Add tests**
   - Add `__tests__/installer-jcode.test.ts` (or similar) covering install, uninstall, re-install idempotency, and `printConfig`.

6. **Update README and CLI help**
   - Add jcode to the supported agents list and `install --target` examples.

---

## 6. Risks & Dependencies

- **jcode only supports stdio MCP servers.** CodeGraph is already stdio-based, so this is compatible. HTTP/SSE variants are not needed.
- **jcode imports Claude Code configs on first run.** If a user already has CodeGraph configured via Claude Code, jcode may pick it up automatically. The installer should still write native `.jcode/mcp.json` for clarity and project scoping.
- **Skill auto-injection is semantic.** The `codegraph` skill will not fire on every turn, which is good for token savings, but the agent must still remember to use the MCP tools from `AGENTS.md` when the skill is not loaded. The `AGENTS.md` block therefore remains the primary driver.
- **AGENTS.md length matters.** Because jcode loads it every turn, the instructions block must stay concise. Over-instruction will directly increase token spend.
- **No permissions/approval layer in jcode.** Unlike Claude Code's `settings.json` permissions, jcode does not appear to require an explicit allowlist. The installer only needs to write MCP config and instructions.

---

## 7. Next Step / Decision

The architecture problems are recorded above. The jcode integration plan is ready to implement.

**Recommended execution order:**
1. Implement the jcode installer target (high value, low risk).
2. Add the jcode-specific instructions block and skill file.
3. Add tests and documentation.
4. After the integration is merged, tackle the recorded architecture issues in order of severity: Node engine mismatch, circular dependencies, workspace tooling, and then the large-scale god-class refactoring.

**Awaiting approval to proceed with implementation.**
