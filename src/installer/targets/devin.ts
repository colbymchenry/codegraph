/**
 * Devin for Terminal target.
 *
 *   - User config: `~/.config/devin/config.json` (POSIX) or
 *     `%APPDATA%/devin/config.json` (Windows).
 *   - Project config: `./.devin/config.json`.
 *   - MCP config goes under `mcpServers.codegraph` with the stdio
 *     block `{ command: 'codegraph', args: ['serve', '--mcp'] }`.
 *   - Devin reads `AGENTS.md`, so global writes `~/.config/devin/AGENTS.md`
 *     and local writes `./AGENTS.md`.
 *   - No permissions concept.
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
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
  INSTRUCTIONS_TEMPLATE,
} from '../instructions-template';

function globalConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'devin');
  }
  return path.join(os.homedir(), '.config', 'devin');
}

function configPath(loc: Location): string {
  return path.join(loc === 'global' ? globalConfigDir() : path.join(process.cwd(), '.devin'), 'config.json');
}

function instructionsPath(loc: Location): string {
  return path.join(loc === 'global' ? globalConfigDir() : process.cwd(), 'AGENTS.md');
}

function readConfig(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  try {
    const text = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

class DevinTarget implements AgentTarget {
  readonly id = 'devin' as const;
  readonly displayName = 'Devin for Terminal';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = readConfig(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir())
      : fs.existsSync(path.join(process.cwd(), '.devin'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc), writeInstructionsEntry(loc)],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const file = configPath(loc);
    if (!fs.existsSync(file)) {
      files.push({ path: file, action: 'not-found' });
    } else {
      const config = readConfig(file);
      if (!config.mcpServers?.codegraph) {
        files.push({ path: file, action: 'not-found' });
      } else {
        delete config.mcpServers.codegraph;
        if (Object.keys(config.mcpServers).length === 0) {
          delete config.mcpServers;
        }
        writeJsonFile(file, config);
        files.push({ path: file, action: 'removed' });
      }
    }

    files.push({
      path: instructionsPath(loc),
      action: removeMarkedSection(instructionsPath(loc), CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END),
    });
    return { files };
  }

  printConfig(loc: Location): string {
    return `# Add to ${configPath(loc)}\n\n${JSON.stringify({
      mcpServers: { codegraph: getMcpServerConfig() },
    }, null, 2)}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const existed = fs.existsSync(file);
  const config = readConfig(file);
  const before = config.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.codegraph = after;
  writeJsonFile(file, config);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  return {
    path: file,
    action: action === 'created' ? 'created' : action === 'unchanged' ? 'unchanged' : 'updated',
  };
}

export const devinTarget: AgentTarget = new DevinTarget();
