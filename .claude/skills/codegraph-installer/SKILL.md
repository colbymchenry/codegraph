---
name: codegraph-installer
description: Use when editing anything under src/installer/, changing `codegraph install` or uninstall, adding or removing a supported agent target, or changing installer configuration or the instructions template.
---

# Multi-agent installer

`src/installer/` is the entry point for `codegraph install` (and the bare `codegraph`/`npx @colbymchenry/codegraph` invocation). Architecture:

- `targets/registry.ts` lists every supported agent.
- `targets/types.ts` defines the `AgentTarget` interface — adding a 5th agent (Continue, Zed, Windsurf…) is **one new file in `targets/` + one entry in `registry.ts`**. Each target owns its config-file location and MCP-server JSON/TOML/JSONC writing. (Claude, Codex, Gemini and opencode also write a short instructions-file block — see below.)
- Current targets: `claude.ts`, `cursor.ts`, `codex.ts`, `opencode.ts`.
- `targets/toml.ts` is a hand-rolled TOML serializer scoped to `[mcp_servers.codegraph]` (used by Codex). Sibling tables and `[[array_of_tables]]` are preserved verbatim. No new dependency.
- opencode reads `opencode.jsonc` by default; the installer prefers existing `.jsonc`, falls back to `.json`, and creates `.jsonc` for greenfield installs. Edits are surgical via `jsonc-parser` so user comments and formatting survive install/re-install/uninstall round-trips. The MCP entry is OpenCode 2's native `mcp.servers.codegraph` with `disabled: false` and `codemode: false` (so `codegraph_explore` stays on the native tool list); a pre-#1698 `mcp.codegraph` + `enabled` entry is migrated on re-install and removed by uninstall.
- `instructions-template.ts` holds `CODEGRAPH_INSTRUCTIONS_BLOCK`, a deliberately short marker-fenced (`<!-- CODEGRAPH_START -->`/`<!-- CODEGRAPH_END -->`) `## CodeGraph` block. The Claude, Codex, Gemini and opencode targets write it into their instructions file (`CLAUDE.md` / `~/.codex/AGENTS.md` / `~/.gemini/GEMINI.md` / `~/.config/opencode/AGENTS.md`) via `upsertInstructionsEntry`, and `uninstall` removes it. History: #529 removed the old full playbook because it duplicated the MCP `initialize` instructions; #704 brought back this small block because the instructions file reaches two audiences `initialize` cannot — Task-tool subagents and non-MCP harnesses (the `codegraph explore` CLI). Cursor and Kiro write no block; their `install` only strips one a previous install left behind. Keep the block to command names and the two surfaces; tool guidance itself still belongs in `server-instructions.ts`.
- `__tests__/installer-targets.test.ts` is the parameterized contract suite across all 4 agent targets — there are ~47 tests covering install idempotency, sibling preservation, uninstall reverses install, byte-equal re-runs returning `unchanged`, and partial-state recovery for Codex.

## Cursor MCP working-directory quirk

Cursor launches MCP subprocesses with the wrong cwd and doesn't pass `rootUri` in `initialize`. The installer injects `--path` into Cursor's MCP args — absolute path for local installs, `${workspaceFolder}` for global installs. If you touch Cursor wiring, preserve this.
