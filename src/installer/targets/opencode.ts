/**
 * opencode target: one instantiation of the opencode family factory
 * (`./opencode-family.ts`, where the mechanics live: OpenCode 2's
 * `mcp.servers` wrapper with the migration of the older `mcp.codegraph`
 * shape, XDG config dir resolution on every platform, `.jsonc` over `.json`,
 * the `AGENTS.md` block, and the sweep of the `%APPDATA%` state an install
 * before #535 left behind, which only opencode itself has).
 */

import { AgentTarget } from './types';
import { createOpencodeFamilyTarget } from './opencode-family';

export const opencodeTarget: AgentTarget = createOpencodeFamilyTarget({
  id: 'opencode',
  displayName: 'opencode',
  docsUrl: 'https://opencode.ai/docs/config',
  appName: 'opencode',
  schemaUrl: 'https://opencode.ai/config.json',
  // Only the opencode target has an install base from before #535 to heal;
  // a fork never wrote under %APPDATA%.
  sweepLegacyWindowsAppData: true,
});
