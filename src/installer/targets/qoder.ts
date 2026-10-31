/**
 * Qoder CLI target. Writes the MCP server entry only, under `mcpServers` in:
 *
 *   - global: `settings.json` in `$QODER_CONFIG_DIR` (default `~/.qoder`)
 *   - local:  `./.qoder/settings.local.json`, the scope `qoder mcp add` writes
 *     by default. It stays on this machine, and Qoder loads it only once the
 *     folder is trusted.
 *
 * Qoder also reads a project `.mcp.json`, but that file is Claude Code's local
 * config too, so an uninstall here would take the server away from Claude.
 * Settings files may hold comments, and the edits keep them (`./json-config.ts`).
 * The entry is `{ command, args }`; a server with no `type` is a stdio server.
 *
 * The Qoder IDE is not covered: its docs show an in-app editor and name no file
 * on disk. No instructions file, and `autoAllow` is a no-op.
 *
 * Docs: https://docs.qoder.com/cli/mcp-reference
 *       https://docs.qoder.com/cli/mcp-servers
 *       https://docs.qoder.com/cli/settings
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import { hasCodegraphServer, removeCodegraphServer, upsertCodegraphServer } from './json-config';
import { configDirFromEnv, getStdioServerConfig } from './shared';

function configDir(loc: Location): string {
  return loc === 'global'
    ? configDirFromEnv('QODER_CONFIG_DIR', path.join(os.homedir(), '.qoder'))
    : path.join(process.cwd(), '.qoder');
}

function settingsPath(loc: Location): string {
  return path.join(configDir(loc), loc === 'global' ? 'settings.json' : 'settings.local.json');
}

class QoderTarget implements AgentTarget {
  readonly id = 'qoder' as const;
  readonly displayName = 'Qoder CLI';
  readonly docsUrl = 'https://docs.qoder.com/cli/mcp-reference';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsPath(loc);
    return {
      installed: fs.existsSync(configDir(loc)),
      alreadyConfigured: hasCodegraphServer(file),
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const notes = ['This sets up the Qoder CLI. In the Qoder IDE, add the server under Settings > MCP.'];
    if (loc === 'local') notes.push(`Qoder loads ${settingsPath('local')} only in a trusted folder.`);
    return { files: [upsertCodegraphServer(settingsPath(loc), getStdioServerConfig())], notes };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeCodegraphServer(settingsPath(loc))] };
  }

  printConfig(loc: Location): string {
    const snippet = JSON.stringify({ mcpServers: { codegraph: getStdioServerConfig() } }, null, 2);
    return `# Add to ${settingsPath(loc)}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsPath(loc)];
  }
}

export const qoderTarget: AgentTarget = new QoderTarget();
