/**
 * Qoder target.
 *
 *   - MCP server entry to `~/.qoder/settings.json` (global) or
 *     `./.qoder/settings.local.json` (local) under the standard
 *     `mcpServers.codegraph` key. Same shape as Claude / Cursor /
 *     Gemini. Qoder CLI writes user-scope servers to the first file
 *     and project-scope servers to the second.
 *   - Instructions to `~/.qoder/AGENTS.md` (global) or `./AGENTS.md`
 *     (local) — Qoder reads both as memory files.
 *
 * No permissions concept — Qoder gates tool invocations itself, so
 * `autoAllow` is a no-op and there is no allowlist file to write. No
 * prompt hook either; Qoder has no equivalent of Claude Code's
 * UserPromptSubmit.
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
    ? path.join(os.homedir(), '.qoder')
    : path.join(process.cwd(), '.qoder');
}
function settingsJsonPath(loc: Location): string {
  // User-scope servers live in ~/.qoder/settings.json; project-scope
  // servers live in the project's .qoder/settings.local.json.
  return loc === 'global'
    ? path.join(configDir('global'), 'settings.json')
    : path.join(configDir('local'), 'settings.local.json');
}
function instructionsPath(loc: Location): string {
  // Global memory lives under ~/.qoder/; project memory is AGENTS.md
  // at the project root (not under .qoder/).
  return loc === 'global'
    ? path.join(configDir('global'), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

class QoderTarget implements AgentTarget {
  readonly id = 'qoder' as const;
  readonly displayName = 'Qoder';
  readonly docsUrl = 'https://docs.qoder.com/cli/mcp-servers';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = fs.existsSync(file) || fs.existsSync(configDir(loc));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
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
      // Leave an emptied settings file in place — other settings the
      // user may add later share it; deleting it would be surprising.
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
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
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

/**
 * Strip the marker-delimited CodeGraph block from AGENTS.md if a prior
 * install wrote one. Used by both install (self-heal on upgrade) and
 * uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const qoderTarget: AgentTarget = new QoderTarget();
