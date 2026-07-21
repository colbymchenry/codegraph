/**
 * Grok Build target.
 *
 * Grok Build reads MCP server definitions from
 * `~/.grok/config.toml` (or `$GROK_HOME/config.toml`) and supports a
 * project-local `.grok/config.toml`. Its MCP table format matches the
 * Codex CLI format, so this target shares the narrow TOML helpers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  getMcpServerConfig,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml';

const TOML_HEADER = 'mcp_servers.codegraph';

function configDir(loc: Location): string {
  if (loc === 'local') return path.join(process.cwd(), '.grok');
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

function tomlConfigPath(loc: Location): string {
  return path.join(configDir(loc), 'config.toml');
}

function instructionsPath(): string {
  return path.join(configDir('global'), 'AGENTS.md');
}

class GrokTarget implements AgentTarget {
  readonly id = 'grok' as const;
  readonly displayName = 'Grok Build';
  readonly docsUrl = 'https://x.ai';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = tomlConfigPath(loc);
    let alreadyConfigured = false;
    if (fs.existsSync(file)) {
      try {
        alreadyConfigured = fs.readFileSync(file, 'utf-8').includes(`[${TOML_HEADER}]`);
      } catch { /* best-effort detection */ }
    }
    return {
      installed: fs.existsSync(configDir(loc)),
      alreadyConfigured,
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [writeMcpEntry(loc)];
    // Grok Build loads user-wide AGENTS.md for its non-MCP contexts.
    if (loc === 'global') files.push(upsertInstructionsEntry(instructionsPath()));
    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [removeMcpEntry(loc)];
    if (loc === 'global') {
      files.push(removeInstructionsEntry());
    } else {
      removeEmptyLocalConfigDir();
    }
    return { files };
  }

  printConfig(loc: Location): string {
    return `# Add to ${tomlConfigPath(loc)}\n\n${buildCodegraphBlock()}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'global'
      ? [tomlConfigPath(loc), instructionsPath()]
      : [tomlConfigPath(loc)];
  }
}

function buildCodegraphBlock(): string {
  const mcp = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, { command: mcp.command, args: mcp.args });
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = tomlConfigPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const created = existing.length === 0;
  const { content, action } = upsertTomlTable(existing, TOML_HEADER, buildCodegraphBlock());
  if (action === 'unchanged') return { path: file, action };
  atomicWriteFileSync(file, content);
  return { path: file, action: created ? 'created' : 'updated' };
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = tomlConfigPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  const { content, action } = removeTomlTable(fs.readFileSync(file, 'utf-8'), TOML_HEADER);
  if (action === 'not-found') return { path: file, action };
  if (content.trim() === '') {
    fs.unlinkSync(file);
  } else {
    atomicWriteFileSync(file, content.trimEnd() + '\n');
  }
  return { path: file, action };
}

function removeInstructionsEntry(): WriteResult['files'][number] {
  const file = instructionsPath();
  return { path: file, action: removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END) };
}

function removeEmptyLocalConfigDir(): void {
  const dir = configDir('local');
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* another Grok file or concurrent change: leave it alone */ }
}

export const grokTarget: AgentTarget = new GrokTarget();
