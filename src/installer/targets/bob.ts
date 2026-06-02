/**
 * Bob target.
 *
 * Bob currently uses a simple JSON MCP config surface mirroring the
 * standard `{ mcpServers: { ... } }` shape used by Claude / Cursor /
 * Gemini / Kiro. We write:
 *
 *   - MCP server entry to `~/.bob/settings/mcp_settings.json` (global) or
 *     `./.bob/mcp.json` (local) under `mcpServers.codegraph`.
 *
 * No permissions concept — `autoAllow` is ignored.
 *
 * Bob-specific instructions files are intentionally NOT written. The
 * codegraph usage guidance now ships in the MCP server's `initialize`
 * response, which is the single source of truth for supported clients.
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

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.bob')
    : path.join(process.cwd(), '.bob');
}

function settingsJsonPath(loc: Location): string {
  if (loc === 'global') {
    return path.join(configDir(loc), 'settings', 'mcp_settings.json');
  } else {
    return path.join(configDir(loc), 'mcp.json');
  }
}

class BobTarget implements AgentTarget {
  readonly id = 'bob' as const;
  readonly displayName = 'Bob';
  readonly docsUrl = 'https://bob.ibm.com';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(configDir('global')) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return { files: [writeMcpEntry(loc)] };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsJsonPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const bobTarget: AgentTarget = new BobTarget();