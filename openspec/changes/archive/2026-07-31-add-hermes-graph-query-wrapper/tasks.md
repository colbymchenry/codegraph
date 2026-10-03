## 1. Integration Asset Design

- [x] 1.1 Inspect the current Hermes installer target and decide the exact generated asset path/name for the wrapper.
- [x] 1.2 Define the wrapper guidance for routing natural-language questions to CodeGraph MCP tools.
- [x] 1.3 Include explicit `projectPath` recovery guidance for sessions launched outside the indexed repo.
- [x] 1.4 Include requirements to preserve staleness, worktree mismatch, and not-initialized notices.

## 2. Implementation

- [x] 2.1 Add the Hermes wrapper asset/template to the CodeGraph source tree.
- [x] 2.2 Wire the Hermes installer target to emit or reference the wrapper without changing existing MCP config behavior.
- [x] 2.3 Ensure wrapper guidance prefers MCP tools and documents CLI fallback for manual verification.
- [x] 2.4 Update any installer instructions or printed notes needed for Hermes users to discover the wrapper.

## 3. Tests

- [x] 3.1 Add or update Hermes installer target tests to verify the wrapper asset is generated or referenced.
- [x] 3.2 Add test coverage that existing `mcp_servers.codegraph` and `platform_toolsets.cli` behavior remains unchanged.
- [x] 3.3 Add fixture-level verification that the wrapper guidance includes projectPath recovery.
- [x] 3.4 Add fixture-level verification that staleness/worktree/not-initialized notices must be preserved.

## 4. Validation

- [x] 4.1 Run the relevant Vitest tests for installer and MCP tooling.
- [x] 4.2 Run `npm run build` to verify generated TypeScript output and asset copying.
- [x] 4.3 Manually inspect the generated Hermes output path or config snippet for correctness.
- [x] 4.4 Run `openspec validate add-hermes-graph-query-wrapper --type change --strict` and fix any spec or artifact issues.
