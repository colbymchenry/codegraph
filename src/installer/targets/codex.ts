/**
 * OpenAI Codex CLI target — an instantiation of the toml-family
 * factory (`./toml-family.ts`, where all the mechanics live: the
 * `[mcp_servers.codegraph]` table via `./toml.ts`, AGENTS.md
 * instructions next to the config).
 *
 * Codex CLI as of 2026-05 has no project-local config concept —
 * everything lives under `~/.codex/`. No `localConfigDir` in the spec
 * means `supportsLocation('local')` returns false and the orchestrator
 * skips Codex when the user picks the local install location.
 */

import { AgentTarget } from './types';
import { createTomlFamilyTarget } from './toml-family';

export const codexTarget: AgentTarget = createTomlFamilyTarget({
  id: 'codex',
  displayName: 'Codex CLI',
  docsUrl: 'https://github.com/openai/codex',
  configDir: '~/.codex',
});
