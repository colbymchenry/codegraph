/**
 * mcp-json family target factory: agents that keep their MCP servers as a
 * map of `<name>: { command, args }` objects in a JSON file. That is the
 * shape of `mcpServers` in Claude Code, Cursor and the seven agents that
 * share `./json-config.ts`, of `servers` in VS Code's `mcp.json`, of
 * `mcp.servers` in ZCode and of `context_servers` in Zed.
 *
 * The factory turns a spec into a complete target, built on the same helpers
 * the builtin JSON targets use, so a target it makes keeps their promises:
 * the file is edited in place and keeps its comments, indent, line breaks
 * and byte order mark; an entry already there is the user's and only gains a
 * key it is missing; a file that can't be parsed is backed up before it is
 * replaced; uninstall takes out only what install wrote, deletes a file left
 * with nothing in it, and writes through a symbolic link instead of
 * replacing it.
 *
 * What a spec chooses:
 *   - where the file is, for each platform if need be, with an environment
 *     variable that overrides it the way `QWEN_HOME` does for Qwen Code;
 *   - the file's name, and a different one for the project local file when
 *     the agent uses one, as the Qoder CLI does;
 *   - the keys that lead to the servers map;
 *   - the instructions file that gets the CodeGraph block, or none;
 *   - whether the entry carries `type: "stdio"`, which Windsurf and Devin
 *     refuse, and whether `command` is the binary's absolute path, for an app
 *     launched from the Dock on macOS whose PATH never saw nvm;
 *   - notes to show after a successful install.
 *
 * A spec never says what the entry contains beyond those two switches.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, TargetId, WriteResult } from './types';
import {
  hasCodegraphServer,
  removeCodegraphServer,
  upsertCodegraphServer,
  type ServersPath,
} from './json-config';
import {
  configDirFromEnv,
  getMcpServerConfig,
  getStdioServerConfig,
  removeInstructionsEntry,
  resolveCodegraphCommand,
  upsertInstructionsEntry,
} from './shared';
import { resolveSpecDir, type ResolvedDir, type SpecDir } from './spec-paths';

export interface McpJsonFamilySpec {
  id: TargetId;
  displayName: string;
  docsUrl?: string;
  /** The global config dir: a string, or one for each platform. */
  configDir: SpecDir;
  /** An environment variable that names the global config dir when set, such as `QWEN_HOME`. */
  homeEnvVar?: string;
  /** The config file's name. Default `settings.json`. */
  configFileName?: string;
  /** The project local config dir, relative to the project. Absent: the target is global only. */
  localConfigDir?: string;
  /** The project local file's name, when it differs. Default: `configFileName`. */
  localConfigFileName?: string;
  /** The keys that lead to the servers map, joined by dots. Default `mcpServers`. */
  serversKey?: string;
  /** The instructions file, relative to the config dir. Default `AGENTS.md`. `null` writes none. */
  instructionsFile?: string | null;
  /** Where the instructions file goes for a local install: the project root, or the local config dir. Default `project`. */
  instructionsLocal?: 'project' | 'config';
  /** Write `{ command, args }` with no `type` key. */
  omitTypeField?: boolean;
  /** Write the binary's resolved absolute path as `command` on macOS. */
  absoluteCommand?: boolean;
  /** Shown after a successful install, one line each. */
  notes?: string[];
}

/** `{ a: { b: value } }` for the path `a.b`. */
export function nestUnder(keys: ServersPath, value: unknown): Record<string, unknown> {
  return keys.reduceRight<Record<string, unknown>>((inner, key) => ({ [key]: inner }), value as Record<string, unknown>);
}

export function createMcpJsonFamilyTarget(spec: McpJsonFamilySpec): AgentTarget {
  const serversPath: ServersPath = (spec.serversKey ?? 'mcpServers').split('.');
  const configFileName = spec.configFileName ?? 'settings.json';
  const localConfigFileName = spec.localConfigFileName ?? configFileName;

  function globalDir(): ResolvedDir {
    if (spec.homeEnvVar && process.env[spec.homeEnvVar]?.trim()) {
      return { dir: configDirFromEnv(spec.homeEnvVar, '') };
    }
    return resolveSpecDir(spec.configDir);
  }

  function dirFor(loc: Location): ResolvedDir {
    if (loc === 'global') return globalDir();
    if (!spec.localConfigDir) return { dir: null, reason: 'no project local config' };
    return { dir: path.join(process.cwd(), spec.localConfigDir) };
  }

  function configFile(loc: Location, dir: string): string {
    return path.join(dir, loc === 'global' ? configFileName : localConfigFileName);
  }

  function instructionsFile(loc: Location, dir: string): string | null {
    if (spec.instructionsFile === null) return null;
    const name = spec.instructionsFile ?? 'AGENTS.md';
    if (loc === 'global') return path.join(dir, name);
    return (spec.instructionsLocal ?? 'project') === 'project' ? path.join(process.cwd(), name) : path.join(dir, name);
  }

  function buildEntry(): Record<string, unknown> {
    const base = spec.omitTypeField ? getStdioServerConfig() : getMcpServerConfig();
    return spec.absoluteCommand ? { ...base, command: resolveCodegraphCommand() } : base;
  }

  function supportsLocation(loc: Location): boolean {
    return loc === 'global' || !!spec.localConfigDir;
  }

  function unlocated(reason: string): string {
    return `${spec.displayName}: cannot locate its config dir (${reason}). Nothing was written.`;
  }

  return {
    id: spec.id,
    displayName: spec.displayName,
    docsUrl: spec.docsUrl,
    supportsLocation,

    detect(loc: Location): DetectionResult {
      const { dir } = supportsLocation(loc) ? dirFor(loc) : { dir: null };
      if (!dir) return { installed: false, alreadyConfigured: false };
      const file = configFile(loc, dir);
      return {
        installed: fs.existsSync(dir),
        alreadyConfigured: hasCodegraphServer(file, serversPath),
        configPath: file,
      };
    },

    install(loc: Location, _opts: InstallOptions): WriteResult {
      if (!supportsLocation(loc)) {
        return { files: [], notes: [`${spec.displayName} has no project local config. Run this again with --location=global.`] };
      }
      const { dir, reason } = dirFor(loc);
      if (!dir) return { files: [], notes: [unlocated(reason ?? 'unknown')] };
      const files = [upsertCodegraphServer(configFile(loc, dir), buildEntry(), undefined, serversPath)];
      const instructions = instructionsFile(loc, dir);
      if (instructions) files.push(upsertInstructionsEntry(instructions));
      const notes = spec.notes ?? [];
      return notes.length > 0 ? { files, notes: [...notes] } : { files };
    },

    uninstall(loc: Location): WriteResult {
      if (!supportsLocation(loc)) return { files: [] };
      const { dir } = dirFor(loc);
      if (!dir) return { files: [] };
      const files = [removeCodegraphServer(configFile(loc, dir), undefined, serversPath)];
      const instructions = instructionsFile(loc, dir);
      if (instructions) files.push(removeInstructionsEntry(instructions));
      return { files };
    },

    printConfig(loc: Location): string {
      if (!supportsLocation(loc)) return `# ${spec.displayName} has no project local config. Use --location=global.\n`;
      const { dir, reason } = dirFor(loc);
      if (!dir) return `# ${unlocated(reason ?? 'unknown')}\n`;
      const snippet = JSON.stringify(nestUnder(serversPath, { codegraph: buildEntry() }), null, 2);
      return `# Add to ${configFile(loc, dir)}\n\n${snippet}\n`;
    },

    describePaths(loc: Location): string[] {
      if (!supportsLocation(loc)) return [];
      const { dir } = dirFor(loc);
      if (!dir) return [];
      const instructions = instructionsFile(loc, dir);
      return instructions ? [configFile(loc, dir), instructions] : [configFile(loc, dir)];
    },
  };
}
