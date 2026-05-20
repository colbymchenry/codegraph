# Changelog

All notable changes to CodeGraph are documented here. Each entry also ships as
a [GitHub Release](https://github.com/colbymchenry/codegraph/releases) tagged
`vX.Y.Z`, which is where most people will look.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
  (<5,000) caps at ~28KB; large (<15,000) keeps the historical ~35KB; very
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

### Fixed
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
