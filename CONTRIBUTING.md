# Contributing to CodeGraph

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- **Node.js** >= 20.0.0 (recommended: 22 LTS). Node 25.x is not supported due to a V8 WASM bug.
- **npm** (comes with Node)
- **C compiler** (for `better-sqlite3` native addon) — on macOS this is Xcode Command Line Tools; on Linux, `build-essential`.

## Setup

```bash
git clone https://github.com/colbymchenry/codegraph.git
cd codegraph
npm install
npm run build
npm test
```

## Project Structure

```
src/
├── index.ts                  # Public API — CodeGraph class
├── types.ts                  # NodeKind, EdgeKind, Language, etc.
├── db/                       # SQLite (better-sqlite3 + wasm fallback), schema.sql
├── extraction/               # Tree-sitter parsing pipeline
│   ├── index.ts              # ExtractionOrchestrator (file scanning, batching)
│   ├── tree-sitter.ts        # TreeSitterExtractor (generic AST walker)
│   ├── tree-sitter-types.ts  # LanguageExtractor interface
│   ├── grammars.ts           # WASM grammar loading, EXTENSION_MAP, detectLanguage()
│   ├── languages/            # Per-language extractor configs (one file per language)
│   └── wasm/                 # Vendored .wasm grammars (when tree-sitter-wasms is stale)
├── resolution/               # Reference resolution (imports, names, frameworks)
│   └── frameworks/           # Framework-specific resolvers (Express, Rails, etc.)
├── graph/                    # GraphTraverser, GraphQueryManager
├── context/                  # ContextBuilder (markdown/JSON output for AI agents)
├── search/                   # FTS5 query parser
├── sync/                     # FileWatcher, git-hook helpers
├── mcp/                      # MCP server (tools.ts, transport.ts, server-instructions.ts)
├── installer/                # Multi-agent installer (targets/ for each agent)
├── bin/                      # CLI (commander)
└── ui/                       # Terminal UI (shimmer progress)
```

## How the Pipeline Works

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
            ↓
     ReferenceResolver (imports, name-matching, framework patterns)
            ↓
     GraphQueryManager / GraphTraverser (callers, callees, impact)
            ↓
     ContextBuilder (markdown/JSON for AI consumption)
```

## Common Contribution Types

### Adding a New Language

This is one of the most impactful contributions. You need to touch **6 files**:

1. **`src/types.ts`** — Add the language string to the `LANGUAGES` array (before `'unknown'`).

2. **`src/extraction/languages/<lang>.ts`** — Create a new file implementing the `LanguageExtractor` interface. Map tree-sitter AST node types to CodeGraph categories (`functionTypes`, `classTypes`, `methodTypes`, `importTypes`, etc.). See `java.ts` for a clean reference or `lua.ts` for a language with custom visitor logic.

3. **`src/extraction/languages/index.ts`** — Import your extractor and add it to the `EXTRACTORS` map.

4. **`src/extraction/grammars.ts`** — Three additions:
   - `WASM_GRAMMAR_FILES`: map your language to its `.wasm` filename
   - `EXTENSION_MAP`: map file extensions to your language
   - `getLanguageDisplayName`: add the human-readable name
   - If the grammar is NOT in `tree-sitter-wasms`, add your language to the vendored condition on the `wasmPath` line

5. **`src/extraction/wasm/`** — If vendoring, place the `.wasm` file here. Build it from the tree-sitter grammar source or download a prebuilt from the grammar's GitHub releases.

6. **`__tests__/extraction.test.ts`** — Add a `describe('<Language> Extraction', ...)` block testing class/method/function extraction, imports, and visibility.

After making changes:
```bash
npm run build
npx vitest run __tests__/extraction.test.ts -t "YourLanguage"
```

### Adding a New Framework Resolver

Framework resolvers connect code symbols to framework-specific patterns (e.g., Express routes to handler functions, Rails routes to controller actions).

1. Create `src/resolution/frameworks/<framework>.ts`
2. Implement the `FrameworkResolver` interface (see `express.ts` or `rails.ts` for examples)
3. Register it in `src/resolution/frameworks/index.ts`
4. Add tests in `__tests__/frameworks.test.ts`

### Adding a New Agent Target (Installer)

CodeGraph's installer supports multiple AI agents (Claude, Cursor, Codex, OpenCode). Adding a new target is **one file + one registry entry**.

1. Create `src/installer/targets/<agent>.ts` implementing the `AgentTarget` interface
2. Add an entry in `src/installer/targets/registry.ts`
3. Add tests in `__tests__/installer-targets.test.ts`

### Improving Search Quality

The FTS5 search is in `src/search/`. Improvements to tokenization, ranking, or diversification directly benefit every agent using CodeGraph.

## Build, Test, Run

```bash
npm run build           # tsc + copy schema.sql and *.wasm into dist/
npm run dev             # tsc --watch
npm run clean           # rm -rf dist

npm test                # vitest run (all tests)
npm run test:watch      # vitest watch mode

# Run a single test file
npx vitest run __tests__/extraction.test.ts

# Run tests matching a pattern
npx vitest run __tests__/extraction.test.ts -t "Python"
```

The `copy-assets` script (called from `build`) copies `src/db/schema.sql` and all `src/extraction/wasm/*.wasm` files into `dist/`. Any new SQL or grammar WASM must be copied or it won't ship.

## Code Style

- TypeScript strict mode is fully enabled (`strict: true`, `noUnusedLocals`, `noUnusedParameters`)
- No linting tools are currently configured — keep code consistent with surrounding patterns
- Prefer editing existing files over creating new ones
- Write no comments unless the **why** is non-obvious

## Tests

- Tests live in `__tests__/` and mirror the module they cover
- Tests create temp dirs with `fs.mkdtempSync` and clean up in `afterEach`
- Tests write real files and exercise real SQLite — there is no DB mocking
- When adding a language, test it with real code snippets (not empty files)

## Submitting a PR

1. Fork the repo and create a branch from `main`
2. Make your changes with tests
3. Ensure `npm test` passes
4. Open a PR against `main` with a clear description of what changed and why
5. Reference any related issues (e.g., `Closes #123`)

## Questions?

Open a [GitHub Discussion](https://github.com/colbymchenry/codegraph/discussions) or comment on an existing issue.
