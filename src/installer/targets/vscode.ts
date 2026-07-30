/**
 * VS Code Copilot Chat target.
 *
 *   - MCP server entry to the VS Code user-profile `mcp.json` (global) or
 *     `.vscode/mcp.json` in the project root (local). VS Code uses the key
 *     `servers` (not `mcpServers`) in its MCP config files.
 *
 * Global path is platform-specific:
 *   - macOS:   ~/Library/Application Support/Code/User/profiles/default/mcp.json
 *   - Linux:   ~/.config/Code/User/profiles/default/mcp.json
 *   - Windows: %APPDATA%\Code\User\profiles\default\mcp.json
 *
 * Local path: .vscode/mcp.json in the current working directory.
 *
 * No permissions concept — VS Code gates tool invocations through its own
 * trust prompts. `autoAllow` is silently ignored.
 *
 * No instructions file — VS Code Copilot Chat does not have an equivalent
 * to CLAUDE.md / AGENTS.md / GEMINI.md.
 *
 * Docs: https://code.visualstudio.com/docs/copilot/chat/mcp-servers
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

/**
 * Resolve the VS Code user-profile MCP config path.
 *
 * VS Code stores per-user MCP configuration in the default profile directory.
 * Users with custom profiles will need to add the entry manually via
 * "MCP: Open User Configuration" in the VS Code command palette.
 */
function globalMcpPath(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
        'Code', 'User', 'profiles', 'default', 'mcp.json',
      );
    case 'darwin':
      return path.join(
        os.homedir(), 'Library', 'Application Support',
        'Code', 'User', 'profiles', 'default', 'mcp.json',
      );
    default: // linux
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
        'Code', 'User', 'profiles', 'default', 'mcp.json',
      );
  }
}

function localMcpPath(): string {
  return path.join(process.cwd(), '.vscode', 'mcp.json');
}

function mcpPath(loc: Location): string {
  return loc === 'global' ? globalMcpPath() : localMcpPath();
}

/**
 * Heuristic: detect whether VS Code is installed by checking for the
 * existence of its user-data directory root (`Code/User/`).
 */
function vscodeUserDir(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
        'Code', 'User',
      );
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
        'Code', 'User',
      );
  }
}

class VSCodeTarget implements AgentTarget {
  readonly id = 'vscode' as const;
  readonly displayName = 'VS Code Copilot Chat';
  readonly docsUrl = 'https://code.visualstudio.com/docs/copilot/chat/mcp-servers';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.servers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(vscodeUserDir()) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(path.join(process.cwd(), '.vscode'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc)],
      notes: ['Restart VS Code for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location): string {
    const target = mcpPath(loc);
    const entry = getMcpServerConfig();
    const snippet = JSON.stringify({ servers: { codegraph: entry } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.servers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  const action: 'created' | 'updated' =
    fs.existsSync(file) ? 'updated' : 'created';
  if (!existing.servers) existing.servers = {};
  existing.servers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpPath(loc);
  const config = readJsonFile(file);
  if (!config.servers?.codegraph) {
    return { path: file, action: 'not-found' };
  }
  delete config.servers.codegraph;
  if (Object.keys(config.servers).length === 0) {
    delete config.servers;
  }
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const vscodeTarget: AgentTarget = new VSCodeTarget();
