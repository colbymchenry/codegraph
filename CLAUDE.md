# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CodeGraph is a local-first code intelligence library + CLI + MCP server. It parses any supported codebase with tree-sitter, stores symbols/edges/files in SQLite (FTS5), and exposes a knowledge graph to AI agents (Claude Code, Cursor, Codex CLI, opencode) over MCP. Per-project data lives in `.codegraph/`. Extraction is deterministic — derived from AST, not LLM-summarized.

Distributed as `@colbymchenry/codegraph` on npm; same binary serves as installer, indexer, and MCP server.

## Build, Test, Run

```bash
npm run build           # tsc + copy schema.sql and *.wasm into dist/; chmods dist/bin/codegraph.js
npm run dev             # tsc --watch
npm run clean           # rm -rf dist

npm test                # vitest run (all)
npm run test:watch
npm run test:eval       # only __tests__/evaluation/
npm run eval            # build then run __tests__/evaluation/runner.ts via tsx

npm run cli             # build then run the local dist binary

# Single test file / pattern
npx vitest run __tests__/installer-targets.test.ts
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

`copy-assets` (called from `build`) copies `src/db/schema.sql` and all `src/extraction/wasm/*.wasm` files into `dist/`. **Any new SQL or grammar wasm must be copied or it won't ship.**

Node engines: `>=18.0.0 <25.0.0`. There is a hard exit on Node 25.x (see `src/bin/node-version-check.ts`).

## Architecture

### Layered pipeline

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

The public API surface is `src/index.ts` — the `CodeGraph` class wires all the layers and re-exports types. Library users only touch this file; the MCP server and CLI also drive it.

### Module layout

- `src/index.ts` — `CodeGraph` class: `init`/`open`/`close`, `indexAll`, `sync`, `searchNodes`, `getCallers`/`getCallees`, `getImpactRadius`, `buildContext`, `watch`/`unwatch`.
- `src/db/` — `DatabaseConnection`, `QueryBuilder` (prepared statements), `schema.sql`. Backed by `better-sqlite3` (native) when available, transparently falls back to `node-sqlite3-wasm`. `codegraph status` surfaces which backend is live; wasm is the slow path.
- `src/extraction/` — `ExtractionOrchestrator`, tree-sitter wrappers, per-language extractors under `languages/` (one file per language), plus standalone extractors for non-tree-sitter formats (`svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` for Delphi). `parse-worker.ts` runs heavy parsing off the main thread.
- `src/resolution/` — `ReferenceResolver` orchestrates `import-resolver.ts` (with `path-aliases.ts` for tsconfig path aliases + cargo workspace member globs), `name-matcher.ts`, and `frameworks/` (Express, Laravel, Rails, FastAPI, Django, Flask, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, Vue/Nuxt, Cargo workspaces). Frameworks emit `route` nodes and `references` edges.
- `src/graph/` — `GraphTraverser` (BFS/DFS, impact radius, path finding) and `GraphQueryManager` (high-level queries).
- `src/context/` — `ContextBuilder` + formatter for markdown/JSON output.
- `src/search/` — full-text query parser and helpers for FTS5.
- `src/sync/` — `FileWatcher` (native FSEvents/inotify/RDCW) with debounce + filter, and git-hook helpers.
- `src/mcp/` — MCP server (`MCPServer`, `tools.ts`, `transport.ts`). `server-instructions.ts` is what the server returns in the MCP `initialize` response — keep it in sync with the user-facing tool guidance.
- `src/installer/` — see below.
- `src/bin/codegraph.ts` — CLI (commander). Subcommands: `install`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `files`, `context`, `affected`, `serve --mcp`.
- `src/ui/` — terminal UI (shimmer progress, worker).

### NodeKind / EdgeKind

Defined in `src/types.ts`. Both extractors and resolvers must use these exact strings.

- **NodeKind**: `file`, `module`, `class`, `struct`, `interface`, `trait`, `protocol`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`.
- **EdgeKind**: `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.

### Multi-agent installer

`src/installer/` is the entry point for `codegraph install` (and the bare `codegraph`/`npx @colbymchenry/codegraph` invocation). Architecture:

- `targets/registry.ts` lists every supported agent.
- `targets/types.ts` defines the `AgentTarget` interface — adding a 5th agent (Continue, Zed, Windsurf…) is **one new file in `targets/` + one entry in `registry.ts`**. Each target owns its config-file location, MCP-server JSON/TOML/JSONC writing, and instructions-file path.
- Current targets: `claude.ts`, `cursor.ts`, `codex.ts`, `opencode.ts`.
- `targets/toml.ts` is a hand-rolled TOML serializer scoped to `[mcp_servers.codegraph]` (used by Codex). Sibling tables and `[[array_of_tables]]` are preserved verbatim. No new dependency.
- opencode reads `opencode.jsonc` by default; the installer prefers existing `.jsonc`, falls back to `.json`, and creates `.jsonc` for greenfield installs. Edits are surgical via `jsonc-parser` so user comments and formatting survive install/re-install/uninstall round-trips.
- `instructions-template.ts` is the agent-agnostic instructions file written to each target (e.g. `CLAUDE.md`, `.cursor/rules/codegraph.mdc`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`). It explicitly says "trust codegraph results, don't re-verify with grep" — earlier versions prescribed Claude-specific "spawn an Explore agent" and confused other agents.
- `claude-md-template.ts` is the legacy Claude-only template, retained for compatibility paths.
- All installer changes need matching coverage in `__tests__/installer-targets.test.ts` — there are ~47 parameterized contract tests covering install idempotency, sibling preservation, uninstall reverses install, byte-equal re-runs returning `unchanged`, and partial-state recovery for Codex.

### Cursor MCP working-directory quirk

Cursor launches MCP subprocesses with the wrong cwd and doesn't pass `rootUri` in `initialize`. The installer injects `--path` into Cursor's MCP args — absolute path for local installs, `${workspaceFolder}` for global installs. If you touch Cursor wiring, preserve this.

### MCP server instructions

`src/mcp/server-instructions.ts` is sent back to the agent in the MCP `initialize` response. This is the *first* thing every agent sees about how to use the tools — treat it as the authoritative tool guidance and keep it in sync with `instructions-template.ts` and `.cursor/rules/codegraph.mdc`.

## Tests

Tests live in `__tests__/` and mirror the module they cover. Notable ones beyond the obvious:

- `installer-targets.test.ts` — parameterized contract suite across all 4 agent targets (see installer notes above).
- `evaluation/` — `runner.ts` + `test-cases.ts` exercise codegraph against synthetic projects and score the results; run via `npm run eval` (builds first). Not part of `npm test`.
- `sqlite-backend.test.ts` — covers native + wasm backend selection and fallback.
- `pr19-improvements.test.ts`, `frameworks-integration.test.ts` — regression coverage for specific past PRs/incidents; don't rename these, the names anchor to git history.

Tests create temp dirs with `fs.mkdtempSync` and clean up in `afterEach`. They write real files and exercise real SQLite — there is no DB mocking.

### Windows-gated tests

Behavior that differs by platform (path resolution, drive letters, `SENSITIVE_PATHS`, `%APPDATA%` config dirs, CRLF) must be gated, not assumed. Use `it.runIf(process.platform === 'win32')(...)` for Windows-only assertions and `it.runIf(process.platform !== 'win32')(...)` for POSIX-only ones — e.g. `/etc` is sensitive on POSIX but resolves to `C:\etc` (non-existent) on Windows, so an ungated `/etc` assertion fails on Windows. Validate the Windows side for real (see below); don't merge a Windows-gated test you haven't seen run.

## Windows validation (Parallels + SSH)

For any Windows-specific PR, bug, or implementation, validate it on the real Windows VM rather than guessing. Connection details live in the gitignored **`.parallels`** file at the repo root (VM name, guest IP, SSH user/key). `prlctl exec` needs Parallels Pro and is unavailable, so SSH is the bridge.

- Connect / run from the Mac host: `ssh <user>@<guest_ip> "..."`. For multi-line work, pipe PowerShell over stdin and **refresh PATH from the registry** first (sshd's session has a stale PATH after winget installs):
  ```
  ssh colby@10.211.55.3 "powershell -NoProfile -ExecutionPolicy Bypass -Command -" <<'PS'
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  Set-Location C:\dev\codegraph
  PS
  ```
- Clone fresh into a **Windows-local** path (`C:\dev\codegraph`) and `npm ci` there — never run npm against the shared Mac repo, since `esbuild`/`rollup` ship platform-specific binaries.
- Guest toolchain (winget): Node LTS, Git, and the **VC++ ARM64 redistributable** (required by `@rollup/rollup-win32-arm64-msvc`, which vitest pulls in).
- Fetch a contributor PR head straight from their fork to dodge `pull/<n>/head` lag: `git fetch <fork-url> <branch>` then `git checkout -f FETCH_HEAD`.
- Known pre-existing Windows failure: `security.test.ts > Session marker symlink resistance > does not follow a pre-planted symlink` (symlink creation needs privileges on Windows). Unrelated to current work; don't let it mask new regressions.

## Releases

Released to npm and mirrored as [GitHub Releases](https://github.com/colbymchenry/codegraph/releases). `CHANGELOG.md` is the source of truth; GitHub Release notes are extracted from it.

### Writing changelog entries

When asked for an entry for a new version:

1. Add a new `## [X.Y.Z] - YYYY-MM-DD` block at the **top** of `CHANGELOG.md` (under the intro, above the previous version).
2. Group under `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security` — omit empty sections.
3. Write from the **user's perspective**, not the implementation's. Lead with the observable symptom or capability; mention internals only if a user needs them (e.g., to work around an existing bad install).
4. Add the link reference at the bottom: `[X.Y.Z]: https://github.com/colbymchenry/codegraph/releases/tag/vX.Y.Z`.

### Release flow (the user runs these)

Releases are built and published by the **GitHub Actions "Release" workflow**
(`.github/workflows/release.yml`). It bundles a Node runtime per platform
(`scripts/build-bundle.sh`) and publishes both the GitHub Release and the npm
thin-installer (`scripts/pack-npm.sh`: a shim package + per-platform packages).
Publishing manually is **wrong** now — a plain `npm publish` ships the root
package (non-bundled), which breaks anyone on Node < 22.5.

After the changelog entry is written and `package.json` is bumped:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: X.Y.Z (<one-line summary>)"
git push
```

Then trigger **Actions → Release → Run workflow** (on `main`). It reads the
version from `package.json`, builds every platform bundle on one runner, creates
the GitHub Release with notes from the matching `CHANGELOG.md` section, and
publishes to npm. Requires the `NPM_TOKEN` repo secret.

**Do not run `npm publish`, `git push`, or `git tag` yourself** — these are
publish actions on shared state. Write the files, hand the user the commands.

## House rules

- The `0.7.x` line is in active multi-agent rollout. Any change to `src/installer/` (especially `targets/`) needs corresponding test coverage and a CHANGELOG entry — installer regressions break every new install silently.
- When changing what the MCP tools do or how agents should use them, update **all three** of `src/mcp/server-instructions.ts`, `src/installer/instructions-template.ts`, and `.cursor/rules/codegraph.mdc` — they're written to different places but say the same thing.
- CodeGraph provides **code context**, not product requirements. For new features, ask the user about UX, edge cases, and acceptance criteria — the graph won't tell you.
