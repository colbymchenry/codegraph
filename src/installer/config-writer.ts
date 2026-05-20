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

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  writeMcpEntry,
  writePermissionsEntry,
  writeInstructionsEntry,
} from './targets/claude';
import { readJsonFile } from './targets/shared';

export type InstallLocation = 'global' | 'local';

/**
 * Each shim calls ONLY the named per-file helper — writeMcpConfig
 * writes only the MCP JSON, writePermissions only settings.json,
 * writeClaudeMd only CLAUDE.md. The full multi-file install lives
 * in `claudeTarget.install()` which the new orchestrator uses.
 */
export function writeMcpConfig(location: InstallLocation): void {
  writeMcpEntry(location);
}

export function writePermissions(location: InstallLocation): void {
  writePermissionsEntry(location);
}

export function writeClaudeMd(location: InstallLocation): { created: boolean; updated: boolean } {
  const file = writeInstructionsEntry(location);
  return {
    created: file.action === 'created',
    updated: file.action === 'updated',
  };
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

export function hasClaudeMdSection(location: InstallLocation): boolean {
  const file = location === 'global'
    ? path.join(os.homedir(), '.claude', 'CLAUDE.md')
    : path.join(process.cwd(), '.claude', 'CLAUDE.md');
  try {
    if (!fs.existsSync(file)) return false;
    const content = fs.readFileSync(file, 'utf-8');
    return content.includes('<!-- CODEGRAPH_START -->') || content.includes('## CodeGraph');
  } catch {
    return false;
  }
}
