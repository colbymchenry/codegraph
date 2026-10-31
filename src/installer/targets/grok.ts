/**
 * Grok Build target (the `grok` CLI).
 *
 *   - MCP server entry as the `[mcp_servers.codegraph]` table of `config.toml`:
 *     `$GROK_HOME` (default `~/.grok`) when global, `./.grok` when local.
 *     Written with the same helpers as Codex (`./toml.ts`), so a table in any
 *     other form or a parent that rules it out is never defined twice (#2562).
 *   - Instructions to `rules/codegraph.md` in the same folder. Grok loads every
 *     `*.md` in `$GROK_HOME/rules/` for all projects, and every `*.md` in a
 *     project's `.grok/rules/`.
 *
 * A table already there is the user's. `grok mcp disable` writes `enabled` into
 * it, and users add `env` or timeouts, so a refresh leaves it alone.
 *
 * A project's config applies only once the folder is trusted, so a local
 * install says so. `autoAllow` is a no-op: Grok's `[permission]` rules are the
 * user's own.
 *
 * Docs: https://docs.x.ai/build/features/mcp-servers
 *       https://docs.x.ai/build/features/project-rules
 *       https://docs.x.ai/build/features/hooks (folder trust)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import {
  configDirFromEnv,
  getMcpServerConfig,
  removeInstructionsEntry,
  upsertInstructionsEntry,
} from './shared';
import { buildTomlTable, deleteTomlTable, tomlDefinesTable, writeTomlTable } from './toml';

const TOML_HEADER = 'mcp_servers.codegraph';

function configDir(loc: Location): string {
  return loc === 'global'
    ? configDirFromEnv('GROK_HOME', path.join(os.homedir(), '.grok'))
    : path.join(process.cwd(), '.grok');
}

function tomlConfigPath(loc: Location): string {
  return path.join(configDir(loc), 'config.toml');
}

function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'rules', 'codegraph.md');
}

function buildCodegraphBlock(): string {
  const { command, args } = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, { command, args });
}

class GrokTarget implements AgentTarget {
  readonly id = 'grok' as const;
  readonly displayName = 'Grok Build';
  readonly docsUrl = 'https://docs.x.ai/build/features/mcp-servers';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = tomlConfigPath(loc);
    let alreadyConfigured = false;
    try {
      alreadyConfigured = tomlDefinesTable(fs.readFileSync(file, 'utf-8'), TOML_HEADER);
    } catch { /* no config yet */ }
    return { installed: fs.existsSync(configDir(loc)), alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const mcp = writeTomlTable(tomlConfigPath(loc), TOML_HEADER, buildCodegraphBlock(), { keepExisting: true });
    const notes = ['Start a new Grok session, or press r in /mcps, to pick up the MCP server.'];
    if (mcp.note) notes.unshift(mcp.note);
    if (loc === 'local') notes.push(`Grok applies ${tomlConfigPath('local')} only in a trusted folder: run /hooks-trust there, or start grok with --trust.`);
    return { files: [mcp.file, upsertInstructionsEntry(instructionsPath(loc))], notes };
  }

  uninstall(loc: Location): WriteResult {
    const mcp = deleteTomlTable(tomlConfigPath(loc), TOML_HEADER);
    const files = [mcp.file, removeInstructionsEntry(instructionsPath(loc))];
    return mcp.note ? { files, notes: [mcp.note] } : { files };
  }

  printConfig(loc: Location): string {
    return `# Add to ${tomlConfigPath(loc)}\n\n${buildCodegraphBlock()}\n`;
  }

  describePaths(loc: Location): string[] {
    return [tomlConfigPath(loc), instructionsPath(loc)];
  }
}

export const grokTarget: AgentTarget = new GrokTarget();
