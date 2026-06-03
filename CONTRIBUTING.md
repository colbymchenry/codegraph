# Contributing to CodeGraph

Thanks for your interest in contributing! This guide covers everything you need to
get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Architecture](#project-architecture)
- [Making Changes](#making-changes)
- [Adding a New Language](#adding-a-new-language)
- [Testing](#testing)
- [Commit Messages](#commit-messages)
- [Pull Requests](#pull-requests)
- [Reporting Issues](#reporting-issues)

---

## Code of Conduct

Be respectful and constructive. We're all here to build something useful.

## Getting Started

### Prerequisites

- **Node.js** >= 20.0.0, < 25.0.0 (Node 25.x has a V8 WASM JIT bug — see
  [#81](https://github.com/colbymchenry/codegraph/issues/81))
- **npm** (ships with Node)
- **Git**

### Fork and Clone

```bash
# Fork via GitHub UI, then:
git clone https://github.com/<your-username>/codegraph.git
cd codegraph
git remote add upstream https://github.com/colbymchenry/codegraph.git
```

### Install and Verify

```bash
npm install
npm run build
npm test
```

If all tests pass, you're ready to go.

## Development Setup

### Useful Commands

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript + copy assets into `dist/` |
| `npm run dev` | Watch mode — rebuilds on file change |
| `npm run clean` | Remove `dist/` |
| `npm test` | Run the full test suite (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run cli` | Build then run the local CLI binary |

### Running a Single Test

```bash
npx vitest run __tests__/extraction.test.ts -t "Groovy"
```

### Project Structure

```
src/
├── index.ts              # Public API (CodeGraph class)
├── types.ts              # Core type definitions (NodeKind, EdgeKind, Language)
├── db/                   # SQLite database layer (schema, queries)
├── extraction/           # Tree-sitter parsing and per-language extractors
│   ├── languages/        # One file per language (python.ts, go.ts, ...)
│   ├── tree-sitter.ts    # Core extraction engine
│   └── wasm/             # Vendored grammar .wasm files
├── resolution/           # Cross-file reference resolution
│   └── frameworks/       # Framework-specific resolvers (Express, Django, ...)
├── graph/                # Graph traversal (BFS/DFS, impact radius)
├── context/              # Context building for AI consumption
├── mcp/                  # MCP server implementation
├── installer/            # Multi-agent installer (Claude, Cursor, Codex, opencode)
├── search/               # FTS5 query parsing
├── sync/                 # File watcher and git hooks
└── bin/                  # CLI entry point
__tests__/                # Tests mirror the module they cover
docs/                     # Design docs, benchmarks, cookbooks
```

## Making Changes

### Branching

Always branch off `upstream/main`:

```bash
git checkout -b feat/my-feature upstream/main
```

Use descriptive branch names: `feat/`, `fix/`, `docs/`, `refactor/`.

### What to Edit

- **Types** (`src/types.ts`): `NodeKind`, `EdgeKind`, and `Language` are
  runtime-iterable `const` arrays. Changing them affects the entire pipeline.
- **Extractors** (`src/extraction/languages/`): Each language has its own file
  exporting a `LanguageExtractor` config. See
  [Adding a New Language](#adding-a-new-language).
- **MCP tools** (`src/mcp/`): Changes to tool behavior require updating all
  three of `server-instructions.ts`, `instructions-template.ts`, and
  `.cursor/rules/codegraph.mdc` — they're the same guidance written to different
  places.
- **Installer** (`src/installer/`): Adding a new agent target is one new file in
  `targets/` + one entry in `registry.ts`. All changes need test coverage in
  `__tests__/installer-targets.test.ts`.

### Build Verification

Before committing, always run:

```bash
npm run build && npm test
```

TypeScript strict mode is fully enabled — the compiler catches a lot. The build
also copies `.wasm` files and `schema.sql` into `dist/`; if you add new assets,
make sure `copy-assets` picks them up.

## Adding a New Language

There's a dedicated cookbook for this — see
[`docs/ADDING-A-LANGUAGE.md`](docs/ADDING-A-LANGUAGE.md). It walks through:

1. Sourcing a tree-sitter `.wasm` grammar
2. Probing the AST before writing code
3. Registering the language (one new file + two registry lines)
4. Writing the extractor (two patterns: `LanguageExtractor` config vs custom class)
5. Testing and PR checklist

## Testing

### Philosophy

Tests use **real files** and **real SQLite** — there is no DB mocking. Each test
creates a temp directory with `fs.mkdtempSync` and cleans up in `afterAll`/`afterEach`.

### Running Tests

```bash
npm test                          # full suite
npx vitest run __tests__/extraction.test.ts   # single file
npx vitest run -t "TypeScript"    # filter by test name
```

### Writing Tests

- Place tests in `__tests__/` mirroring the module they cover
- Use `extractFromSource(filename, code)` for extraction unit tests
- Use `it.runIf(process.platform === 'win32')(...)` for platform-gated tests
- Clean up temp dirs in `afterEach`/`afterAll`
- Don't skip or mock the database — integration tests must hit real SQLite

### Evaluation Tests

The `__tests__/evaluation/` directory has retrieval quality benchmarks. Run
with:

```bash
npm run eval    # builds first, then runs the evaluation runner
```

These are not part of the standard test suite and are run separately.

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`

**Common scopes:** `extraction`, `resolution`, `mcp`, `cli`, `installer`,
`watcher`, `npm`, `release`

**Examples:**

```
feat(extraction): add Groovy language support
fix(resolution): stream node-kind scans in synthesis to fix OOM
docs(readme): link to the website & docs site
chore: update vitest to v2.1.9
```

- Use the imperative mood ("add" not "added")
- Keep the subject line under 72 characters
- Reference issues with `Closes #123` or `Relates to #123` in the body

## Pull Requests

### Before Opening

1. Rebase on the latest `upstream/main`
2. Run `npm run build && npm test` — everything must pass
3. Run `npx tsc --noEmit` — no type errors
4. Keep changes focused — one concern per PR

### PR Description

Include:

- **What** changed and **why**
- Test plan (what you ran, what passed)
- Any known limitations or follow-up work
- For language additions: grammar source, version, license, and sha256 if
  vendored (see [docs/ADDING-A-LANGUAGE.md](docs/ADDING-A-LANGUAGE.md) §8)

### Review Process

- Maintainers may request changes — please respond to feedback
- Keep PRs up to date with `upstream/main` via rebase (not merge commits)
- Squash commits if the history is messy

## Reporting Issues

When filing a bug report, please include:

- CodeGraph version (`codegraph --version` or `npx @colbymchenry/codegraph --version`)
- Node.js version (`node --version`)
- Operating system and version
- Steps to reproduce
- Expected vs actual behavior
- Relevant log output or error messages

For feature requests, describe the use case and why existing functionality
doesn't cover it.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
