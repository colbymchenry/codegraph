/**
 * Grok (Grok Build TUI / `grok` CLI) target.
 *
 *   - MCP server entry to `config.toml` as the dotted-key table
 *     `[mcp_servers.codegraph]`. Same TOML serializer as Codex
 *     (`./toml.ts`).
 *   - Instructions to `$GROK_HOME/rules/codegraph.md` (global) or
 *     `<cwd>/.grok/rules/codegraph.md` (local). Grok always scans
 *     `rules/*.md` at those locations; it does not load a home-level
 *     `AGENTS.md` the way Codex does.
 *
 * Both locations are supported:
 *   - global: `$GROK_HOME/config.toml` (default `~/.grok/config.toml`)
 *   - local:  `<cwd>/.grok/config.toml`
 *
 * Project-scoped files contribute `[mcp_servers]` (and `[permission]`,
 * `[plugins]`). Repo-local MCP servers are gated on folder trust — the
 * same store as project hooks (`~/.grok/trusted_folders.toml`) — so a
 * local install is surfaced with a trust note rather than silent
 * success.
 *
 * Honors `$GROK_HOME` (default `~/.grok`).
 *
 * No installer-written permissions: Grok's `[permission]` table is
 * user-owned (sibling allow/deny rules), and MCP tools can be
 * always-allowed from the first prompt. `autoAllow` is ignored.
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
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml';

const TOML_HEADER = 'mcp_servers.codegraph';

function grokHome(): string {
  return process.env.GROK_HOME
    ? path.resolve(process.env.GROK_HOME)
    : path.join(os.homedir(), '.grok');
}

function configDir(loc: Location): string {
  return loc === 'global' ? grokHome() : path.join(process.cwd(), '.grok');
}

function tomlConfigPath(loc: Location): string {
  return path.join(configDir(loc), 'config.toml');
}

function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'rules', 'codegraph.md');
}

/**
 * Repo-local MCP is skipped until the folder is trusted (same gate as
 * project hooks). Say so rather than reporting silent success.
 */
function trustNote(): string {
  return `Grok applies ${tomlConfigPath('local')} only in a trusted project — untrusted folders skip repo-local MCP servers. Trust this project in Grok to activate it.`;
}

class GrokTarget implements AgentTarget {
  readonly id = 'grok' as const;
  readonly displayName = 'Grok';
  readonly docsUrl = 'https://docs.x.ai/build/features/mcp-servers';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const tomlPath = tomlConfigPath(loc);
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch { /* ignore */ }
    }
    // Global: ~/.grok (or $GROK_HOME) existing means Grok has run here.
    // Local: the project only counts as "Grok-enabled" once it actually
    // has a .grok/ dir or config file of its own.
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(tomlPath);
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));

    // rules/codegraph.md gets the short marker-fenced CodeGraph block
    // (#704): subagents and non-MCP harnesses read project rules but
    // never the MCP initialize instructions. Upsert self-heals a
    // stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    const notes = [
      'Start a new Grok session (or press r in /mcps) for MCP changes to take effect.',
    ];
    if (loc === 'local') notes.push(trustNote());
    return { files, notes };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const tomlPath = tomlConfigPath(loc);
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

/**
 * Strip the marker-delimited CodeGraph block from this location's
 * rules/codegraph.md if a prior install wrote one.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const grokTarget: AgentTarget = new GrokTarget();
