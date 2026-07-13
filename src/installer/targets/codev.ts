/**
 * CoDev Code target.
 *
 * CoDev Code (npm `codev-code`, binary `codev`) is a fork of opencode
 * that renames the on-disk app identity but keeps opencode's config
 * shape byte-for-byte: same `mcp.<name>` wrapper, same
 * `{ type: "local", command: [...], enabled: true }` entry, and the
 * same `https://opencode.ai/config.json` `$schema` (CoDev stamps that
 * URL into fresh configs itself). Only the paths differ:
 *
 *   - `~/.config/codev/codev.jsonc` instead of
 *     `~/.config/opencode/opencode.jsonc` (global; XDG on every platform)
 *   - `./codev.jsonc` instead of `./opencode.jsonc` (local)
 *   - `~/.config/codev/AGENTS.md` for the instructions block; the
 *     project-local `./AGENTS.md` convention is unchanged.
 *
 * So this is a thin spec over the shared opencode-family implementation.
 * No `%APPDATA%` sweep: the pre-#535 Windows misplacement is opencode
 * install history that CoDev never had.
 */

import { AgentTarget } from './types';
import { createOpencodeFamilyTarget } from './opencode-family';

export const codevTarget: AgentTarget = createOpencodeFamilyTarget({
  id: 'codev',
  displayName: 'CoDev Code',
  docsUrl: 'https://github.com/quickbeard/codev-code',
  appName: 'codev',
  sweepLegacyWindowsAppData: false,
});
