# Changelog

All notable changes to CodeGraph are documented here. Each entry also ships as
a [GitHub Release](https://github.com/colbymchenry/codegraph/releases) tagged
`vX.Y.Z`, which is where most people will look.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixes

- The background file watcher no longer exhausts your machine's file-descriptor budget. On macOS it previously kept **one open file handle per watched file**, so on a large project the running MCP server could pile up tens of thousands of handles and blow past the system-wide limit — at which point *unrelated* apps (your shell, editor, Docker, browser) started failing with "too many open files" until the codegraph process was killed. The watcher now uses a single recursive watch on macOS and Windows, and bounded per-directory watches on Linux, so its cost stays flat no matter how large the project is. (#644, #496, #555, #628, #579)

## [0.9.9] - 2026-06-02

### New Features

- `codegraph_explore` is now the primary tool, and one call is usually all an agent needs: it returns the verbatim source of the symbols relevant to your question (a plain question works as the query — you no longer need exact symbol names), grouped by file and Read-equivalent, so the agent answers without falling back to read/grep. The narrower `codegraph_context` and `codegraph_trace` tools were removed in favor of it — explore already surfaces the call flow among the symbols you name (the job trace did), so there's one obvious tool to reach for instead of three.
- `codegraph_explore` now includes a compact "Blast radius" for the symbols you're looking at — who depends on each (just the locations, not their source) and which test files cover it — so before editing, the agent can see what else to update and which tests to run, without a separate impact lookup. Symbols nothing depends on are skipped, so it stays short.
- Functions defined inside a store or handler object — the actions in a Zustand `create((set, get) => ({ … }))` store, and the same shape in Redux, Pinia, MobX, or any exported handler/route map — are now indexed as real symbols. Previously they existed only as object properties, so looking one up by name or asking who calls it returned "not found" and the agent had to read the whole store file to follow the flow; now `codegraph_node`, `codegraph_callers`, and `codegraph_explore` resolve them directly — including calls made through `useStore.getState().fetchUser()` or a destructured `const { fetchUser } = useStore.getState()`.
- `codegraph_explore` now surfaces the *right* definition when a method name is overloaded across types. Asking about, say, `DataRequest`'s `task` and `validate` used to return a same-named method from an unrelated file (or an abstract base stub) and bury the one you meant; explore now recognizes the type you named in the query and leads with that type's own overloads, in full.

### Fixes

- Search ranking no longer lets a common word in your request hijack the results: asking about, say, a "flat object" screen used to surface an unrelated constant that merely happened to be named the same, because the exact-name match outweighed everything else. Ranking now weighs how well each result is corroborated by the rest of your request, so the symbols you actually meant come first (this improves `codegraph_explore`'s results).
- `codegraph_node` now returns *every* definition when a name is ambiguous — an overloaded method, or the same method name on different types — instead of returning one (sometimes the wrong one) with a note listing the rest. Asking for such a symbol now hands back all of the matching definitions with their source in a single call, so the agent stops having to read the file by hand to find the specific overload it wanted (common in Swift, Go, Java, and C#). For a heavily-overloaded name (a `poll`/`validate` with dozens of definitions), pass `file` (and/or `line`) — e.g. the `file:line` shown in a trail — to get that exact definition's body. Large overload sets show the most relevant ones in full and list the remainder by location.
- `codegraph_explore` never returns half a method anymore: when output runs up against its size budget it drops whole methods or whole files (and lists what it dropped, so you can ask for them in another call) instead of cutting off a method body partway. A truncated method was the one case that still sent the agent to read the file for the rest — so the source explore returns is now always complete and usable as-is.

## [0.9.8] - 2026-06-01

### New Features

- `codegraph init` now builds the initial index by default — you no longer need the `-i`/`--index` flag (it's still accepted, so existing commands and scripts keep working). (#483)
- Go: Gin middleware chains now connect end-to-end in `codegraph_trace` and `codegraph_explore` — following a request reaches the middleware and route handlers registered via `.Use()` / `.GET()` instead of dead-ending where the framework dispatches the chain dynamically.
- `codegraph_explore` now sizes its response to the *answer* instead of the file count: it shows the mechanism and the exact methods you asked about in full — even when they're buried deep in a large file — while collapsing the redundant interchangeable implementations of an interface (an HTTP interceptor chain, a query-compiler family) down to signatures. Fewer tokens for a more complete answer, so on the flows that used to occasionally cost more than plain grep/read it's now clearly cheaper — and the win holds across small, medium, and large codebases. Distinct, non-interchangeable code is shown in full as before. Disable with `CODEGRAPH_ADAPTIVE_EXPLORE=0`.
- Swift deferred-validation flows (and similar "handler array" patterns) now connect end-to-end in `codegraph_trace` and `codegraph_explore` — following a request's lifecycle reaches the validators registered with `.validate { … }` instead of dead-ending where the framework runs them by iterating a stored list of closures. Any pattern where closures are appended to a collection and later invoked by looping over it is now traced.
- `codegraph_explore` now spells out the dynamic-dispatch relationships of the symbols you ask about — e.g. "the closures registered here are run by `didCompleteTask`" — so the indirect hops you'd otherwise grep to reconstruct are listed alongside the call flow.
- `codegraph_explore` answers multi-phase questions that span a large "god file" far more completely. For a flow like "build, send, and validate a request" — where one big file holds the build chain and the validate logic lives in others — it now keeps every method *on the flow path* in full, collapses the file's off-path methods to one-line signatures, and guarantees each phase's defining file is shown (instead of truncating at a fixed size and dropping whichever phase came last, which sent you to read it by hand). Incidental files that merely name-drop the flow are still trimmed, so the response stays focused on the code that answers the question.
- CodeGraph is usable as an embedded library again: `require("@colbymchenry/codegraph")` and `import` now resolve the programmatic API — the `CodeGraph` class plus building blocks like `DatabaseConnection`, `QueryBuilder`, `initGrammars`, and `FileLock` — so you can drive the graph directly from your own app (for example an Electron process) instead of only through the CLI or MCP server. Embedding runs on your own runtime, so it needs Node 22.5+ for the built-in SQLite. (#354)

### Fixes

- `codegraph_trace` now resolves an overloaded symbol name to its real implementation instead of an empty protocol/delegate stub. Tracing a flow through a heavily-overloaded API (common in Swift, Java, C#, and Go) could land on an unrelated no-op method that happened to share the name and report "no path"; it now picks the substantive definition the flow actually runs through.
- CodeGraph's MCP server now answers an agent's opening handshake the instant it launches instead of blocking while the index loads, so a fresh session's very first tool call no longer occasionally races a server that's still warming up and falls back to grep/read. The first question in a new session now reliably goes through CodeGraph.
- Indexing a project that contains only config-style files (YAML, Twig, or `.properties`) no longer misleadingly reports "No files found to index" — these files are tracked at the file level and are now counted as indexed. Thanks @luojiyin1987 (#357).

## [0.9.7] - 2026-05-28

### New Features

- Go: gRPC interface stubs now connect to their hand-written implementation, so callers, callees, impact, and trace land on the real method instead of an empty generated stub.
- Generated files (protobuf, gRPC stubs, mocks, build output) now rank last in search, trace, and explore, so results land on your real implementation instead of an auto-generated placeholder.
- When `codegraph_trace` can't find a static path (a dynamic-dispatch break), it now inlines both endpoints' source, callers, and callees in one response, so the agent gets the full picture without a flurry of follow-up calls.
- Trace now picks the right endpoints in large multi-module repos by preferring symbols that share a directory, instead of grabbing an arbitrary same-named symbol from an unrelated module.
- Test files are now deprioritized in `codegraph_explore` (Go, Ruby, JS/TS, Java/Kotlin/Scala), so the explore budget goes to your real implementation source.
- Small projects (under ~500 files) now resolve flow questions in fewer MCP calls, with a leaner tool surface and tuned context and explore output sized for the project.
- `codegraph_context` now auto-traces flow questions like "how does X reach Y" or "trace the path from A to B", splicing the trace into the response so you don't need a separate `codegraph_trace` call.
- `codegraph_context` now inlines a URL-to-handler routing table and the source of your main routes file for routing questions on small projects, so you don't have to go read `routes.rb` or `web.php` yourself.
- `codegraph_context` search now boosts results in the directory of a project's core framework file, so a small same-named extension file no longer outranks the actual framework core.
- Interface-to-implementation linking now works for C#, TypeScript, JavaScript, Swift, and Scala (previously Java/Kotlin only), so investigating an interface method surfaces its concrete implementations.
- MCP tool descriptions are now shorter, trimming per-session overhead while keeping the steering guidance.
- Java and Kotlin imports now resolve by fully-qualified name, so same-name classes in different packages are told apart correctly in multi-module Spring and Android codebases, including across the Java/Kotlin interop boundary.
- Java and C# anonymous classes (`new T() { ... }`) and their overridden methods are now indexed as real class nodes, so an agent sees those hidden overrides in its trail without a Read.
- The installer no longer writes a duplicate `## CodeGraph` instructions block into your agent's instructions file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor's `.cursor/rules/codegraph.mdc`, or Kiro's steering doc) — the MCP server is now the single source of truth, and re-running `codegraph install` or `codegraph uninstall` strips a block a previous version left behind (#529). If you added your own notes inside the `CODEGRAPH_START`/`CODEGRAPH_END` markers, move them outside the markers first, since the whole marked block is removed.

### Fixes

- MCP tools no longer return results for files that were deleted while no server was running — the first query of a session now waits for the catch-up sync, so you get the correct index instead of stale rows.
- Windows: black console windows no longer flash on every file save or MCP reconnect (#485, #510, #530).
- `codegraph index` and `init -i` now report the true edge count in their summary, instead of undercounting by missing resolution and synthesizer edges.

## [0.9.6] - 2026-05-27

### New Features

- Enterprise Spring and MyBatis flows now trace end-to-end: MyBatis XML mappers are indexed and linked to their Java mapper interfaces, Spring `@Value` and `@ConfigurationProperties` references resolve to the matching keys in your `application.yml`/`.properties` config (including relaxed kebab/camel/snake binding), and field-injected concrete beans like `this.field.method()` resolve through to their implementation (#389).
- Gemini CLI (and the rebranded Antigravity CLI) plus the Antigravity IDE are now supported by `codegraph install`, detected and configured out of the box with sibling settings and MCP servers preserved across re-installs (#399).
- Kiro (CLI and IDE) is now supported by `codegraph install` on macOS, Linux, and Windows, with its own steering file so it loads CodeGraph guidance naturally (#385).

### Fixes

- C/C++: bare `#include "header.h"` directives now connect to the real header file instead of a phantom import, so includes show up as true file-to-file edges; system and stdlib headers are filtered out so they don't false-resolve (#453).
- Java/Kotlin: imports now disambiguate same-name classes across modules using the fully-qualified import path, so callers, callees, and trace land on the right class in multi-module projects instead of guessing by file proximity (#314).
- TypeScript: `type` aliases with object shapes (including function-typed members and intersection types) now surface their members in the graph, so a call like `handle.stop()` resolves to the alias member instead of an unrelated look-alike class in a sibling directory (#359).
- C#: parameter, return, property, and field types now produce reference edges, so callers and callees on a DTO or service type return real results instead of nothing (#381).
- Go: cross-package qualified calls like `pkg.Func()` now resolve to the right package by reading your `go.mod`, so callers, callees, impact, and trace return complete results on Go monorepos instead of almost nothing (#388).
- `codegraph_files` now returns the whole project when an agent passes a root-ish path like `/`, `.`, `./`, `""`, or a Windows-style `\`, and subdirectory filters like `/src`, `./src`, and `src\components` all resolve correctly instead of returning "No files found" (#426).
- The file watcher no longer marks edited files as fresh when another process holds the index lock, so the per-file staleness signal stays accurate until the edit is actually indexed (#449).
- TypeScript/JavaScript: calls inside top-level variable initializers (`const token = getToken()`) and inside inline object-literal methods are no longer dropped, so they show up in callers as expected, including in Vue single-file components (#425).
- Watch sync no longer aborts with a `FOREIGN KEY constraint failed` error in a long-running daemon; a stale lookup now drops a single edge instead of failing the whole sync (#455).
- Hermes: `codegraph install --target hermes` no longer corrupts `~/.hermes/config.yaml`, correctly handling PyYAML's block-style lists and re-installing cleanly even on an already-corrupted file (#456).
- NestJS: route prefixes from `RouterModule.register([...])` (including nested `children`) now propagate to controller routes, so a route shows up at its full path like `GET /admin/users` instead of `GET /` (#459).
- C++: callers now resolve through typed member pointers such as `m_alg->Processing()`, including out-of-line method definitions and the common case of two classes sharing a method name (#445, #454).

## [0.9.5] - 2026-05-25

### New Features

- Running multiple AI agents in the same project no longer multiplies the cost: two Claude Code windows, a worktree agent, or parallel sub-agents now share one background daemon per project with a single file watcher, SQLite connection, and tree-sitter warm-up instead of N independent copies (#411).
- The daemon runs detached so it outlives any single session, meaning closing one editor or terminal never severs the others; it lingers briefly after the last client disconnects so back-to-back sessions skip the startup cost, then exits and cleans up after itself. Tune the idle wait with `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` (default five minutes).
- Set `CODEGRAPH_NO_DAEMON=1` to opt out and get one independent server per client, handy for debugging or sandboxes that disallow local sockets; the daemon is also version-pinned, so upgrading CodeGraph never mixes versions over the connection.
- CodeGraph responses now tell the agent which files are pending re-index: when the watcher has seen edits since the last sync, tool responses add a warning banner naming the stale files and their state so the agent reads just those directly while trusting the rest, with zero cost when nothing is pending (#403).
- `CODEGRAPH_WATCH_DEBOUNCE_MS` lets you tune the file-watcher quiet window (default 2000ms) for workspaces with bursty writes like format-on-save chains or large generated outputs, without touching your agent's command line (#403).
- Objective-C indexing: `.m`, `.mm`, and content-sniffed `.h` files now parse with full structural extraction, including full multi-part selectors, properties, imports, and superclass/protocol relationships, so trace, callers, and callees work across iOS codebases (#165).
- Mixed iOS, React Native, and Expo projects now trace end-to-end across language boundaries: Swift to Objective-C auto-bridging, the React Native legacy bridge and TurboModules, native-to-JS event channels, Expo Modules, and Fabric/Codegen view components are all bridged so flows connect through gaps that static parsing alone can't follow (#401).

### Fixes

- TypeScript: types used only in an interface's property or method signatures now produce references edges, so impact and callers on a type include every consumer that imports it just for an interface shape (#432).
- Git worktrees no longer silently borrow another tree's index; running CodeGraph from a worktree nested inside the main checkout used to return the wrong branch's code with no warning, and now both the status command and every read tool call out the conflict and point you to `codegraph init -i` in the worktree (#155).
- The file watcher no longer exhausts the OS file-watch budget on large repos: it now excludes the same directories the indexer ignores (defaults plus your `.gitignore`) before registering watches, so CodeGraph can run alongside your editor or dev server without hitting the per-user watch ceiling (#276).
- The index now stays in sync after `git pull`, branch switches, and edits made outside your editor; change detection is filesystem-based instead of relying on `git status`, so pulled or checked-out code is picked up without a full re-index.
- The MCP server now catches up on connect, reconciling anything that changed while it wasn't running so your first query reflects the current code instead of a stale snapshot.
- Dependency, build, and cache directories like `node_modules`, `vendor`, `dist`, `build`, `target`, `.venv`, `__pycache__`, `Pods`, and `.next` are now excluded by default, so context and search reflect your code instead of third-party noise even in a project with no `.gitignore`; add a `.gitignore` negation to index one anyway (#407).

## [0.9.4] - 2026-05-24

### New Features

- Request-to-handler flows now trace end-to-end across many web stacks, with new or improved route resolution for Express, Rails, Spring (Java and Kotlin), Django/DRF, Laravel, Flask, FastAPI, Gin, chi, ASP.NET, Drupal, Axum, actix, Vapor, Play, Vue/Nuxt, Svelte/SvelteKit, and React Router.
- `codegraph_trace`, `codegraph_callees`, and `codegraph_explore` now follow flows that have no static call edge — callback and observer registration, EventEmitter, React re-renders and JSX children, Flutter `setState` to `build`, C++ virtual overrides, and Java/Kotlin interface-to-implementation dispatch (like Spring's `@Autowired` service calls) — and each bridged hop is labeled inline in trace with where it was wired up.
- `codegraph_trace` now returns a self-contained flow dossier: every hop shows its full body inline plus the destination's own outgoing calls, so a single trace usually answers a "how does X reach Y" question without a follow-up explore, node, or Read.
- `codegraph_explore` now leads with the execution flow when your query names the symbols of a flow, finding the call path among those symbols (including across dynamic-dispatch hops) so you get a trace-quality answer without switching tools.
- `codegraph_node` and `codegraph_trace` now emit line-numbered source (matching `codegraph_explore` and Read), so you can cite or edit exact lines without re-reading the file just to recover line numbers.
- New `CODEGRAPH_MCP_TOOLS` environment variable lets you expose only a chosen subset of codegraph tools over MCP (e.g. `trace,search,node,context`) without editing your client's MCP config; unset exposes all of them.
- Release archives now ship with a `SHA256SUMS` file, and the npm launcher verifies the bundle it downloads against it, aborting on a mismatch (releases published before this change skip verification rather than failing).

### Fixes

- Several static-extraction and resolution correctness fixes underpin the routing work above: C++ inheritance edges that were previously missing, Dart methods that were extracted signature-only, Python handlers named `index`/`get`/`update` that were being silently dropped, and an explore output-budget issue that under-returned source on repos with very large files.
- `codegraph serve --mcp` no longer keeps running after its parent agent is force-killed (OOM, `kill -9`, or container teardown) on Linux, where it used to hold inotify watches, file descriptors, and the SQLite WAL indefinitely; the server now shuts down as soon as its parent process changes, tunable via `CODEGRAPH_PPID_POLL_MS` (#277).
- Installing `@colbymchenry/codegraph` through a registry mirror that hadn't yet mirrored the matching per-platform package no longer fails with `no prebuilt bundle for <platform>`; the launcher now downloads the bundle from GitHub Releases and caches it, with `CODEGRAPH_NO_DOWNLOAD=1` to disable the fallback and `CODEGRAPH_DOWNLOAD_BASE` to point it at your own mirror (#303).
- `install.sh` no longer fails with `403` / "could not resolve latest version" on shared or cloud hosts that exhaust GitHub's unauthenticated API rate limit; it now resolves the version through the unthrottled releases redirect, and `CODEGRAPH_VERSION` accepts a bare version like `0.9.4` as well as `v0.9.4` (#325).

## [0.9.3] - 2026-05-22

### New Features

- New `codegraph uninstall` command cleanly removes CodeGraph from every agent it's configured on — Claude Code, Cursor, Codex CLI, opencode, and Hermes Agent — in one step, asking whether to clean up your global or this project's local config and reporting exactly which agents it touched; it accepts `--location`, `--target`, and `--yes` for scripted or non-interactive use, removes only what `codegraph install` wrote, and leaves your `.codegraph/` index alone (#313).

### Fixes

- Indexing a large multi-language project no longer aborts partway through with a `Fatal process out of memory: Zone` crash on Node.js 22 and 24, even with plenty of RAM free — CodeGraph now launches with a V8 flag that keeps grammar compilation off the optimizing tier, and any launch path that doesn't get the flag directly re-execs once with it automatically (#298, #293). Node 25 stays blocked for now, since its variant of this bug isn't fixed by the same flag.
- Uninstalling from Cursor now deletes the leftover `.cursor/rules/codegraph.mdc` file outright instead of leaving an orphaned, empty rule behind, while keeping any content you added outside CodeGraph's markers.

## [0.9.2] - 2026-05-21

### Breaking Changes

- CodeGraph no longer has a config file: `.codegraph/config.json` and the entire config surface are gone, and the library API for it (the config type, the `config` option on `init()`, and the get/update config exports) has been removed — existing config files are now ignored, and `.gitignore` is the single source of truth for what gets indexed. The `.codegraphignore` marker is also no longer supported; use `.gitignore` instead.

### New Features

- `codegraph install` now supports Hermes Agent (Nous Research), wiring up the CodeGraph MCP server so Hermes can drive the knowledge graph like the other agents.
- Drupal projects (8/9/10/11) are now detected and indexed with framework smarts: routes from `*.routing.yml` link to their controller, form, or entity-handler, and hook implementations across modules are connected to their canonical hook name, so asking for callers of a hook returns every implementation (#268).
- Indexing is now zero-config and honors your `.gitignore` everywhere — in git repos via git, and in non-git projects by reading `.gitignore` files directly — so to keep something out of the graph you just add it to `.gitignore`. Behavior change: committed files that aren't gitignored are now indexed even under `vendor/`, `Pods/`, or a committed `dist/`; add a `.gitignore` negation to exclude them (#283).

### Fixes

- Windows: installing globally and then running any `codegraph` command no longer fails — the launcher now invokes the bundled runtime directly instead of a `.cmd` file that modern Node refuses to spawn, so `codegraph` works regardless of your Node version (#289).

### Security

- The temp-dir marker written on each `codegraph_context` call is now opened safely so it can't follow a symlink, closing a hole where another local user on a shared machine could redirect that write onto a file you can write (#280).

## [0.9.1] - 2026-05-21

### Fixes

- The standalone installers (`curl … | sh` and `irm … | iex`) no longer fail to launch on a machine that has no Node installed.
- Installing with `npm i -g` on Linux x64 now finds its bundle, after the 0.9.0 release silently shipped without the linux-x64 package; the release pipeline now verifies every package reached the npm registry so a release can't pass green-but-broken again.

## [0.9.0] - 2026-05-21

CodeGraph now ships its own self-contained runtime, so it installs on any Node version — or none at all — with no native build step, and the old intermittent "database is locked" errors are gone for good.

### New Features

- One-line standalone installers that need no Node.js: `install.sh` on macOS and Linux, and `install.ps1` on Windows fetch the self-contained bundle and put `codegraph` on your PATH (you can still use `npm`/`npx` on any Node version too).
- CodeGraph now uses real SQLite with full WAL and FTS5 built into its bundled runtime, which fixes the concurrent-read "database is locked" errors at the root, removes the native build step entirely, and runs faster for anyone who had been stuck on the old WASM fallback (#238).
- Lua: CodeGraph now indexes `.lua` projects (Neovim plugins, Kong, OpenResty, game code), surfacing functions, table methods, local variables, `require(...)` imports, and the call edges between them.
- Luau: CodeGraph now indexes `.luau`, Roblox's typed superset of Lua, adding type and `export type` aliases, typed function signatures, generics, and Roblox instance-path requires on top of everything Lua extracts (#232).
- `codegraph status` now reports the effective journal mode, so a "database is locked" report is easy to triage at a glance.

### Fixes

- Re-running `codegraph install` now strips the broken auto-sync hooks that pre-0.8 versions wrote into Claude Code's settings, which had been causing a "Stop hook error: unknown command 'sync-if-dirty'" on every turn. The cleanup is surgical and leaves unrelated hooks untouched. Re-run `codegraph install` once on an affected machine to clear the error.

## [0.8.0] - 2026-05-20

### Breaking Changes

- The minimum supported Node.js version is now 20 (Node 18 is end-of-life); Node 22 LTS and Node 24 get the fast native backend out of the box, other Node versions still run via the slower WASM fallback, and Node 25+ remains blocked (#81). If you're on an older Node, upgrade to 20 or newer.

### New Features

- NestJS: CodeGraph now recognizes NestJS projects and surfaces the route that binds each handler across HTTP controllers, GraphQL resolvers, microservice handlers, and WebSocket gateways, detected automatically from any `@nestjs/*` dependency (#220).
- `codegraph_explore` source now includes line numbers, so an agent can cite `file:line` straight from the result instead of reopening the file to find a line number; set `CODEGRAPH_EXPLORE_LINENUMS=0` to disable.
- On WSL2 `/mnt/*` drives, where the live file watcher is too slow and could break MCP startup, CodeGraph now skips the watcher and offers to keep the index fresh with git hooks instead; new `CODEGRAPH_NO_WATCH=1` (or `serve --mcp --no-watch`) forces the watcher off anywhere, and `CODEGRAPH_FORCE_WATCH=1` overrides the WSL auto-detect when your setup is actually fast.
- CodeGraph now guides agents to answer "how does X work" and architecture questions directly with a couple of codegraph calls instead of delegating to a file-reading sub-agent or a grep-and-read loop, which gives faster, cheaper, `file:line`-cited answers on medium and large repos.
- `codegraph_node` with code on a class, interface, struct, or enum now returns a compact member outline (fields plus method signatures with line numbers) instead of the entire class body; functions and methods still return their full source.
- `codegraph_explore` output now scales with project size, so small projects get tighter responses than your native grep-and-read flow would produce while large codebases keep their fuller budget, and a per-file cap stops a single dense file from collapsing into a whole-file dump (#185). Thanks @essopsp.
- Search ranking now correctly de-prioritizes CamelCase test files (`FooTest.kt`, `BarTests.swift`, `BazSpec.scala`, `QuxTestCase.cs`) and test source-set directories in Kotlin, Swift, Scala, and C#, so real implementations no longer get outranked by tests.

### Fixes

- `codegraph_explore` output is now hard-capped to its size budget, so an oversized response no longer overruns the cap and sits in the agent's context to be re-read every turn.
- Newly created untracked files are no longer reported as pending forever and re-indexed from scratch on every `codegraph sync`; CodeGraph now hash-compares them against the index the same way it does tracked files (#206). Thanks @15290391025.
- `codegraph init -i` now finds source inside nested, independent git repositories that aren't submodules (common in CMake super-repo layouts), instead of reporting "No files found to index" (#193). Thanks @timxx.
- On Node 24, indexing no longer silently drops to the slower fallback backend with a warning that couldn't be cleared; a fresh install on Node 22 or 24 now gets the fast native backend with no compiler, and `codegraph status` should report it (#203). Thanks @Finndersen.
- MCP tools no longer fail with "CodeGraph not initialized" when the index actually exists; when the client doesn't report a workspace root, the server now asks for it via the standard MCP `roots/list` request before falling back, and the error message is actionable when a project still can't be resolved (#196). Thanks @zhangyu1197.
- The MCP server no longer hangs on startup under WSL2 when the project lives on an NTFS `/mnt/*` mount, so the codegraph tools actually appear; CodeGraph auto-skips the watcher there with manual and git-hook sync fallbacks (#199). Thanks @mengfanbo123.
- Claude Code project-local installs now write the MCP server to `.mcp.json` (the file Claude Code actually reads for project-scoped servers) instead of a file it ignores, and re-running `codegraph install` migrates an affected project automatically (#207). Thanks @Jhsmit.
- Source-omission markers in `codegraph_explore` and `codegraph_context` output are now language-neutral instead of C-style comments, so they no longer look wrong inside Python, Ruby, and other non-C source blocks.

## [0.7.10] - 2026-05-19

### Fixes

- CodeGraph tools now reliably appear in your client on slow filesystems (Docker Desktop VirtioFS on macOS, WSL2), where the startup handshake could previously time out and leave the process running with no tools visible (#172). Thanks @sashanclrp and @sgrimm.
- On Windows PowerShell and cmd.exe, terminal output during `codegraph index` and `codegraph sync` no longer turns into garbled characters; CodeGraph now uses plain ASCII glyphs by default on Windows, with `CODEGRAPH_UNICODE=1` to opt back into the Unicode glyphs or `CODEGRAPH_ASCII=1` to force ASCII on any platform (#168). Thanks @starkleek and @Bortlesboat.
- Module-qualified symbol lookups now resolve in the codegraph tools, so you can pass names like `module::symbol` (Rust, C++, Ruby), `Module.symbol` (TypeScript, JavaScript, Python), or `module/symbol`, including multi-level paths and Rust prefixes like `crate`, `super`, and `self` (#173). Thanks @joselhurtado.

## [0.7.9] - 2026-05-17

### New Features

- opencode: the installer now writes an `AGENTS.md` file with CodeGraph usage guidance, so opencode reaches for the `codegraph_*` tools instead of falling back to its native search.
- opencode: your comments and formatting in `opencode.jsonc` now survive install, re-install, and uninstall, because the installer makes surgical edits instead of rewriting the whole file.

### Fixes

- opencode: `codegraph install` now wires up the MCP server in the file opencode actually reads — previously it wrote to a config file opencode ignores by default, so the CodeGraph entry never appeared in any opencode session; re-run `codegraph install --target=opencode` after upgrading so the entry lands in the right place.

## [0.7.7] - 2026-05-17

### New Features

- `codegraph install` now sets up Claude Code, Cursor, Codex CLI, and opencode from one multi-select prompt, with any agents it detects pre-checked, so a single install wires up every editor you use (#137).
- You can install non-interactively for scripting and CI with flags like `--target`, `--location`, `--yes`, `--no-permissions`, and `--print-config`.
- `codegraph init` now auto-wires project-local agent config for any agent you installed globally, so one global `codegraph install` works in every project you open without re-installing per project.
- Agent instructions are now agent-agnostic and tell each agent to trust codegraph results instead of re-verifying with grep, fixing the case where Cursor and Codex fell back to native search even with codegraph available.
- The install prompts are clearer: the agent picker comes first, and the separate "install the CLI on your PATH" and "apply to all projects or just this one" questions no longer both read as "Global".

### Fixes

- Cursor: a globally-installed codegraph no longer reports "not initialized" in every workspace; the installer now passes the correct project path into Cursor's MCP config to work around Cursor launching MCP servers with the wrong working directory.

Thanks @andreinknv for the substantive draft this release was based on.

## [0.7.6] - 2026-05-13

### Fixes

- Fixed the `codegraph` command failing with `permission denied` right after a fresh global install — the 0.7.5 package shipped the CLI without its executable bit, so your shell refused to run it. New installs work out of the box. If you're stuck on 0.7.5, upgrade to 0.7.6 or unblock yourself in place by making the installed binary executable with `chmod +x`.

[0.9.7]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.7
[0.9.6]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.6
[0.9.5]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.5
[0.9.4]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.4
[0.9.3]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.3
[0.9.2]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.2
[0.9.1]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.1
[0.9.0]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.0
[0.8.0]: https://github.com/colbymchenry/codegraph/releases/tag/v0.8.0
[0.7.10]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.10
[0.7.9]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.9
[0.7.7]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.7
[0.7.6]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.6
[0.9.8]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.8
[0.9.9]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.9
