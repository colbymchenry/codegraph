/**
 * Grok Build target (xAI's CLI coding agent).
 *
 *   - MCP server entry to `$GROK_HOME/config.toml` (global, default
 *     `~/.grok/config.toml`) or `.grok/config.toml` (local) as the
 *     dotted-key table `[mcp_servers.codegraph]`. TOML — handled by
 *     the narrow serializer in `./toml.ts`.
 *   - Instructions to `AGENTS.md` in the global config dir (global) or
 *     project root (local).
 *
 * Supports both global and local install locations — unlike Codex CLI,
 * Grok Build reads a project-local `.grok/config.toml` when present.
 *
 * No permissions concept.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
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

/** Global Grok config directory — respects $GROK_HOME override. */
function grokConfigDir(): string {
  const home = process.env.GROK_HOME;
  if (home && home.trim().length > 0) {
    return home;
  }
  return path.join(os.homedir(), '.grok');
}

/** Base config dir for the given location. */
function configBaseDir(loc: Location): string {
  return loc === 'global'
    ? grokConfigDir()
    : path.join(process.cwd(), '.grok');
}

function tomlConfigPath(loc: Location): string {
  return path.join(configBaseDir(loc), 'config.toml');
}

function instructionsPath(loc: Location): string {
  if (loc === 'global') {
    return path.join(grokConfigDir(), 'AGENTS.md');
  }
  return path.join(process.cwd(), 'AGENTS.md');
}

/** Best-effort check whether the `grok` binary is on PATH. */
function grokBinaryExists(): boolean {
  try {
    execSync(
      process.platform === 'win32' ? 'where grok' : 'command -v grok',
      { stdio: 'ignore', encoding: 'utf-8' },
    );
    return true;
  } catch {
    return false;
  }
}

class GrokTarget implements AgentTarget {
  readonly id = 'grok' as const;
  readonly displayName = 'Grok Build';
  readonly docsUrl = 'https://docs.x.ai/build/settings';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = tomlConfigPath(loc);
    let alreadyConfigured = false;
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch { /* ignore */ }
    }
    const installed = grokBinaryExists() || fs.existsSync(configBaseDir(loc));
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
    files.push(removeMcpEntry(loc));
    files.push(removeInstructionsEntry(loc));
    return { files };
  }

  printConfig(loc: Location): string {
    const block = buildCodegraphBlock();
    return `# Add to ${tomlConfigPath(loc)}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    return [tomlConfigPath(loc), instructionsPath(loc)];
  }
}

function buildCodegraphBlock(): string {
  const mcp = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = tomlConfigPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const block = buildCodegraphBlock();
  // Single read — `existing === ''` derives both "is the file empty
  // or absent" and "what was its content," avoiding a TOCTOU window
  // between two `fs.existsSync` calls.
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const created = existing.length === 0;
  const { content: nextContent, action } = upsertTomlTable(existing, TOML_HEADER, block);

  if (action === 'unchanged') {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, nextContent);
  return { path: file, action: created ? 'created' : 'updated' };
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = tomlConfigPath(loc);
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
    if (action === 'removed') {
      if (nextContent.trim() === '') {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
      } else {
        atomicWriteFileSync(file, nextContent.trimEnd() + '\n');
      }
      return { path: file, action: 'removed' };
    }
    return { path: file, action: 'not-found' };
  }
  return { path: file, action: 'not-found' };
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

export const grokTarget: AgentTarget = new GrokTarget();
