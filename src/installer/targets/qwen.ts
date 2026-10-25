/**
 * Qwen Code target. Writes:
 *
 *   - MCP server entry to `~/.qwen/settings.json` (global) or
 *     `./.qwen/settings.json` (local) under the standard
 *     `mcpServers.codegraph` key. Same shape as Claude / Cursor.
 *   - Permissions to `~/.qwen/settings.json` (global) or
 *     `./.qwen/settings.json` (local), gated on `autoAllow`.
 *   - Instructions to `~/.qwen/QWEN.md` (global) or `./QWEN.md`
 *     (local). Qwen Code reads the project root file directly, not
 *     under `.qwen/` — matching how Gemini reads `GEMINI.md`.
 *
 * Auto-edit style: writes through symbolic links, never replaces one with
 * a copy. Preserves formatting, comments and sibling keys.
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
  getCodeGraphPermissions,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
  upsertInstructionsEntry,
  removeMarkedSection,
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
  // Global QWEN.md lives under ~/.qwen/; project-local QWEN.md
  // lives at the project root (NOT under .qwen/), matching how
  // Qwen Code's hierarchical context loader searches.
  return loc === 'global'
    ? path.join(configDir('global'), 'QWEN.md')
    : path.join(process.cwd(), 'QWEN.md');
}

class QwenTarget implements AgentTarget {
  readonly id = 'qwen' as const;
  readonly displayName = 'Qwen Code';
  readonly docsUrl = 'https://github.com/QwenLM/qwen-code';

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

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // QWEN.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read QWEN.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    if (opts.autoAllow) {
      files.push(writePermissionsEntry(loc));
    }

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // Unlike Claude, Qwen keeps the MCP entry and the permissions
    // allowlist in one file (`settings.json`). Read it once, strip both,
    // and report a single result for the path — reading it twice would
    // push two entries for the same file, one of them a spurious
    // `not-found` whenever only one of the two was present.
    const file = settingsJsonPath(loc);
    const settings = readJsonFile(file);
    let changed = false;

    if (settings.mcpServers?.codegraph) {
      delete settings.mcpServers.codegraph;
      if (Object.keys(settings.mcpServers).length === 0) {
        delete settings.mcpServers;
      }
      changed = true;
    }

    if (Array.isArray(settings.permissions?.allow)) {
      const before = settings.permissions.allow.length;
      settings.permissions.allow = settings.permissions.allow.filter(
        (p: string) => !p.startsWith('mcp__codegraph__'),
      );
      if (settings.permissions.allow.length !== before) {
        if (settings.permissions.allow.length === 0) {
          delete settings.permissions.allow;
        }
        if (Object.keys(settings.permissions).length === 0) {
          delete settings.permissions;
        }
        changed = true;
      }
    }

    if (changed) {
      writeJsonFile(file, settings);
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

function writePermissionsEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const settings = readJsonFile(file);
  const created = !fs.existsSync(file);

  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  const want = getCodeGraphPermissions();
  const before = [...settings.permissions.allow];
  for (const perm of want) {
    if (!settings.permissions.allow.includes(perm)) {
      settings.permissions.allow.push(perm);
    }
  }
  if (jsonDeepEqual(before, settings.permissions.allow) && !created) {
    return { path: file, action: 'unchanged' };
  }
  writeJsonFile(file, settings);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * Strip the marker-delimited CodeGraph block from QWEN.md if a prior
 * install wrote one. Used by both install (self-heal on upgrade) and
 * uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const qwenTarget: AgentTarget = new QwenTarget();
