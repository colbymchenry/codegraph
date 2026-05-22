# Changelog

All notable changes to CodeGraph are documented here. Each entry also ships as
a [GitHub Release](https://github.com/colbymchenry/codegraph/releases) tagged
`vX.Y.Z`, which is where most people will look.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.4] - 2026-05-22

### Added
- **Release archives now ship with a `SHA256SUMS` file**, and the npm launcher
  verifies the bundle it downloads against it — a mismatch aborts before
  anything runs. Releases published before this change have no checksum file, so
  the verification is skipped (not failed) when none is available.

### Fixed
- **`codegraph: no prebuilt bundle for <platform>` after installing through a
  registry mirror.** Installing `@colbymchenry/codegraph` from a registry that
  hadn't mirrored the matching per-platform package — most often the
  npmmirror/cnpm mirrors, but any lazily-syncing mirror or corporate proxy can
  do it — left every command failing with `no prebuilt bundle for <platform>`.
  The runtime ships as a per-platform `optionalDependency`, and npm treats an
  optional package it can't fetch as a success and silently skips it, so the
  bundle simply went missing. The launcher now self-heals: when the platform
  bundle isn't installed, it downloads the same archive from GitHub Releases
  (cached under `~/.codegraph/bundles/` for next time) and runs that — so a
  global install works even on a mirror that never carried the platform package.
  Set `CODEGRAPH_NO_DOWNLOAD=1` to disable the network fallback, or
  `CODEGRAPH_DOWNLOAD_BASE=<url>` to point it at your own mirror of the release
  archives; the standalone `install.sh` remains the no-Node alternative. Resolves
  [#303](https://github.com/colbymchenry/codegraph/issues/303).
- **`install.sh` failing with `403` / "could not resolve latest version" on
  shared or cloud hosts.** The standalone installer resolved the latest release
  through the GitHub API, whose unauthenticated limit is 60 requests/hour per IP
  — routinely exhausted on cloud devboxes and CI where many users share an
  address, returning `403` (issue #325). It now resolves the version from the
  `releases/latest` web redirect, which isn't rate-limited (and still falls back
  to the API). `CODEGRAPH_VERSION` also accepts a bare `0.9.4` in addition to
  `v0.9.4`. Resolves
  [#325](https://github.com/colbymchenry/codegraph/issues/325).

## [0.9.3] - 2026-05-22

### Added
- **`codegraph uninstall` command.** Cleanly removes CodeGraph from every agent
  it's configured on — Claude Code, Cursor, Codex CLI, opencode, and Hermes
  Agent — in one step. It asks up front whether to remove the global config
  (`~/.claude`, `~/.codex`, …) or just this project's local config (no flags
  required), then prints exactly which agents it touched so you can see what
  changed. `--location`, `--target`, and `--yes` are accepted for scripted /
  non-interactive use. It removes only what `install` wrote (MCP server entry,
  instructions block, permissions) and leaves your `.codegraph/` index alone
  (use `codegraph uninit` for that). Resolves
  [#313](https://github.com/colbymchenry/codegraph/issues/313) — previously the
  only cleanup path was an npm `preuninstall` hook that the published bundle
  never shipped, so `npm uninstall -g` left every agent pointing at a CodeGraph
  MCP server that no longer existed.

### Fixed
- **`Fatal process out of memory: Zone` crash while indexing large projects.**
  On Node.js 22 and 24 — including CodeGraph's own bundled runtime — running
  `codegraph index` / `codegraph init` on a large multi-language repo could
  abort the entire process partway through parsing with
  `Fatal process out of memory: Zone`, even with tens of GB of RAM free (the
  failure is in a V8-internal compilation arena, not the JS heap). The cause is
  V8's "turboshaft" optimizing WASM compiler exhausting its Zone budget while
  compiling tree-sitter's large WebAssembly grammars on a background thread.
  CodeGraph now runs with V8's `--liftoff-only`, which keeps grammar compilation
  on the baseline compiler and never reaches the optimizing tier, eliminating
  the crash; indexing output is otherwise unchanged. The bundled launcher passes
  the flag directly, and any other launch path (from source, `npx`, a globally
  linked dev build) re-execs once with it automatically. Resolves
  [#298](https://github.com/colbymchenry/codegraph/issues/298) and
  [#293](https://github.com/colbymchenry/codegraph/issues/293). (Node 25 stays
  blocked — its variant of this V8 bug is not resolved by `--liftoff-only`.)
- **Cursor uninstall left an orphaned `.cursor/rules/codegraph.mdc`.** It
  stripped the rule body but left the file and its `description: CodeGraph …`
  frontmatter behind. The dedicated rules file is now deleted outright on
  uninstall, while any content you added outside CodeGraph's markers is kept.

## [0.9.2] - 2026-05-21

### Added
- **Installer target: Hermes Agent (Nous Research).** `codegraph install` now
  supports Hermes Agent — it writes the `mcp_servers.codegraph` entry and ensures
  `platform_toolsets.cli` includes `mcp-codegraph` in `$HERMES_HOME/config.yaml`,
  so Hermes can drive the CodeGraph knowledge graph like the other agents.
- **Framework support: Drupal 8/9/10/11** — CodeGraph now detects Drupal
  projects (via a `drupal/*` dependency in `composer.json`) and adds three
  levels of intelligence:
  - **Route extraction**: `*.routing.yml` files emit a `route` node per route,
    linked by a `references` edge to the `_controller`, `_form`, or
    entity-handler class/method, so querying a controller method surfaces the
    URL route that binds it.
  - **Hook detection**: hook implementations in `.module`, `.install`, `.theme`,
    and `.inc` files are detected via docblock (`Implements hook_X()`) with a
    module-name-prefix fallback. Each emits a `references` edge to the canonical
    `hook_X` name so `codegraph_callers("hook_form_alter")` returns every
    implementation across modules.
  - **Resolution**: `_controller`/`_form` FQCNs resolve to their PHP
    class/method nodes.
  New `yaml`/`twig` languages are tracked at the file level, the Drupal PHP
  extensions (`.module`/`.install`/`.theme`/`.inc`) are indexed with the PHP
  grammar, and `web/core`, `web/modules/contrib`, `web/themes/contrib` are
  excluded by default. Resolves [#268](https://github.com/colbymchenry/codegraph/issues/268).

### Changed
- **Zero-config indexing that respects `.gitignore`.** CodeGraph no longer has a
  config file. It indexes every file whose extension maps to a supported language
  and honors your `.gitignore` everywhere: in git repos via git itself, and in
  non-git projects (e.g. a freshly-scaffolded app before `git init`) by reading
  `.gitignore` files directly — root and nested, the same way git does (via the
  `ignore` library, so negation/anchoring/nested rules all behave correctly). To
  keep something out of the graph, add it to `.gitignore`. **Behavior change:**
  committed files that are *not* gitignored are now indexed even under `vendor/`,
  `Pods/`, or a committed `dist/` — previously a hardcoded exclude list skipped
  those names; now `.gitignore` is the single source of truth. Resolves
  [#283](https://github.com/colbymchenry/codegraph/issues/283).

### Fixed
- **Windows: `npm i -g @colbymchenry/codegraph` then any `codegraph` command
  failed with `spawnSync …\codegraph.cmd EINVAL`.** The npm launcher spawned the
  bundle's `.cmd` file directly, which modern Node refuses to do on Windows
  (the CVE-2024-27980 hardening — seen on Node 24). The launcher now invokes the
  bundled `node.exe` against the app directly, so `codegraph` works on Windows
  regardless of your Node version. Resolves
  [#289](https://github.com/colbymchenry/codegraph/issues/289).

### Removed
- **`.codegraph/config.json` and the entire config surface.** Every field was
  either inert or now redundant with `.gitignore`:
  - `languages`/`frameworks` never affected indexing (languages are detected per
    file from extensions; frameworks are auto-detected). `languages` was also
    broken — its validator only knew the original 8 languages, so setting it to
    anything newer (C#, PHP, Ruby, C/C++, Swift, Kotlin, Dart, Vue, Scala, Lua, …)
    threw `Invalid configuration format`.
  - `extractDocstrings`/`trackCallSites`/`customPatterns` were never read by any
    extractor.
  - `include` is now derived from the supported language extensions, `exclude` is
    replaced by `.gitignore`, and `maxFileSize` (1 MB) is a constant.

  **Breaking (library API):** the `CodeGraphConfig` type, the `config` option on
  `CodeGraph.init()`, and the `getConfig()`/`updateConfig()`/`getConfigPath`
  exports are gone. Existing `.codegraph/config.json` files are simply ignored.
  The `.codegraphignore` marker is no longer supported — use `.gitignore`.

### Security
- **MCP session marker no longer follows symlinks** (CWE-59). Every
  `codegraph_context` call writes a `codegraph-consulted-*` marker into the
  system temp dir; the previous write followed symlinks, so on a multi-user
  system another local user could pre-plant that path as a symlink and redirect
  the write onto a victim-writable file. The marker is now opened with
  `O_NOFOLLOW` and mode `0600`, and a planted symlink is refused rather than
  followed. Resolves [#280](https://github.com/colbymchenry/codegraph/issues/280).

## [0.9.1] - 2026-05-21

### Fixed
- **Standalone installers** (`curl … | sh`, `irm … | iex`): the bundled launcher
  failed with `exec: …/node: not found` because it didn't resolve the symlink the
  installer puts on your PATH. Installing on a machine with **no Node** now works.
- **npm**: `@colbymchenry/codegraph-linux-x64` is now published — the 0.9.0
  release silently shipped 6 of 7 packages, so `npm i -g` on linux-x64 couldn't
  find its bundle. The release pipeline now verifies every package reached the
  registry (and is idempotent), so a release can't pass green-but-broken again.

[0.9.4]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.4
[0.9.3]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.3
[0.9.2]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.2
[0.9.1]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.1

## [0.9.0] - 2026-05-21

### 🎉 Self-contained: CodeGraph bundles its own runtime — install anywhere, on any Node (or none)

**No more `database is locked`. No more native build failures. No more "WASM fallback active."**

CodeGraph used to need `better-sqlite3`, a native module compiled against your exact
Node version. When that build failed (common on Windows and locked-down machines) it
silently dropped to a slow WASM SQLite build with **no WAL** — the root cause of the
intermittent `database is locked` errors on concurrent MCP tool calls
([#238](https://github.com/colbymchenry/codegraph/issues/238)). That entire class of
problem is **gone**: CodeGraph now ships a self-contained Node runtime and uses Node's
built-in `node:sqlite` (real SQLite, full WAL + FTS5).

- ✅ **Zero native compilation** — nothing to build, ever; nothing to rebuild when Node changes.
- ✅ **Runs on any Node version — or with no Node at all.** Install via the standalone installers with no Node present, or keep using `npm`/`npx` on any version (your Node only launches the bundled runtime).
- ✅ **`database is locked` fixed at the root** — real WAL means readers never block on a writer.
- ⚡ **5–10× faster** than the old WASM fallback for anyone who was stuck on it.

```bash
# macOS / Linux — no Node required
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh
# Windows (PowerShell) — no Node required
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
# or, if you have Node (any version):
npm i -g @colbymchenry/codegraph
```

### Added
- **Standalone installers** — one-line install with no Node.js required:
  `curl -fsSL .../install.sh | sh` (macOS/Linux) and `irm .../install.ps1 | iex`
  (Windows). They fetch the matching self-contained bundle from GitHub Releases
  and put `codegraph` on your PATH.
- **Lua**: CodeGraph now indexes Lua (`.lua`) — functions, methods (table `t.f`
  and `t:m` definitions become methods with a `t::f` receiver-qualified name),
  local variables, `require(...)` imports, and the call edges between them.
  Querying a Lua project (Neovim plugins, Kong, OpenResty, game code) now
  surfaces its modules, methods, and call graph.
- **Luau** ([#232](https://github.com/colbymchenry/codegraph/issues/232)):
  CodeGraph now indexes Luau (`.luau`), Roblox's typed superset of Lua —
  everything Lua extracts, plus `type` / `export type` aliases, typed function
  signatures, generics, and Roblox instance-path `require(script.Parent.X)`
  imports.

### Changed
- **SQLite backend is now Node's built-in `node:sqlite`** (real SQLite, WAL +
  FTS5), shipped inside a bundled Node runtime. This fixes the concurrent-read
  `database is locked` errors ([#238](https://github.com/colbymchenry/codegraph/issues/238))
  at the root and removes the native build step entirely.
- **`npm i -g` / `npx` now install a self-contained bundle.** The main package is
  a tiny shim; the runtime ships as per-platform `optionalDependencies`, so the
  install works on any Node version (your Node only launches the bundle).
- **`codegraph status`** now reports the effective journal mode (`wal` vs not),
  so a `database is locked` report is triageable at a glance.

### Removed
- **`better-sqlite3`** (optional native dependency) and **`node-sqlite3-wasm`**
  (WASM fallback) — along with the native-build banner, the WASM fallback path,
  and the no-WAL lock retries they required. The dependency tree now has zero
  native addons.

### Fixed
- **Installer**: re-running `codegraph install` now removes the broken
  auto-sync hooks that pre-0.8 versions wrote to Claude Code's
  `settings.json`. Those builds added a `Stop → codegraph sync-if-dirty`
  hook (and a `PostToolUse → codegraph mark-dirty` partner); both
  subcommands were later removed from the CLI, so Claude Code reported
  `Stop hook error: ... unknown command 'sync-if-dirty'` on every turn.
  The cleanup is surgical — only codegraph's own hook entries are
  stripped, so unrelated hooks sharing the same file or event (e.g. a
  GitKraken `gk ai hook run` hook) are left untouched — and it also runs
  on uninstall, so the npm `preuninstall` step fully reverses a legacy
  install. Re-run `codegraph install` once on an affected machine to
  clear the error.

[0.9.0]: https://github.com/colbymchenry/codegraph/releases/tag/v0.9.0

## [0.8.0] - 2026-05-20

### Added
- **Framework routes (NestJS)**: CodeGraph now recognises NestJS projects and
  emits `route` nodes — each linked by a `references` edge to its handler
  method — across all four transport layers: HTTP controllers (the
  `@Controller` prefix joined with `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete`/
  `@Head`/`@Options`/`@All`, including empty `@Controller()`/`@Get()`),
  GraphQL resolvers (`@Query`/`@Mutation`/`@Subscription`), microservice
  handlers (`@MessagePattern`/`@EventPattern`), and WebSocket gateways
  (`@SubscribeMessage`, prefixed with the gateway namespace). Detected
  automatically from any `@nestjs/*` dependency in `package.json`. Querying a
  controller method or resolver now surfaces the route that binds it.
  Resolves [#220](https://github.com/colbymchenry/codegraph/issues/220).
- **MCP / explore**: `codegraph_explore` source sections now carry line
  numbers (cat -n style `<num>\t<code>`, matching the Read tool). This lets
  the agent cite `file:line` straight from the explore payload instead of
  re-opening the file just to find a line number — the dominant residual
  cost on precise-tracing questions. In an isolated A/B (answer a
  "which exact line" question with the relevant code already in the
  payload), the no-line-numbers arm spent 2 file Reads + a grep recovering
  the line number while the line-numbered arm answered with zero follow-up
  tool calls. Payload cost is small (~3-5%). Set
  `CODEGRAPH_EXPLORE_LINENUMS=0` to disable.
- **MCP / watcher**: CodeGraph now skips the live file watcher on WSL2
  `/mnt/*` drives, where recursive `fs.watch` is slow enough to break MCP
  startup (see Fixed). When the watcher is off, `codegraph init` /
  `codegraph install` offer to keep the index fresh via git hooks
  (`post-commit`, `post-merge`, `post-checkout`) that run `codegraph sync`
  in the background — accept for automatic refresh on commit / pull /
  checkout, or decline and sync by hand. Either way you're told the index
  stays frozen until it's re-synced. New controls: `CODEGRAPH_NO_WATCH=1`
  (or `codegraph serve --mcp --no-watch`) forces the watcher off anywhere;
  `CODEGRAPH_FORCE_WATCH=1` overrides the WSL auto-detect when your `/mnt`
  setup is actually fast. `codegraph uninit` removes any hooks it installed.

### Changed
- **MCP / agent guidance**: CodeGraph now tells agents to answer "how does X
  work" / architecture questions *directly* — `codegraph_context`, then one
  `codegraph_explore` for the surfaced symbols — instead of delegating to a
  file-reading sub-agent or a grep+read loop. The server instructions and the
  installed instruction files (`CLAUDE.md`, `.cursor/rules/codegraph.mdc`,
  `AGENTS.md`) previously suggested *spawning a sub-agent* for explore-class
  questions, which produced the opposite, more expensive behavior: the
  sub-agent reads files regardless of the index, so CodeGraph became overhead
  stacked on top of the reads. In rigorous N≥4-per-arm benchmarks this cut the
  cost of an architecture question by ~42–47% versus a no-CodeGraph agent on
  medium and large repos (Excalidraw ~600 files, VS Code ~10k), with
  equal-or-better, `file:line`-cited answers and ~6× fewer tool calls; on a
  tiny repo (~25 files) it's a wash, since native grep is already trivially
  cheap there.
- **MCP / codegraph_node**: `includeCode=true` on a class/interface/struct/enum
  now returns a compact member outline (fields + method signatures + line
  numbers) instead of the entire class body — which could be thousands of
  characters and was rarely needed in full. Functions and methods still return
  their full body; request a specific member for its source.
- **Minimum Node.js is now 20** (was 18). Node 18 is end-of-life and the
  native SQLite binding (`better-sqlite3` 12.x) no longer ships a Node 18
  prebuilt binary. Node 22 LTS and Node 24 get the native backend out of the
  box; on other Node versions CodeGraph still runs via the WASM fallback
  (slower, but functional). Node 25+ remains blocked (V8 WASM JIT crash, see
  [#81](https://github.com/colbymchenry/codegraph/issues/81)).
- **MCP / explore**: `codegraph_explore` output is now adaptive to project
  size. The tool used to apply a fixed 35KB cap regardless of how large the
  codebase was, which on small projects (~100 files) produced bigger
  responses than the agent's native grep+Read flow would have — exactly the
  scenario reported in
  [#185](https://github.com/colbymchenry/codegraph/issues/185). The budget
  now scales with indexed file count: small projects (<500 files) cap at
  ~18KB and skip the "Additional relevant files" / completeness / explore-
  budget reminders that earn their keep on bigger codebases; medium
  (<5,000) caps at ~13KB; large (<15,000) keeps the historical ~35KB; very
  large goes up to ~38KB. A new per-file char cap also prevents a single
  file with many adjacent symbols from collapsing into one whole-file dump
  (the Alamofire `Session.swift` case from #185). Per-file cluster
  selection ranks clusters that contain a query entry point ahead of dense
  declaration blocks, and whole-file "envelope" nodes (a class/struct that
  spans most of the file) are excluded from clustering so the methods the
  query asked about aren't buried under the container's opening lines.
  Measured against the same repos used in the README benchmark, end state
  with line numbers on: Alamofire ~60% smaller per call, Excalidraw ~32%,
  VS Code ~12%. Agent-trust floor still holds — the Relationships section,
  scored cluster selection, and structured-source output are all retained.
  Thanks to [@essopsp](https://github.com/essopsp) for the repro.
- **Search ranking (Kotlin / Swift / Scala / C#)**: test files in these
  languages are now correctly de-prioritized in `codegraph_search`,
  `codegraph_context`, and `codegraph affected`. Detection previously only
  recognized `snake_case`/`.test.`-style names plus a handful of Java
  suffixes, so CamelCase test files (`FooTest.kt`, `BarTests.swift`,
  `BazSpec.scala`, `QuxTestCase.cs`) and Gradle / Kotlin-Multiplatform /
  Xcode test source-set directories (`jvmTest/`, `commonTest/`,
  `androidTest/`, `iosTest/`, `integrationTest/`) were treated as production
  code and could outrank the real implementation. Detection now matches
  capital-led `*Test` / `*Tests` / `*Spec` / `*TestCase` filenames and
  source-set directories — deliberately capital-led so lowercase look-alikes
  like `latest.kt` and `manifest.kt` are not misclassified.

### Fixed
- **MCP / explore**: `codegraph_explore` output is now hard-capped to its
  adaptive size budget. It could previously overrun (e.g. ~30K against a 28K
  cap) once the relationship map and trailer sections were appended; the
  oversized payload then sat in the agent's context and was re-read on every
  later turn.
- **Sync / status**: git-untracked files are no longer reported as pending
  "Added" forever. After `codegraph sync` indexed a newly-created untracked
  source file, `codegraph status` kept listing it under Pending Changes and
  every subsequent `sync` re-indexed it from scratch — even though its symbols
  were already queryable. Change detection trusted `git status` and counted
  every untracked (`??`) entry as new without checking the index, but indexing
  a file doesn't make git track it, so the file stayed `??` and got re-added on
  each run. CodeGraph now hash-compares untracked files against the index the
  same way it does tracked files: a file counts as "added" only if it's missing
  from the index, "modified" if its contents changed, and is skipped otherwise.
  Closes [#206](https://github.com/colbymchenry/codegraph/issues/206). Thanks to
  [@15290391025](https://github.com/15290391025) for the report.
- **Indexing**: `codegraph init -i` now finds source inside nested, independent
  git repositories — separate clones living inside the workspace that are **not**
  git submodules (common in CMake "super-repo" layouts). When the top-level
  workspace is itself a git repo, `git ls-files` reports an embedded repo only as
  an opaque `subdir/` entry and never lists its files, so indexing from the
  workspace root reported "No files found to index" even though indexing each
  sub-repo individually worked. CodeGraph now detects these embedded repos and
  indexes their tracked and untracked source, honoring each repo's own
  `.gitignore`. Closes
  [#193](https://github.com/colbymchenry/codegraph/issues/193). Thanks to
  [@timxx](https://github.com/timxx) for the report.
- **Native SQLite backend on Node 24**: indexing on Node 24 always dropped to
  the 5-10x-slower WASM backend, printing a `better-sqlite3 unavailable`
  warning that `npm rebuild better-sqlite3` / `xcode-select --install` could
  not clear ([#203](https://github.com/colbymchenry/codegraph/issues/203)).
  The bundled `better-sqlite3` was pinned to a v11 release that ships no
  prebuilt binary for Node 24's ABI (`node-v137`), so every Node 24 install
  silently degraded — and because CodeGraph is usually installed globally, the
  `npm install` / `npm rebuild` people ran in their own project never touched
  CodeGraph's copy. CodeGraph now requires `better-sqlite3` `^12.4.1`, whose
  prebuilds include Node 24, so a fresh install on Node 22 or Node 24 gets the
  native backend with no compiler. On an already-broken install, reinstall
  CodeGraph (e.g. `npm install -g @colbymchenry/codegraph`) to pull the new
  binding; `codegraph status` should then report `Backend: native`. Thanks to
  [@Finndersen](https://github.com/Finndersen) for the report.
- **MCP**: tools no longer fail with "CodeGraph not initialized" when the index
  actually exists. This hit clients that launch the MCP server from a directory
  other than your project and don't report a workspace root in `initialize`
  (some IDE/JetBrains-family integrations) — the server fell back to its own
  working directory, missed the project's `.codegraph/`, and returned the
  misleading "Run 'codegraph init' first" on every call. The only workaround
  was passing `projectPath` to each tool by hand. Now, when no project path is
  supplied, the server asks the client for its workspace root via the standard
  MCP `roots/list` request (when the client advertises the `roots` capability)
  before falling back to the working directory — so detection just works for
  spec-compliant clients. When it still can't resolve a project, the error is
  now actionable: it names the directory it searched and tells you to pass
  `projectPath` or add `--path /abs/project` to the server's MCP config args,
  instead of pointing you at a re-init you don't need. Closes
  [#196](https://github.com/colbymchenry/codegraph/issues/196). Thanks to
  [@zhangyu1197](https://github.com/zhangyu1197) for the report and the
  `projectPath` workaround.
- **MCP**: the server no longer hangs on startup under WSL2 when the project
  lives on an NTFS `/mnt/*` mount. Setting up the recursive file watcher
  there took tens of seconds — every directory read crosses the Windows/9p
  boundary — which blew past the host's initialization timeout (opencode's
  30s), so the codegraph tools silently never appeared, even on small
  projects. This is the file-watcher half of the
  [#172](https://github.com/colbymchenry/codegraph/issues/172) startup fix:
  that one moved the database/WASM open off the handshake, but the watcher
  setup was still on the critical path. CodeGraph now auto-skips the watcher
  on those mounts, with manual and git-hook sync fallbacks (see Added).
  Closes [#199](https://github.com/colbymchenry/codegraph/issues/199).
  Thanks to [@mengfanbo123](https://github.com/mengfanbo123) for the precise
  root-cause analysis and workaround.
- **Installer (Claude Code)**: project-local installs (`Just this project`)
  now write the MCP server to `.mcp.json` in the project root — the file
  Claude Code actually reads for project-scoped servers. Previously they
  wrote `.claude.json`, which Claude Code ignores, so the codegraph tools
  silently never appeared and you had to rename the file by hand to make it
  work. Re-running `codegraph install` (or `codegraph init`) on an affected
  project migrates the stale `.claude.json` entry into `.mcp.json`
  automatically; uninstall cleans up both. Global (`All projects`) installs
  were unaffected — they correctly target `~/.claude.json`. Closes
  [#207](https://github.com/colbymchenry/codegraph/issues/207). Thanks to
  [@Jhsmit](https://github.com/Jhsmit) for the report and the workaround.
- **MCP**: source-omission markers in `codegraph_explore` and
  `codegraph_context` output are now language-neutral (`... (gap) ...`,
  `... (trimmed) ...`, `... (truncated) ...`) instead of C-style `//`
  comments, which were misleading inside Python, Ruby, and other non-C
  fenced source blocks.

## [0.7.10] - 2026-05-19

### Fixed
- **MCP**: tools no longer silently fail to appear in clients on slow
  filesystems (Docker Desktop VirtioFS on macOS, WSL2). The `initialize`
  handshake was blocking on opening the SQLite database and bootstrapping
  the tree-sitter WASM runtime, which on slow I/O could exceed Claude
  Code's ~30s handshake timeout — leaving the codegraph process alive but
  unresponsive and no tools visible. The handshake now returns immediately
  and defers project open to the background; tool calls wait on the
  in-flight init rather than racing it with a second open. Closes
  [#172](https://github.com/colbymchenry/codegraph/issues/172). Thanks to
  [@sashanclrp](https://github.com/sashanclrp) for the original report and
  detailed reproduction, and [@sgrimm](https://github.com/sgrimm) for the
  decisive wire capture that isolated the actual root cause.
- **CLI**: terminal output no longer mojibakes on Windows PowerShell /
  cmd.exe during `codegraph index` and `codegraph sync`. The shimmer
  progress renderer writes from a worker thread via `fs.writeSync(1, …)`
  to keep the animation smooth while the main thread is busy in SQLite,
  which bypasses Node's TTY-aware UTF-8→codepage conversion — so glyphs
  like `│ ◆ —` were emitted as raw UTF-8 bytes and reinterpreted as the
  console's OEM codepage (CP437, CP936, …), producing strings like
  `鋍?[0m 鉒?[0m Scanning files 鈥?N found`. CodeGraph now picks an ASCII
  glyph set on Windows by default (`| * -` instead of `│ ◆ —`); set
  `CODEGRAPH_UNICODE=1` to opt back into the Unicode glyphs (e.g. on
  pwsh 7 with UTF-8 codepage), or `CODEGRAPH_ASCII=1` on any platform to
  force ASCII (useful for log collectors / non-TTY pipelines). Closes
  [#168](https://github.com/colbymchenry/codegraph/issues/168). Thanks to
  [@starkleek](https://github.com/starkleek) for the report and to
  [@Bortlesboat](https://github.com/Bortlesboat) for the initial PR.
- **MCP / search**: module-qualified symbol lookups now resolve. The
  MCP tools (`codegraph_node`, `codegraph_callees`, `codegraph_impact`,
  …) accept `module::symbol` (Rust / C++ / Ruby), `Module.symbol`
  (TS / JS / Python), and `module/symbol` (path-style) — multi-level
  forms (`crate::configurator::stage_apply::run`) and Rust path
  prefixes (`crate`, `super`, `self`) are handled. Closes
  [#173](https://github.com/colbymchenry/codegraph/issues/173). Thanks
  to [@joselhurtado](https://github.com/joselhurtado) for the detailed
  reproduction. Three underlying fixes:
    - The FTS5 query builder now treats `::` as a token separator
      instead of stripping it to nothing, so `stage_apply::run` no
      longer collapses to the unsearchable `stage_applyrun`.
    - `matchesSymbol` falls back to a file-path containment check when
      `qualifiedName` doesn't carry the module hierarchy (Rust
      file-level functions, Python free functions in a package): a
      `run` in `src/configurator/stage_apply.rs` now matches
      `stage_apply::run` because `stage_apply` appears as a path
      segment.
    - Qualified lookups that don't match the qualifier no longer fall
      through to fuzzy text matches — `stage_apply::nonexistent_fn`
      returns `null` instead of resolving to an unrelated `rollback`
      in the same file.

[0.8.0]: https://github.com/colbymchenry/codegraph/releases/tag/v0.8.0
[0.7.10]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.10

## [0.7.8] - 2026-05-17

### Fixed
- **opencode**: install actually wires up the MCP server now. v0.7.7 wrote
  `~/.config/opencode/opencode.json`, but opencode reads `opencode.jsonc` by
  default — so the `codegraph` entry never showed up in any opencode session.
  The installer now prefers an existing `.jsonc`, falls back to `.json` when
  only that exists, and creates `.jsonc` for greenfield installs. **Re-run
  `codegraph install --target=opencode` after upgrading** so the entry lands
  in the file opencode actually reads.

### Added
- **opencode**: installer now writes `AGENTS.md` (global
  `~/.config/opencode/AGENTS.md`, local `./AGENTS.md`) with the same
  codegraph usage guidance the other agents already received. Without it,
  opencode's model would call native `Grep` instead of the `codegraph_*`
  tools it could see in its MCP list.
- User comments and formatting in `opencode.jsonc` survive install /
  re-install / uninstall round-trips — surgical edits via `jsonc-parser`
  rather than full-file rewrites.

[0.7.8]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.8

## [0.7.7] - 2026-05-17

### Added
- **Multi-agent installer** (closes [#137](https://github.com/colbymchenry/codegraph/issues/137)).
  `codegraph install` now opens with a multi-select prompt for **Claude Code**,
  **Cursor**, **Codex CLI**, and **opencode** — detected agents are pre-checked.
  Each writes its native MCP config + instructions file (e.g. `~/.cursor/mcp.json`
  + `.cursor/rules/codegraph.mdc`, `~/.codex/config.toml` + `~/.codex/AGENTS.md`,
  `~/.config/opencode/opencode.json`). The runtime MCP server was already
  agent-agnostic; this brings the installer to parity.
- Non-interactive install flags for scripting / CI:
  `--target=<csv|auto|all|none>`, `--location=<global|local>`, `--yes`,
  `--no-permissions`, `--print-config <id>`.
- `codegraph init` now auto-wires project-local agent surfaces for any agent
  configured globally. In practice: Cursor's `.cursor/rules/codegraph.mdc`
  is dropped on `init` so a single global `codegraph install` works in every
  project you open — no per-project re-install needed.

### Fixed
- **Cursor**: globally-installed codegraph reported "not initialized" in every
  workspace because Cursor launches MCP-server subprocesses with the wrong
  working directory and doesn't pass `rootUri` in the MCP initialize call.
  We now inject `--path` into Cursor's MCP args — absolute path for local
  installs, `${workspaceFolder}` for global installs.

### Changed
- Agent-instructions template is now agent-agnostic. The previous template was
  inherited from the Claude-only era and prescribed "spawn an Explore agent" —
  a Claude Code-specific concept that confused Cursor's and Codex's agents and
  caused them to fall back to native grep even with codegraph available. The
  new template adds explicit "trust codegraph results, don't re-verify with
  grep" guidance and a clear tool-by-question matrix. Applies to
  `~/.claude/CLAUDE.md`, `.cursor/rules/codegraph.mdc`, and `~/.codex/AGENTS.md`.
- `codegraph install` prompt order: agent picker is now step 1, before the
  PATH-install and location prompts.
- Disambiguated "global" wording in install prompts ("Install codegraph CLI on
  your PATH?" vs "Apply agent configs to all your projects, or just this one?")
  — both used to say "Global" and read as duplicates.

### Internal
- New `AgentTarget` interface in `src/installer/targets/` — adding a 5th agent
  (Continue, Zed, Windsurf, …) is a new file + one entry in `registry.ts`.
- Hand-rolled TOML serializer for Codex (`src/installer/targets/toml.ts`) — no
  new dependency, scoped to the `[mcp_servers.codegraph]` table only, sibling
  tables and `[[array_of_tables]]` preserved verbatim.
- +47 parameterized contract tests across the 4 targets — install idempotency,
  sibling preservation, uninstall reverses install, byte-equal re-runs return
  `unchanged`, partial-state recovery for Codex.

Based on substantive draft by [@andreinknv](https://github.com/andreinknv)
([fork commit `c5165e4`](https://github.com/andreinknv/codegraph/commit/c5165e4)).
Thank you.

[0.7.7]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.7

## [0.7.6] - 2026-05-13

### Fixed
- `codegraph` CLI failing with `zsh: permission denied: codegraph` after a fresh
  global install. The published 0.7.5 tarball shipped `dist/bin/codegraph.js`
  without the executable bit, so the shell refused to run it through the npm
  symlink. The build now `chmod +x`'s the binary before packing.

  Already on 0.7.5? Either upgrade to 0.7.6, or unblock yourself in place:
  ```bash
  chmod +x "$(npm root -g)/@colbymchenry/codegraph/dist/bin/codegraph.js"
  ```

[0.7.6]: https://github.com/colbymchenry/codegraph/releases/tag/v0.7.6
