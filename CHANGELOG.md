# Changelog

All notable changes to CodeGraph are documented here. Each entry also ships as
a [GitHub Release](https://github.com/colbymchenry/codegraph/releases) tagged
`vX.Y.Z`, which is where most people will look.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **CodeIgniter 3 framework support**. CodeGraph now indexes CI3 projects
  with the same depth it already had for Laravel:
  - **Explicit routes** from `application/config/routes.php` —
    `$route['pattern'] = 'controller/method'`, including HTTP-verb-scoped
    variants (`$route['x']['POST'] = '...'`) and CI3 wildcards (`(:any)`,
    `(:num)`). Reserved keys (`default_controller`, `404_override`,
    `translate_uri_dashes`) are skipped.
  - **Convention routes** synthesized from every public method on each
    controller in `application/controllers/**`. Without this the graph
    would be near-empty since most CI3 projects barely touch routes.php.
    URLs are lowercased per CI3 routing rules, methods prefixed with `_`
    and `__construct`/`__destruct` are excluded. Recognized controller
    bases: `CI_Controller`, `MX_Controller` (HMVC), `MY_Controller`,
    `REST_Controller`, plus common project-specific patterns
    (`Admin_Controller`, `Public_Controller`, `Frontend_Controller`,
    `Backend_Controller`).
  - **Magic-loaded models and libraries** — both `$this->load->model('X')`
    / `$this->load->library('X')` calls and the runtime property accesses
    that follow (`$this->ModelName->method()`). Critical for CI3
    codebases: in a real-world project, only ~0.2% of model usages are
    explicit `load->model()` calls; the rest are property accesses on
    pre-loaded models that pure static analysis can't see. The resolver
    filters by PascalCase to avoid false positives on built-in CI3
    properties (`$this->load`, `$this->db`, `$this->input`, …).
- Reference resolution: `controller/method` strings in routes.php resolve
  to method nodes in `application/controllers/`, trying both PascalCase
  (CI3 file-naming convention) and the literal segment as fallback.

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
