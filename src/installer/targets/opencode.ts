/**
 * opencode target.
 *
 * Thin spec over the shared opencode-family implementation (see
 * `opencode-family.ts` for the config-resolution and write mechanics):
 *
 *   - MCP server entry to `~/.config/opencode/opencode.jsonc` (global,
 *     XDG-style on every platform; #535) or `./opencode.jsonc` (local).
 *   - Instructions block to the matching `AGENTS.md`.
 *   - `sweepLegacyWindowsAppData`: pre-#535 codegraph versions wrote the
 *     global entry to `%APPDATA%/opencode`, a dir opencode never reads —
 *     install/uninstall sweep a stale codegraph entry out of it.
 */

import { AgentTarget } from './types';
import { createOpencodeFamilyTarget } from './opencode-family';

export const opencodeTarget: AgentTarget = createOpencodeFamilyTarget({
  id: 'opencode',
  displayName: 'opencode',
  docsUrl: 'https://opencode.ai/docs/config',
  appName: 'opencode',
  sweepLegacyWindowsAppData: true,
});
