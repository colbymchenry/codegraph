## Why

Hermes integration currently configures the CodeGraph MCP server, but it does not give Hermes users a dedicated, guided workflow for asking graph-backed codebase questions. A small Hermes-facing query wrapper would make the installed integration immediately useful by turning natural-language requests into the right CodeGraph MCP/CLI calls with project-path handling and clear fallbacks.

## What Changes

- Add a Hermes graph query wrapper capability for natural-language codebase questions.
- Provide a Hermes-facing entry point that routes questions to CodeGraph search, node, context, trace, callers/callees, impact, and files functionality as appropriate.
- Require the wrapper to resolve or request a project path when Hermes starts outside the indexed repository.
- Preserve existing MCP behavior and staleness/worktree notices in wrapper output.
- Add validation and documentation so the wrapper can be tested without requiring a live Hermes session.

## Capabilities

### New Capabilities
- `hermes-graph-query-wrapper`: A Hermes-facing workflow for answering codebase questions using CodeGraph graph/index data.

### Modified Capabilities

## Impact

- Affected areas: Hermes installer target, generated Hermes integration assets, MCP tool documentation, CLI verification path, and tests around generated config/assets.
- No breaking changes to existing CodeGraph CLI commands or MCP tool schemas are intended.
- No new runtime dependency is expected beyond the existing CodeGraph CLI/MCP integration.
