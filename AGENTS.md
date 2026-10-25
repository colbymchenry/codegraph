# AGENTS.md

Canonical project guidance for coding agents working in this repository (Codex/Astra, Claude Code via `@AGENTS.md`, Cursor, etc.).

This root file carries the rules an agent can break without noticing, the architecture it needs to put code in the right place, and the skills index below. Task-specific procedures live in `.claude/skills/<name>/SKILL.md`; read the matching skill before that work. Longer validation methodology and the Excalidraw worked example also live in `docs/AGENTS.md`.

## Skills

Codex loads this file but not `.claude/skills/`, so this list is how the procedures reach every harness. Read the matching `SKILL.md` before the work it covers:

- `codegraph-build-validation` — build and test commands, the test suite layout and home sandbox, cross-platform validation (Docker for Linux, the real Windows VM).
- `codegraph-retrieval` — the evidence behind the retrieval rules, both explore budgets, dynamic-dispatch channels, validation methodology and the Excalidraw worked example.
- `codegraph-installer` — `src/installer/` internals, agent targets, the Cursor `--path` quirk.
- `codegraph-release` — changelog format and the release flow.
- `codegraph-issue-triage` — anchoring issues and external reports to released, merged and in-progress state.
- `add-lang` — adding tree-sitter language support end-to-end.
- `agent-eval` — benchmarking retrieval with vs without CodeGraph on a real repository.

## Project Overview

CodeGraph is a local-first code intelligence library + CLI + MCP server. It parses any supported codebase with tree-sitter, stores symbols/edges/files in SQLite (FTS5), and exposes a knowledge graph to AI agents (Claude Code, Cursor, Codex CLI, opencode) over MCP. Per-project data lives in `.codegraph/`. Extraction is deterministic — derived from AST, not LLM-summarized.

Distributed as `@colbymchenry/codegraph` on npm; same binary serves as installer, indexer, and MCP server.

## Build and test guards

- `npm run build` copies `src/db/schema.sql` and all `src/extraction/wasm/*.wasm` files into `dist/`. **A new SQL file or grammar wasm must be copied by `copy-assets` or it won't ship.**
- `ui/package.json` is deliberately `"private": true`: the component library is prepared, not published, and `scripts/pack-npm.sh` packs it only when `CODEGRAPH_PACK_UI=1`.
- Node engines are `>=20.0.0 <25.0.0`; there is a hard exit on Node 25.x and below 20.
- Behavior that differs by platform (path resolution, drive letters, `SENSITIVE_PATHS`, `%APPDATA%` config dirs, CRLF) must be gated, not assumed. Use `it.runIf(process.platform === 'win32')(...)` for Windows-only assertions and `it.runIf(process.platform !== 'win32')(...)` for POSIX-only ones — e.g. `/etc` is sensitive on POSIX but resolves to `C:\etc` (non-existent) on Windows, so an ungated `/etc` assertion fails on Windows. Validate the Windows side for real (see `codegraph-build-validation`); don't merge a Windows-gated test you haven't seen run.

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
- `src/db/` — `DatabaseConnection`, `QueryBuilder` (prepared statements), `schema.sql`, `sqlite-adapter.ts`. Backed by Node's built-in **`node:sqlite`** (`DatabaseSync`) — real SQLite with WAL + FTS5, exposed through a thin better-sqlite3-shaped adapter. The bundled runtime always ships Node ≥22.5, so `node:sqlite` is always available: **no native build step and no wasm fallback**. (Running from source needs Node ≥22.5.) `codegraph status` reports the live backend (`node-sqlite`, the sole backend).
- `src/extraction/` — `ExtractionOrchestrator`, tree-sitter wrappers, per-language extractors under `languages/` (one file per language), plus standalone extractors for non-tree-sitter formats (`svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` for Delphi). `parse-worker.ts` runs heavy parsing off the main thread.
- `src/resolution/` — `ReferenceResolver` orchestrates `import-resolver.ts` (with `path-aliases.ts` for tsconfig path aliases + cargo workspace member globs), `name-matcher.ts`, and `frameworks/` (Express, Laravel, Rails, FastAPI, Django, Flask, Spring, Gin, Axum, ASP.NET, Vapor, React Router, Next.js — `nextjs.ts`: pages and `route.ts` handlers from files, `router.push` / `redirect` / `NextResponse.redirect` as `navigates` edges, with `next-router-synthesizer.ts` for `<Link href>` — Expo Router, SvelteKit, Vue/Nuxt, Cargo workspaces). Frameworks emit `route` nodes and `references` edges. `callback-synthesizer.ts` holds the whole-graph synthesis passes (`SYNTH_PASSES`, merged in registry order — first-seen wins a duplicate pair) with the language gates; `tier-synthesizer.ts` is the cross-tier pass (a client's literal `fetch`/`axios` path onto its own route, a queue job onto its consumer, a bus / socket event onto its handler — `channel`, `tier`, `registeredAt` on every edge; registered before the in-process emitter pass so its more specific edge wins); `synth-utils.ts` has the helpers they share (`enclosingFn`, `enclosingValue`, `makeLineAt`). Express's `postExtract` composes `app.use('/prefix', router)` mounts onto a mounted file's route names, idempotently (the original path stays in `qualifiedName`).
- `src/graph/` — `GraphTraverser` (BFS/DFS, impact radius, path finding) and `GraphQueryManager` (high-level queries), plus the shared query-time derivations more than one surface renders: `named-symbol-flow.ts` (the one path finder, behind `codegraph_explore`'s Flow section and the viewer's Flow strip), `dynamic-boundary-report.ts` (where the graph stops), `type-hierarchy.ts` (ancestors/subtypes and the implementation count explore prints and the viewer draws),
  `dead-code.ts` (unreferenced symbols, and every reason a candidate is NOT claimed), `synthesized-hop.ts` (how a synthesized hop reads, in explore's Flow, the `codegraph_node` trail and ContextBuilder's call paths — a new synthesizer's wording goes here). A derivation that two callers render must live here, not in `ToolHandler` — two derivations eventually disagree.
- `src/context/` — `ContextBuilder` + formatter for markdown/JSON output.
- `src/search/` — full-text query parser and helpers for FTS5.
- `src/sync/` — `FileWatcher` (native FSEvents/inotify/RDCW) with debounce + filter, and git-hook helpers.
- `src/mcp/` — MCP server (`MCPServer`, `tools.ts`, `transport.ts`). `server-instructions.ts` is what the server returns in the MCP `initialize` response — keep it in sync with the user-facing tool guidance.
- `src/installer/` — `codegraph install`/uninstall and every agent target; internals in the `codegraph-installer` skill.
- `src/bin/codegraph.ts` — CLI (commander). Subcommands: `install`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `files`, `context`, `affected`, `serve --mcp`.
- `src/ui/` — terminal UI (shimmer progress, worker).
- `src/ui-server/` -- read-only JSON API for the `codegraph ui` browser viewer (`api/`: `node`, `flow`, `map`, `screens`, `steps`, `deadcode`, `trails`, `program`, ...) plus static server; Svelte viewer lives in `ui/` (see `docs/design/codegraph-ui-design-spec.md`). `screens`/`steps`/`program` share one fold (`via`/`when` via `graph/branch-guards.ts`); `api/effects.ts` curates calls that leave the index; `api/route-roots.ts` names where a route's code starts. Derivations rendered by more than one surface belong in `src/graph/`, not `ToolHandler`.
  **Not released yet:** `codegraph ui` / `web` are refused (and hidden from `--help`) unless `CODEGRAPH_UI=1` is set — `src/bin/viewer-gate.ts`. Viewer changelog entries wait in `docs/viewer-launch-changelog.md`, not under `[Unreleased]`. At launch: delete the gate, move those entries back, drop the "not released yet" notes from `site/`.

### NodeKind / EdgeKind

Defined in `src/types.ts`. Both extractors and resolvers must use these exact strings.

- **NodeKind**: `file`, `module`, `class`, `struct`, `interface`, `trait`, `protocol`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`, `union`.
- **EdgeKind**: `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.

### MCP server instructions

`src/mcp/server-instructions.ts` is sent back to the agent in the MCP `initialize` response. This is the *first* thing every agent sees about how to use the tools, and as of issue #529 it is the **single source of truth** for agent-facing tool guidance. The installer's instructions-file block (`instructions-template.ts`, see `codegraph-installer`) only names the tool and the CLI for subagents and non-MCP agents; it does not repeat this guidance. Edit tool guidance here and nowhere else.

## Retrieval performance (do not regress)

An agent falls back to Read/Grep the instant a codegraph answer is insufficient. A flow question should resolve in **1 codegraph call on small repos, scaling to 3–5 on large**, with **Read/Grep = 0**; judge every change by **wall-clock latency and tool-call count**, not token cost.

- **Don't try to change the agent's tool choice** through instructions or new tools. Make the tool it already calls answer better from the input it already gives.
- Reserve `isError` for security refusals and real malfunctions. Every recoverable condition (project not indexed, symbol not found, file not in the index) returns **success-shaped guidance**, and the tools stay exposed at an un-indexed root.
- Explore output **never tells the agent to "use Read"**. Keep **both** explore budgets monotonic with indexed file count: a larger tier must never get fewer calls or a smaller `maxCharsPerFile` than a smaller tier.
- **Partial dynamic-dispatch coverage is worse than none**: bridge a flow end to end and re-measure, or don't ship it.
- Before adding or extending a router, a web framework, or a language's `WHEN` rules, read `docs/design/framework-coverage.md`, and update it in the same change.

Evidence, budget tables, the channel inventory and the worked example: `codegraph-retrieval`.

## House rules

- Any change to `src/installer/` (especially `targets/`) needs matching `__tests__/installer-targets.test.ts` coverage and a CHANGELOG entry — installer regressions break every new install silently. Details: `codegraph-installer`.
- When changing what the MCP tools do or how agents should use them, edit `src/mcp/server-instructions.ts` — it is the **single source of truth** for agent-facing tool guidance (issue #529). The installer's short instructions-file block (`instructions-template.ts`) only names `codegraph_explore` and the `codegraph explore` CLI; update it only when a tool or CLI command is renamed or removed. (The repo's own checked-in `.cursor/rules/codegraph.mdc` is dogfooding config — update it too if you use Cursor on this repo, but it ships nowhere.)
- CodeGraph provides **code context**, not product requirements. For new features, ask the user about UX, edge cases, and acceptance criteria — the graph won't tell you.
- Before agreeing that a reported problem is unfixed, anchor the report to released, merged-but-unreleased or in-progress state — a comment made before a release is reacting to released state. Details: `codegraph-issue-triage`.
- Changelog and release work: read `codegraph-release` first. **Do not run `npm publish`, `git push`, or `git tag` yourself** — these are publish actions on shared state. Write the files, hand the user the commands.
- **Version-tag every image referenced in `README.md`.** GitHub caches README images (`raw.githubusercontent.com` with a 5-minute TTL; third-party hosts sit behind the long-lived camo proxy), so updating an asset in place can keep showing the stale version. Give each README image URL a `?v=N` query tag and **bump `N` in the same commit whenever the asset bytes change** — e.g. `assets/waitlist.svg?v=2`. The changed URL sidesteps every cache so the new image shows immediately instead of waiting on a TTL to expire.
