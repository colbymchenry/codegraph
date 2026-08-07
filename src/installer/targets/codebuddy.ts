/**
 * CodeBuddy target. Writes:
 *
 *   - MCP server entry to `~/.codebuddy/.mcp.json` (global = user scope,
 *     loads in every project) or `./.mcp.json` (local = project scope).
 *   - Permissions to `~/.codebuddy/settings.json` (global) or
 *     `./.codebuddy/settings.json` (local), gated on `autoAllow`.
 *   - Instructions to `~/.codebuddy/CODEBUDDY.md` (global) or
 *     `./.codebuddy/CODEBUDDY.md` (local).
 *
 * CodeBuddy follows the same config layout as Claude Code, with
 * `.codebuddy` replacing `.claude` and `CODEBUDDY.md` replacing
 * `CLAUDE.md`. The global MCP config lives inside `~/.codebuddy/`
 * (not as a top-level dotfile).
 *
 * NOTE — why CODEBUDDY.md is still written (unlike Claude Code):
 * CodeBuddy Code does not surface the MCP `initialize` response's
 * `instructions` field to the model. Claude Code / Codex / Gemini /
 * Cursor all receive the SERVER_INSTRUCTIONS playbook automatically
 * via that field (issue #529 removed the MD writes for those targets).
 * Until CodeBuddy supports `initialize` instructions natively, we must
 * keep writing to CODEBUDDY.md — when that support lands, apply the
 * same #529 migration pattern: drop `writeInstructionsEntry` from
 * `install()` and add a self-healing `removeInstructionsEntry` cleanup.
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
  getCodeGraphPermissions,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import { SERVER_INSTRUCTIONS } from '../../mcp/server-instructions';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.codebuddy')
    : path.join(process.cwd(), '.codebuddy');
}
function mcpJsonPath(loc: Location): string {
  // global → ~/.codebuddy/.mcp.json (user scope: visible in every project).
  // local  → ./.mcp.json (project scope).
  return loc === 'global'
    ? path.join(os.homedir(), '.codebuddy', '.mcp.json')
    : path.join(process.cwd(), '.mcp.json');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'CODEBUDDY.md');
}

class CodeBuddyTarget implements AgentTarget {
  readonly id = 'codebuddy' as const;
  readonly displayName = 'CodeBuddy';
  readonly docsUrl = 'https://cnb.cool/codebuddy/codebuddy-code';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(configDir(loc)) || fs.existsSync(mcpPath)
      : fs.existsSync(mcpPath) || fs.existsSync(configDir(loc));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    files.push(writeMcpEntry(loc));

    // 2. Permissions (only when autoAllow)
    if (opts.autoAllow) {
      files.push(writePermissionsEntry(loc));
    }

    // 3. CODEBUDDY.md instructions
    //
    // CodeBuddy Code does NOT surface the MCP `initialize` response's
    // `instructions` field to the model, so the technique used for
    // Claude Code / Codex / Gemini / Cursor (issue #529) does not work
    // here. Those agents receive SERVER_INSTRUCTIONS automatically on
    // every session via the MCP handshake; CodeBuddy silently discards
    // that field today.
    //
    // As a result we must write the SERVER_INSTRUCTIONS playbook directly
    // into CODEBUDDY.md so the agent knows to prefer codegraph tools over
    // grep/find/Read exploration.
    //
    // If CodeBuddy adds first-class support for the MCP `initialize`
    // instructions field in the future, this target should be updated to
    // drop the CODEBUDDY.md write (and add a self-healing cleanup step,
    // the same pattern used in the #529 migration for the other targets).
    files.push(writeInstructionsEntry(loc));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 2. Permissions
    const settingsPath = settingsJsonPath(loc);
    const settings = readJsonFile(settingsPath);
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
        writeJsonFile(settingsPath, settings);
        files.push({ path: settingsPath, action: 'removed' });
      } else {
        files.push({ path: settingsPath, action: 'not-found' });
      }
    } else {
      files.push({ path: settingsPath, action: 'not-found' });
    }

    // 3. Instructions — strip the legacy CodeGraph block if present.
    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), settingsJsonPath(loc), instructionsPath(loc)];
  }
}

export function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

export function writePermissionsEntry(loc: Location): WriteResult['files'][number] {
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

function codeGraphInstructionsBody(): string {
  return (
    CODEGRAPH_SECTION_START + '\n' +
    SERVER_INSTRUCTIONS + '\n' +
    CODEGRAPH_SECTION_END
  );
}

export function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const body = codeGraphInstructionsBody();
  const raw = replaceOrAppendMarkedSection(file, body, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  // `appended` means the markers weren't found and the section was added
  // at the end — map it to `updated` for the installer log line.
  const action: WriteResult['files'][number]['action'] =
    raw === 'appended' ? 'updated' : raw;
  return { path: file, action };
}

export function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const codebuddyTarget: AgentTarget = new CodeBuddyTarget();
