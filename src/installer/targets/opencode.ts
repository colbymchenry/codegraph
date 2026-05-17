/**
 * opencode target.
 *
 *   - MCP server entry to `~/.config/opencode/opencode.json` (global,
 *     XDG-style; `%APPDATA%/opencode/opencode.json` on Windows) or
 *     `./opencode.json` (local).
 *   - No instructions file built in (opencode doesn't have a
 *     conventional agent-rules surface as of 2026-05).
 *   - No permissions concept.
 *
 * Config shape uses opencode's wrapper:
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "mcp": { "codegraph": { "type": "local", "command": [...], "enabled": true } }
 *   }
 *
 * The shape differs from Claude/Cursor — opencode uses `mcp.<name>`
 * (not `mcpServers`), takes `command` as a string array combining
 * binary + args, and includes an explicit `enabled` flag.
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
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function globalConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'opencode');
  }
  // XDG_CONFIG_HOME if set, else ~/.config — matches opencode's docs.
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'opencode');
}

function configPath(loc: Location): string {
  return loc === 'global'
    ? path.join(globalConfigDir(), 'opencode.json')
    : path.join(process.cwd(), 'opencode.json');
}

function getOpencodeServerEntry(): { type: string; command: string[]; enabled: boolean } {
  return {
    type: 'local',
    command: ['codegraph', 'serve', '--mcp'],
    enabled: true,
  };
}

class OpencodeTarget implements AgentTarget {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly docsUrl = 'https://opencode.ai/docs/config';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcp?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir())
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const file = configPath(loc);
    const existing = readJsonFile(file);
    const before = existing.mcp?.codegraph;
    const after = getOpencodeServerEntry();

    if (jsonDeepEqual(before, after)) {
      return { files: [{ path: file, action: 'unchanged' }] };
    }

    const created = !fs.existsSync(file);
    if (!existing.$schema) existing.$schema = 'https://opencode.ai/config.json';
    if (!existing.mcp) existing.mcp = {};
    existing.mcp.codegraph = after;
    writeJsonFile(file, existing);
    return {
      files: [{ path: file, action: created ? 'created' : 'updated' }],
    };
  }

  uninstall(loc: Location): WriteResult {
    const file = configPath(loc);
    const config = readJsonFile(file);
    if (!config.mcp?.codegraph) {
      return { files: [{ path: file, action: 'not-found' }] };
    }
    delete config.mcp.codegraph;
    if (Object.keys(config.mcp).length === 0) {
      delete config.mcp;
    }
    // If the file is now degenerate (only $schema or empty), leave it
    // — the user may have other config we shouldn't nuke.
    writeJsonFile(file, config);
    return { files: [{ path: file, action: 'removed' }] };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { codegraph: getOpencodeServerEntry() },
    }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc)];
  }
}

export const opencodeTarget: AgentTarget = new OpencodeTarget();
