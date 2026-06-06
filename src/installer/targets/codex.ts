/**
 * OpenAI Codex CLI target.
 *
 *   - MCP server entry to `~/.codex/config.toml` as the dotted-key
 *     table `[mcp_servers.codegraph]`. TOML — not JSON — handled by
 *     the narrow serializer in `./toml.ts`.
 *   - Instructions to `~/.codex/AGENTS.md`.
 *
 * Codex CLI as of 2026-05 has no project-local config concept —
 * everything lives under `~/.codex/`. `supportsLocation('local')`
 * returns false; the orchestrator skips Codex when the user picks
 * the local install location.
 *
 * No permissions concept.
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
  getMcpServerConfig,
  removeMarkedSection,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml';

const TOML_HEADER = 'mcp_servers.codegraph';

function configDir(): string {
  return path.join(os.homedir(), '.codex');
}
function tomlConfigPath(): string {
  return path.join(configDir(), 'config.toml');
}
function instructionsPath(): string {
  return path.join(configDir(), 'AGENTS.md');
}

class CodexTarget implements AgentTarget {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly docsUrl = 'https://github.com/openai/codex';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const tomlPath = tomlConfigPath();
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch { /* ignore */ }
    }
    const installed = fs.existsSync(configDir());
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Codex CLI has no project-local config — re-run with --location=global to install.'],
      };
    }
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry());

    // AGENTS.md is no longer written — the codegraph usage guidance
    // ships in the MCP server's `initialize` response (issue #529).
    // Strip a block a previous install left so an upgrade self-heals.
    const instrCleanup = removeInstructionsEntry();
    if (instrCleanup.action === 'removed') files.push(instrCleanup);

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];

    const tomlPath = tomlConfigPath();
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
      if (action === 'removed') {
        if (nextContent.trim() === '') {
          try { fs.unlinkSync(tomlPath); } catch { /* ignore */ }
        } else {
          atomicWriteFileSync(tomlPath, nextContent.trimEnd() + '\n');
        }
        files.push({ path: tomlPath, action: 'removed' });
      } else {
        files.push({ path: tomlPath, action: 'not-found' });
      }
    } else {
      files.push({ path: tomlPath, action: 'not-found' });
    }

    files.push(removeInstructionsEntry());

    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Codex CLI has no project-local config — use --location=global.\n';
    }
    const block = buildCodegraphBlock();
    return `# Add to ${tomlConfigPath()}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [tomlConfigPath(), instructionsPath()];
  }
}

function buildCodegraphBlock(): string {
  const mcp = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = tomlConfigPath();
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

/**
 * Strip the marker-delimited CodeGraph block from `~/.codex/AGENTS.md`
 * if a prior install wrote one. Used by both install (self-heal on
 * upgrade) and uninstall — see issue #529.
 */
function removeInstructionsEntry(): WriteResult['files'][number] {
  const file = instructionsPath();
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const codexTarget: AgentTarget = new CodexTarget();
