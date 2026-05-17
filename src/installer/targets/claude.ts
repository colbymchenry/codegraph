/**
 * Claude Code target — the historical default. Writes:
 *
 *   - MCP server entry to `~/.claude.json` (global) or
 *     `./.claude.json` (local).
 *   - Permissions to `~/.claude/settings.json` (global) or
 *     `./.claude/settings.json` (local), gated on `autoAllow`.
 *   - Instructions to `~/.claude/CLAUDE.md` (global) or
 *     `./.claude/CLAUDE.md` (local).
 *
 * All paths and shapes ported verbatim from the original
 * `config-writer.ts` so existing Claude Code installs upgrade in
 * place — no migration on disk required.
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
  atomicWriteFileSync,
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
  INSTRUCTIONS_TEMPLATE,
} from '../instructions-template';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.claude')
    : path.join(process.cwd(), '.claude');
}
function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.claude.json')
    : path.join(process.cwd(), '.claude.json');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'CLAUDE.md');
}

class ClaudeCodeTarget implements AgentTarget {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly docsUrl = 'https://docs.claude.com/en/docs/claude-code';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // For "installed" we infer from the existence of either the dir
    // (global) or the project marker file (local). Cheap and avoids
    // shelling out to `claude --version`.
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

    // 3. CLAUDE.md instructions
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

    // 3. Instructions
    const instr = instructionsPath(loc);
    const action = removeMarkedSection(instr, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    files.push({ path: instr, action });

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

/**
 * Per-file write helpers, exported so the legacy `config-writer.ts`
 * shim can call only the named operation (writeMcpConfig writes ONLY
 * the MCP entry, etc.) instead of `claudeTarget.install()` which
 * writes all three files. Without this split the shims silently
 * cause side effects callers don't expect.
 */
export function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    // Already exactly what we'd write — preserve byte-identical file.
    return { path: file, action: 'unchanged' };
  }
  // 'created' here means: the file itself did not exist before this
  // write. A pre-existing `.claude.json` containing other MCP servers
  // (no `codegraph` key) is 'updated', not 'created' — we're adding
  // an entry to a file that was already there. Codex uses a different
  // idiom (empty-content => 'created') because its config.toml is
  // ours alone to manage.
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

export function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  // Ensure config dir exists (for global ~/.claude/).
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Honor the legacy "unmarked ## CodeGraph" rewrite path that the
  // original installer supported (some users hand-pasted a section
  // before markers existed). Detect first and migrate inline.
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    if (!content.includes(CODEGRAPH_SECTION_START)) {
      const headerMatch = content.match(/\n## CodeGraph\n/);
      if (headerMatch && headerMatch.index !== undefined) {
        const sectionStart = headerMatch.index;
        const after = content.substring(sectionStart + 1);
        const nextHeader = after.match(/\n## (?!#)/);
        const sectionEnd = nextHeader && nextHeader.index !== undefined
          ? sectionStart + 1 + nextHeader.index
          : content.length;
        const merged =
          content.substring(0, sectionStart) +
          '\n' + INSTRUCTIONS_TEMPLATE +
          content.substring(sectionEnd);
        atomicWriteFileSync(file, merged);
        return { path: file, action: 'updated' };
      }
    }
  }

  const action = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  // Map the four-state action to WriteResult's action vocabulary.
  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created'
      : action === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
}

export const claudeTarget: AgentTarget = new ClaudeCodeTarget();
