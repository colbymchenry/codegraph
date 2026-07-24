/**
 * Qwen Code target. Writes:
 *
 *   - MCP server entry to `~/.qwen/settings.json` (global) or
 *     `./.qwen/settings.json` (local) under the standard
 *     `mcpServers.codegraph` key. Qwen Code is Gemini CLI-derived but
 *     documents stdio servers as `command` + `args` entries, without a
 *     `type: "stdio"` discriminator.
 *   - Instructions to `~/.qwen/QWEN.md` (global) or `./QWEN.md`
 *     (local). Qwen Code's hierarchical context loader reads QWEN.md,
 *     matching Gemini CLI's GEMINI.md behavior.
 *
 * No permissions concept — Qwen Code gates MCP invocations through the
 * per-server `trust` field and UI prompts. We leave `trust` unset so
 * the user controls confirmation prompts.
 *
 * Docs:
 *   https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/
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
  removeMarkedSection,
  writeJsonFile,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.qwen')
    : path.join(process.cwd(), '.qwen');
}

function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}

function instructionsPath(loc: Location): string {
  return loc === 'global'
    ? path.join(configDir('global'), 'QWEN.md')
    : path.join(process.cwd(), 'QWEN.md');
}

class QwenTarget implements AgentTarget {
  readonly id = 'qwen' as const;
  readonly displayName = 'Qwen Code';
  readonly docsUrl = 'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/';

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
    files.push(upsertInstructionsEntry(instructionsPath(loc)));
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

    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildQwenMcpEntry() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildQwenMcpEntry();

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

function buildQwenMcpEntry(): { command: string; args: string[] } {
  return {
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

/**
 * Strip the marker-delimited CodeGraph block from QWEN.md if a prior
 * install wrote one.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const qwenTarget: AgentTarget = new QwenTarget();
