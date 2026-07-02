# CodeGraph Qt

CodeGraph Qt is a fork of CodeGraph with added Qt/QML and Qt Widgets code
intelligence for AI coding agents.

It builds a local SQLite knowledge graph for a project, indexes symbols and
relationships with tree-sitter, and exposes that graph through a CLI and MCP
server. The CLI command remains `codegraph`.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Install

This fork is not published to npm yet. Until it is published, install it from
this repository:

```bash
git clone https://github.com/zren-zing/codegraph-qt.git
cd codegraph-qt
npm install
npm run build
npm install -g .
```

For local development, you can use a global symlink instead:

```bash
npm run build
npm link
```

After either local install method, the executable is:

```bash
codegraph
```

## Requirements

Source and local-install usage requires Node.js `>=20.0.0 <25.0.0`. A future
npm release path can also use self-contained platform bundles that include
their own Node runtime.

For embedded library usage, the host runtime needs Node.js 22.5 or newer when
opening a graph, because CodeGraph uses Node's built-in `node:sqlite` adapter.

Supported operating systems:

- Windows x64 / arm64
- macOS x64 / arm64
- Linux x64 / arm64

## Quick Start

1. Configure your AI agent:

```bash
codegraph install
```

2. Build a graph for each project you want indexed:

```bash
cd your-project
codegraph init
```

3. Ask structural questions through your configured MCP agent, or use the CLI:

```bash
codegraph explore "how does login reach the database"
codegraph node UserService
codegraph callers authenticate
codegraph impact UserService
```

CodeGraph stores project data in a local `.codegraph/` directory. It watches
files and keeps the graph up to date after initialization.

## Qt Support

This fork adds focused Qt coverage on top of the original CodeGraph language
support.

### QML / Qt Quick

QML support includes:

- QML component extraction
- ids, properties, signals, handlers, and local references
- QML-internal static call/reference edges
- local JavaScript helper imports
- `qmldir` module imports
- literal dynamic loads such as `Loader.source`, `Loader.setSource(...)`, and
  `Qt.createComponent(...)`
- explicit Qt/C++ bridge facts, including registered QML types, singletons,
  context properties, `Q_INVOKABLE` methods, slots, properties, and signals

The QML grammar is shipped as a vendored WASM asset in this repository. There is
no runtime dependency on a separate QML grammar npm package.

### Qt Widgets

Qt Widgets support includes:

- C++ meta-object facts
- typed member-pointer `connect(...)` calls
- legacy `SIGNAL(...)` / `SLOT(...)` calls
- `QTimer::singleShot(...)`
- `QMetaObject::invokeMethod(...)`
- lambda/functor receiver calls
- `.ui` files and `connectSlotsByName(...)` auto-connect conventions

Qt analysis is intentionally conservative. Runtime-built names, moc execution,
full C++ overload emulation, and arbitrary dynamic QML strings are not treated
as resolved facts unless the source contains enough static evidence.

## Common Commands

```bash
codegraph install                 # Configure supported agents
codegraph uninstall               # Remove CodeGraph from configured agents
codegraph init [path]             # Build a project graph
codegraph index [path]            # Rebuild the graph
codegraph sync [path]             # Incrementally update the graph
codegraph status [path]           # Show graph status and statistics
codegraph explore <query>         # Return relevant source and call paths
codegraph node <symbol|file>      # Show one symbol or file
codegraph callers <symbol>        # Find callers
codegraph callees <symbol>        # Find callees
codegraph impact <symbol>         # Analyze blast radius
codegraph telemetry [on|off]      # Show or change telemetry settings
codegraph upgrade [version]       # Upgrade the installed CLI
```

## Supported Agents

The installer can configure these agent environments when present:

- Claude Code
- Cursor
- Codex CLI
- opencode
- Hermes Agent
- Gemini CLI
- Antigravity IDE
- Kiro

## Supported Languages

| Language | Extensions / source | Notes |
|---|---|---|
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` | Functions, classes, imports, calls, React patterns |
| Python | `.py` | Functions, classes, imports, Flask/FastAPI patterns |
| Go | `.go` | Packages, functions, methods, imports |
| Rust | `.rs` | Functions, structs, traits, impls, modules |
| Java | `.java` | Classes, methods, imports, Spring patterns |
| C# | `.cs` | Classes, methods, properties, ASP.NET patterns |
| PHP | `.php` | Functions, classes, methods, Laravel patterns |
| Ruby | `.rb` | Classes, methods, Rails patterns |
| C / C++ | `.c`, `.h`, `.cpp`, `.hpp`, `.cc` | Functions, classes, methods, includes |
| Objective-C | `.m`, `.mm`, `.h` | Classes, protocols, methods, message sends |
| Swift | `.swift` | Types, methods, calls, Swift/ObjC bridge support |
| Kotlin | `.kt`, `.kts` | Classes, functions, methods |
| Scala | `.scala`, `.sc` | Classes, traits, methods, Scala 3 enums |
| Dart | `.dart` | Classes, functions, methods |
| Lua / Luau | `.lua`, `.luau` | Functions, methods, requires, Luau type aliases |
| R | `.R`, `.r` | Functions, classes, libraries, source references |
| Svelte | `.svelte` | Script extraction and SvelteKit routes |
| Vue | `.vue` | Script extraction, Nuxt pages/API/middleware routes |
| Astro | `.astro` | Frontmatter, scripts, components, `src/pages` routes |
| Liquid | `.liquid` | Shopify Liquid templates |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr` | Classes, records, interfaces, form files |
| QML / Qt Quick | `.qml` | QML component and Qt/C++ bridge extraction |
| Qt Widgets | C++ and `.ui` files | Signal/slot and UI auto-connect relationships |

## Limitations

CodeGraph is a static analysis tool. It favors conservative, explainable edges
over guessing.

For Qt/QML, the following are intentionally limited or unsupported unless there
is enough static evidence in source:

- runtime-built QML URLs
- arbitrary `Qt.createQmlObject(...)` strings
- inline `sourceComponent` block execution
- moc execution
- full C++ overload emulation
- dynamic meta-object behavior that only exists at runtime
- factory-return context-property inference without a declared QObject class

If CodeGraph cannot prove a relationship statically, it generally leaves the
edge unresolved rather than fabricating a misleading connection.

## Telemetry

Telemetry is default-off in this fork.

Nothing is sent unless telemetry is explicitly enabled and
`CODEGRAPH_TELEMETRY_ENDPOINT` points to an endpoint you control.

```bash
codegraph telemetry on
export CODEGRAPH_TELEMETRY_ENDPOINT=https://your-domain.example/v1/events
```

Any of these disables telemetry:

```bash
codegraph telemetry off
export CODEGRAPH_TELEMETRY=0
export DO_NOT_TRACK=1
```

See [TELEMETRY.md](TELEMETRY.md) for the exact schema and data handling rules.

## Troubleshooting

### `codegraph` is not found after install

Open a new terminal so your shell reloads `PATH`. If it still fails, check the
global npm bin directory:

```bash
npm bin -g
```

### Agent does not see CodeGraph tools

Run the installer again:

```bash
codegraph install
```

Then restart the agent. The installer writes MCP configuration for supported
agents, but it does not index projects. Each project still needs `codegraph init`.

### CodeGraph says the project is not initialized

Run:

```bash
codegraph init
```

The command creates the local `.codegraph/` directory and builds the first graph.

### Changes do not appear in results

The MCP server auto-syncs after file changes. If you need to force a refresh:

```bash
codegraph sync
```

After changing extraction logic in this repository, rebuild and force a re-index
in the target project:

```bash
npm run build
npm install -g .
cd your-project
codegraph index --force
```

### Indexing is slow

Check that dependency and build directories are excluded. CodeGraph already
skips common directories such as `node_modules`, `dist`, `build`, `target`,
`.venv`, and similar generated folders. Add project-specific generated folders
to `.gitignore` or `codegraph.json`.

## Development

Useful commands for working on this repository:

```bash
npm run build
npm test
npx vitest run __tests__/extraction.test.ts -t "QML"
npx vitest run __tests__/qml-integration.test.ts
npx vitest run __tests__/qt-widgets-integration.test.ts
```

Runtime assets that must ship, such as SQL files and vendored grammar WASM
files, are copied by the `copy-assets` script in `package.json`.

## Publishing This Fork

This repository is configured for:

- GitHub repository: `zren-zing/codegraph-qt`
- npm package: `@zren-zing/codegraph-qt`
- CLI binary: `codegraph`

The package has not been published to npm yet, so commands such as
`npm i -g @zren-zing/codegraph-qt` and `npx @zren-zing/codegraph-qt` will not
work until the first publish is complete. Use the local install steps above for
now.

When the scoped package is ready for its first public publish, use:

```bash
npm publish --access public
```

Before publishing, run:

```bash
npm test
npm run build
npm pack --dry-run
```

The package build copies SQL and vendored grammar WASM assets into `dist/`.
Keep `copy-assets` in `package.json` aligned with any shipped runtime assets.

## Attribution

CodeGraph Qt is a fork of
[CodeGraph](https://github.com/colbymchenry/codegraph) by Colby Mchenry,
originally licensed under the MIT License.

This fork adds Qt/QML and Qt Widgets language intelligence. The original MIT
copyright notice is preserved in [LICENSE](LICENSE).

## License

MIT. This distribution includes original CodeGraph code copyrighted by Colby
Mchenry under the MIT License, plus modifications in this fork. See
[LICENSE](LICENSE) for the full license text.
