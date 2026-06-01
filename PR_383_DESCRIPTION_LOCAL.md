# PR: Add optional PII sanitization layer to MCP output (`issue #383`)

## Summary
This PR adds an optional sanitization layer in the MCP response pipeline so CodeGraph can redact sensitive content before indexed code/context is returned to downstream LLM agents.

It introduces:
- A built-in sanitizer (`--sanitize`) for common PII/secrets.
- A custom sanitizer middleware hook (`--sanitize-hook <modulePath>`) for organization-specific policies and external integrations.
- Centralized response sanitization in the MCP tool execution path so all tool payloads are covered consistently.

## Problem
Issue #383 highlights a privacy gap: indexed code can contain sensitive values (emails, phone numbers, identifiers, secret-like tokens), and CodeGraph currently returns tool output directly to the MCP client/agent.

In regulated/compliance-sensitive environments, users need an explicit pre-LLM sanitization control without giving up MCP functionality.

## Solution
### 1) Add built-in sanitization middleware
- New module: `src/mcp/sanitization.ts`
- Adds built-in redaction for:
  - Email addresses
  - Phone numbers
  - US SSNs
  - Credit-card-like values (with Luhn validation to reduce false positives)
  - Common API-key patterns (e.g. OpenAI-style and AWS access key IDs)

### 2) Add custom sanitizer hook
- Supports `CODEGRAPH_SANITIZE_HOOK` (or CLI `--sanitize-hook`) to load a user-provided module.
- Hook contract: function `(text: string) => string | Promise<string>`.
- Runs in MCP response pipeline and can layer additional policy controls.

### 3) Wire sanitization into MCP tool output path
- Updated `ToolHandler.execute()` in `src/mcp/tools.ts`.
- Sanitization is applied once centrally to final tool results, after existing wrappers (worktree/staleness handling), so response behavior remains consistent while enforcing redaction before output leaves MCP.

### 4) Expose CLI controls
- Updated `codegraph serve` in `src/bin/codegraph.ts`:
  - `--sanitize`
  - `--sanitize-hook <modulePath>`
- CLI options map to environment controls:
  - `CODEGRAPH_SANITIZE=1`
  - `CODEGRAPH_SANITIZE_HOOK=/absolute/path/to/hook.cjs`

## Documentation updates
- `README.md`
- `site/src/content/docs/reference/cli.md`
- `site/src/content/docs/reference/mcp-server.md`
- `CHANGELOG.md` (`[Unreleased]`)

## Tests
Added `__tests__/mcp-sanitization.test.ts` to cover:
- Built-in sanitizer redaction behavior.
- Env-gated built-in sanitization in MCP tool responses.
- Disabled-mode passthrough.
- Custom hook execution in MCP response path.

## Validation run
- `npm run build`
- `npx vitest run __tests__/mcp-sanitization.test.ts`
- `npx vitest run __tests__/mcp-tool-allowlist.test.ts`

## Backward compatibility
- Default behavior is unchanged unless sanitization is explicitly enabled.
- Existing MCP workflows continue to function as-is.

## Issue linkage
- Closes #383

Co-Authored-By: Oz <oz-agent@warp.dev>
