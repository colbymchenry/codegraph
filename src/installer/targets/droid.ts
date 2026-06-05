/**
 * Factory Droid target. Writes:
 *
 *   - MCP server entry to `~/.factory/mcp.json` (global = user scope,
 *     loads in every project) or `./.factory/mcp.json` (local = project
 *     scope, committed to the repo). Standard `mcpServers.codegraph`
 *     shape, same as Claude / Cursor / Gemini / Kiro.
 *
 * No permissions concept — Droid gates tool runs through its own
 * autonomy levels, not an external allowlist. `autoAllow` is ignored.
 *
 * No instructions file — the codegraph usage guidance ships in the MCP
 * server's `initialize` response (issue #529), which Droid surfaces
 * automatically.
 *
 * Docs: https://docs.factory.ai/cli/configuration/mcp
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
    ? path.join(os.homedir(), '.factory')
    : path.join(process.cwd(), '.factory');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

class FactoryDroidTarget implements AgentTarget {
  readonly id = 'droid' as const;
  readonly displayName = 'Factory Droid';
  readonly docsUrl = 'https://docs.factory.ai/cli/configuration/mcp';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed =
      loc === 'global'
        ? fs.existsSync(configDir('global')) || fs.existsSync(file)
        : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc)],
      notes: ['Restart Droid for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);

    if (!config.mcpServers?.codegraph) {
      return { files: [{ path: file, action: 'not-found' }] };
    }

    delete config.mcpServers.codegraph;
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
    writeJsonFile(file, config);
    return { files: [{ path: file, action: 'removed' }] };
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
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  const action: 'created' | 'updated' =
    before ? 'updated' : fs.existsSync(file) ? 'updated' : 'created';
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const droidTarget: AgentTarget = new FactoryDroidTarget();
