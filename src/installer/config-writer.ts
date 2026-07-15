/**
 * Backwards-compat shim — original Claude-only writer functions.
 *
 * The installer now uses the multi-target architecture in
 * `./targets/`. This file is preserved so existing imports (the test
 * suite, downstream tooling) keep working unchanged. Each function
 * delegates to the Claude target. New code should import the target
 * registry from `./targets/registry` directly.
 *
 * @deprecated Use `targets/registry.ts` and the `AgentTarget`
 *   abstraction instead.
 */

import * as path from 'path';
import * as os from 'os';
import {
  writeMcpEntry,
  writePermissionsEntry,
} from './targets/claude';
import { readJsonFile } from './targets/shared';

export type InstallLocation = 'global' | 'local';

/**
 * Each shim calls ONLY the named per-file helper — writeMcpConfig
 * writes only the MCP JSON, writePermissions only settings.json. The
 * full multi-file install lives in `claudeTarget.install()` which the
 * new orchestrator uses.
 *
 * There is no `writeClaudeMd` shim anymore: codegraph stopped writing a
 * CLAUDE.md instructions block (issue #529) now that the MCP server's
 * `initialize` instructions are the single source of truth.
 */
export function writeMcpConfig(location: InstallLocation): void {
  writeMcpEntry(location);
}

export function writePermissions(location: InstallLocation): void {
  writePermissionsEntry(location);
}

export function hasMcpConfig(location: InstallLocation): boolean {
  // local scope lives in ./.mcp.json (project scope); global is the
  // user-scope ~/.claude.json. Mirrors the Claude target's paths.
  const file = location === 'global'
    ? path.join(os.homedir(), '.claude.json')
    : path.join(process.cwd(), '.mcp.json');
  const config = readJsonFile(file);
  return !!config.mcpServers?.codegraph;
}

export function hasPermissions(location: InstallLocation): boolean {
  const file = location === 'global'
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(process.cwd(), '.claude', 'settings.json');
  const settings = readJsonFile(file);
  const allow = settings.permissions?.allow;
  if (!Array.isArray(allow)) return false;
  return allow.some((p: string) => p.startsWith('mcp__codegraph__'));
}
