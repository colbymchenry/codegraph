/**
 * jcode target (https://jcode.sh).
 *
 *   - MCP server entry to `~/.jcode/mcp.json` (global) or `./.jcode/mcp.json`
 *     (project-local). jcode reads both the canonical `mcpServers` key and the
 *     historical `servers` key, but we write `mcpServers` for clarity.
 *   - Instructions to `~/AGENTS.md` (global) or `./AGENTS.md` (project-local).
 *     jcode loads `AGENTS.md` at the repo root as project instructions and
 *     `~/AGENTS.md` as global agent instructions, both on every turn.
 *   - A jcode skill to `~/.jcode/skills/codegraph/SKILL.md` (global only). The
 *     skill auto-injects when the conversation is about code structure,
 *     impact, refactoring, or debugging — so the full playbook is only paid for
 *     when it is relevant.
 *
 * jcode supports stdio MCP servers only; CodeGraph is already stdio-based, so no
 * `type` field is written in the MCP entry (the docs example omits it).
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
  replaceOrAppendMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
  JCODE_CODEGRAPH_INSTRUCTIONS_BLOCK,
} from '../instructions-template';

const SKILL_SECTION_START = '<!-- CODEGRAPH_SKILL_START -->';
const SKILL_SECTION_END = '<!-- CODEGRAPH_SKILL_END -->';

const SKILL_BODY = `${SKILL_SECTION_START}
# CodeGraph skill

Use when the user asks about code structure, impact, callers/callees, symbol search, refactoring, debugging, or finding tests for a change.

## One-shot exploration
- Prefer \`codegraph_explore <query>\` over chains of \`grep\` + \`read\`. It returns ranked symbols, source snippets, and call paths in one response.
- Use \`maxFiles\` to keep the response bounded.

## Before modifying code
1. Run \`codegraph impact <symbol>\` to see affected callers and files.
2. Run \`codegraph affected <files...>\` to find tests to update or run.
3. After the change, use \`codegraph status\` to confirm the index is fresh.

## Navigation
- \`codegraph_node <symbol>\` — source, callers, and callees for one symbol.
- \`codegraph_callers <symbol>\` / \`codegraph_callees <symbol>\` — focused traversal.
- \`codegraph_status\` — check index freshness and last indexed time.

## Avoid
- Do not re-read a file just to get line numbers when \`codegraph_explore\` or \`codegraph_node\` already returned the source.
- Do not run a full \`codegraph index\` unless the index is missing or the user explicitly asks; prefer \`codegraph sync\` for incremental updates.
${SKILL_SECTION_END}`;

function globalConfigDir(): string {
  return path.join(os.homedir(), '.jcode');
}

function localConfigDir(): string {
  return path.join(process.cwd(), '.jcode');
}

function configDir(loc: Location): string {
  return loc === 'global' ? globalConfigDir() : localConfigDir();
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function instructionsPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

function skillDir(): string {
  return path.join(globalConfigDir(), 'skills', 'codegraph');
}

function skillPath(): string {
  return path.join(skillDir(), 'SKILL.md');
}

class JcodeTarget implements AgentTarget {
  readonly id = 'jcode' as const;
  readonly displayName = 'jcode';
  readonly docsUrl = 'https://jcode.sh/docs/config';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph || !!config.servers?.codegraph;
    const dir = configDir(loc);
    const installed = loc === 'global'
      ? fs.existsSync(dir) || fs.existsSync(mcpPath)
      : fs.existsSync(dir) || fs.existsSync(mcpPath);
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));
    files.push(upsertInstructionsEntry(loc));

    if (loc === 'global') {
      files.push(upsertSkillEntry());
    }

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.codegraph || config.servers?.codegraph) {
      if (config.mcpServers?.codegraph) delete config.mcpServers.codegraph;
      if (config.mcpServers && Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      if (config.servers?.codegraph) delete config.servers.codegraph;
      if (config.servers && Object.keys(config.servers).length === 0) {
        delete config.servers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    files.push(removeInstructionsEntry(loc));

    if (loc === 'global') {
      files.push(removeSkillEntry());
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getJcodeServerEntry() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [mcpJsonPath(loc), instructionsPath(loc)];
    if (loc === 'global') {
      paths.push(skillPath());
    }
    return paths;
  }
}

function getJcodeServerEntry(): { command: string; args: string[] } {
  return {
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getJcodeServerEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  // Drop any stale historical `servers` entry so the config is unambiguous.
  if (existing.servers?.codegraph) delete existing.servers.codegraph;
  if (existing.servers && Object.keys(existing.servers).length === 0) {
    delete existing.servers;
  }

  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  writeJsonFile(file, existing);
  return { path: file, action };
}

function upsertInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = replaceOrAppendMarkedSection(
    file,
    JCODE_CODEGRAPH_INSTRUCTIONS_BLOCK,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  return { path: file, action: action === 'appended' ? 'updated' : action };
}

function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

function upsertSkillEntry(): WriteResult['files'][number] {
  const file = skillPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const action = replaceOrAppendMarkedSection(
    file,
    SKILL_BODY,
    SKILL_SECTION_START,
    SKILL_SECTION_END,
  );
  return { path: file, action: action === 'appended' ? 'updated' : action };
}

function removeSkillEntry(): WriteResult['files'][number] {
  const file = skillPath();
  const action = removeMarkedSection(file, SKILL_SECTION_START, SKILL_SECTION_END);
  return { path: file, action };
}

export const jcodeTarget: AgentTarget = new JcodeTarget();
