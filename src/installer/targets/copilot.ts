/**
 * GitHub Copilot CLI target.
 *
 *   - MCP server entry to `~/.copilot/mcp-config.json` (global) or
 *     `.github/mcp.json` in the project root (local) under the standard
 *     `mcpServers.codegraph` key.
 *
 * The Copilot CLI config uses `type: "local"` and requires a `tools` array
 * (use `["*"]` to enable all tools). Both fields are mandatory for the CLI
 * to start the server.
 *
 * Docs: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
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
  return path.join(os.homedir(), '.copilot');
}

function globalMcpPath(): string {
  return path.join(globalConfigDir(), 'mcp-config.json');
}

function localMcpPath(): string {
  return path.join(process.cwd(), '.github', 'mcp.json');
}

function mcpPath(loc: Location): string {
  return loc === 'global' ? globalMcpPath() : localMcpPath();
}

function getCopilotServerEntry(): { type: string; command: string; args: string[]; tools: string[] } {
  return {
    type: 'local',
    command: 'codegraph',
    args: ['serve', '--mcp'],
    tools: ['*'],
  };
}

class CopilotCliTarget implements AgentTarget {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly docsUrl = 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir()) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(path.join(process.cwd(), '.github'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc)],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location): string {
    const target = mcpPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getCopilotServerEntry() } }, null, 2);
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
  const before = existing.mcpServers?.codegraph;
  const after = getCopilotServerEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  const action: 'created' | 'updated' =
    fs.existsSync(file) ? 'updated' : 'created';
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpPath(loc);
  const config = readJsonFile(file);
  if (!config.mcpServers?.codegraph) {
    return { path: file, action: 'not-found' };
  }
  delete config.mcpServers.codegraph;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const copilotTarget: AgentTarget = new CopilotCliTarget();
