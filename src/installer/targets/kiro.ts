/**
 * Kiro target (kiro.dev).
 *
 *   - MCP server entry to `~/.kiro/settings/mcp.json` (global = user
 *     scope) or `./.kiro/settings/mcp.json` (local = workspace scope).
 *     Same `{ mcpServers: { codegraph: {...} } }` shape as Claude /
 *     Cursor. Kiro auto-reconnects on file save, so no restart note is
 *     emitted (unlike Cursor).
 *     Docs: https://kiro.dev/docs/mcp/configuration/
 *
 * Kiro reads both files and merges with workspace precedence — same
 * pattern as Cursor and opencode. Nothing here needs an `--path`
 * workaround like Cursor's: Kiro launches MCP servers with the
 * workspace as cwd, so codegraph's normal `process.cwd()` resolution
 * finds `.codegraph/` correctly.
 *
 * No permissions / auto-allow surface — Kiro doesn't expose one the
 * installer can populate, so `autoAllow` is silently ignored. No
 * project-local instructions / steering surface is written by this
 * target; users who want a Kiro steering file can drop one under
 * `.kiro/steering/` themselves.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function kiroConfigDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.kiro')
    : path.join(process.cwd(), '.kiro');
}

function mcpJsonPath(loc: Location): string {
  return path.join(kiroConfigDir(loc), 'settings', 'mcp.json');
}

class KiroTarget implements AgentTarget {
  readonly id = 'kiro' as const;
  readonly displayName = 'Kiro';
  readonly docsUrl = 'https://kiro.dev/docs/mcp/configuration/';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // "Installed" heuristic: presence of a `.kiro` dir at the
    // location. Documented Kiro install flow doesn't promise a binary
    // on PATH, but both the user-global config and the workspace
    // config live under `.kiro/`, so its existence is the strongest
    // signal we have.
    const installed = fs.existsSync(kiroConfigDir(loc));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return { files: [writeMcpEntry(loc)] };
  }

  uninstall(loc: Location): WriteResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (!config.mcpServers?.codegraph) {
      return { files: [{ path: mcpPath, action: 'not-found' }] };
    }
    delete config.mcpServers.codegraph;
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
    writeJsonFile(mcpPath, config);
    return { files: [{ path: mcpPath, action: 'removed' }] };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { codegraph: getMcpServerConfig() } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before
    ? 'updated'
    : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const kiroTarget: AgentTarget = new KiroTarget();
