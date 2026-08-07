/**
 * opencode target — an instantiation of the opencode-family factory
 * (`./opencode-family.ts`, where all the mechanics live: jsonc
 * `mcp.<name>` wrapper, XDG-only dir resolution on every platform,
 * `.jsonc`-over-`.json` preference, AGENTS.md instructions, legacy
 * `%APPDATA%` sweep #535).
 */

import { AgentTarget } from './types';
import { createOpencodeFamilyTarget } from './opencode-family';

export const opencodeTarget: AgentTarget = createOpencodeFamilyTarget({
  id: 'opencode',
  displayName: 'opencode',
  docsUrl: 'https://opencode.ai/docs/config',
  appName: 'opencode',
  schemaUrl: 'https://opencode.ai/config.json',
  // Only the built-in opencode target has a pre-#535 %APPDATA% install
  // base to heal; forks never wrote there.
  sweepLegacyWindowsAppData: true,
});
