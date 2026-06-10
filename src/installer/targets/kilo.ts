/**
 * Kilo CLI / IDE target. Writes:
 *
 *   - MCP server entry to `kilo.json` (project) or
 *     `~/.config/kilo/kilo.json` (global). Standard `mcp.codegraph`
 *     shape using Kilo's MCP config format.
 *
 * Kilo supports MCP via `kilo.json` with the following structure:
 *
 *   {
 *     "mcp": {
 *       "codegraph": {
 *         "type": "local",
 *         "command": ["codegraph", "serve", "--mcp"],
 *         "enabled": true,
 *         "timeout": 30000
 *       }
 *     }
 *   }
 *
 * No permissions concept — Kilo manages tool permissions through its
 * own permission system in `kilo.json`.
 *
 * Docs: https://kilo.ai/docs
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
    ? path.join(os.homedir(), '.config', 'kilo')
    : path.join(process.cwd(), '.kilo');
}
function kiloJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'kilo.json');
}

class KiloTarget implements AgentTarget {
  readonly id = 'kilo' as const;
  readonly displayName = 'Kilo';
  readonly docsUrl = 'https://kilo.ai/docs';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = kiloJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcp?.codegraph;
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
      notes: ['Restart Kilo for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = kiloJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcp?.codegraph) {
      delete config.mcp.codegraph;
      if (Object.keys(config.mcp).length === 0) {
        delete config.mcp;
      }
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = kiloJsonPath(loc);
    const snippet = JSON.stringify({
      mcp: {
        codegraph: getKiloMcpConfig(),
      },
    }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [kiloJsonPath(loc)];
  }
}

function getKiloMcpConfig(): Record<string, unknown> {
  const base = getMcpServerConfig();
  return {
    type: 'local',
    command: base.command,
    enabled: true,
    timeout: 30000,
  };
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = kiloJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcp?.codegraph;
  const after = getKiloMcpConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcp) existing.mcp = {};
  existing.mcp.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export const kiloTarget: AgentTarget = new KiloTarget();
