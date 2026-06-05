/**
 * Factory Droids target. Writes:
 *
 *   - MCP server entry to `~/.factory/mcp.json` (global) or
 *     `./.factory/mcp.json` (local). Standard `mcpServers.codegraph`
 *     shape, same as Claude / Cursor / Gemini.
 *
 * No permissions concept — Factory Droids gates tool invocations through its own
 * UI prompts rather than an external allowlist. `autoAllow` is silently
 * ignored.
 *
 * Paths are identical on macOS / Linux / Windows because Factory Droids resolves
 * its config root from `os.homedir()` on all three (Windows `~` →
 * `%USERPROFILE%\.factory`).
 *
 * Docs: https://app.factory.ai
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

class FactoryDroidsTarget implements AgentTarget {
  readonly id = 'factory' as const;
  readonly displayName = 'Factory Droids';
  readonly docsUrl = 'https://app.factory.ai';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(configDir('global')) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    return {
      files,
      notes: [
        'Restart the Droid CLI for MCP changes to take effect.',
      ],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }

      if (Object.keys(config).length === 0) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        files.push({ path: file, action: 'removed' });
      } else {
        writeJsonFile(file, config);
        files.push({ path: file, action: 'updated' });
      }
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
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
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const factoryTarget: AgentTarget = new FactoryDroidsTarget();
