/**
 * Qwen Code target.
 *
 * Qwen Code is an open-source AI coding agent that lives in the terminal.
 * It reads MCP server configuration from JSON settings files:
 *
 *   - Global (user scope):  ~/.qwen/settings.json
 *   - Local (project scope): ./.qwen/settings.json
 *
 * The MCP server entry lives under the top-level `mcpServers` key, same
 * shape as Claude / Cursor / Gemini.
 *
 * Qwen Code does not have a separate permissions / auto-allow concept —
 * tool confirmation is handled per-server at runtime, so `autoAllow` is
 * a no-op here.
 *
 * No instructions file is written (issue #529); usage guidance ships in
 * the MCP server's `initialize` response.
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
    ? path.join(os.homedir(), '.qwen')
    : path.join(process.cwd(), '.qwen');
}

function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}

class QwenTarget implements AgentTarget {
  readonly id = 'qwen' as const;
  readonly displayName = 'Qwen Code';
  readonly docsUrl = 'https://qwenlm.github.io/qwen-code-docs/';

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
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    return { files };
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

export const qwenTarget: AgentTarget = new QwenTarget();
