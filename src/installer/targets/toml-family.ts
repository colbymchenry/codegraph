/**
 * toml family target factory: agents shaped like Codex and Grok Build, with
 * an `[mcp_servers.codegraph]` table in a `config.toml`.
 *
 * The factory turns a spec into a complete target, built on `./toml.ts`, so
 * a target it makes handles the file the way Codex and Grok do: the table is
 * found however it is written, never defined twice, and a parent that rules
 * it out stops the install with nothing changed (#2562). A table already
 * there is the user's, as it is for Grok: a reinstall or refresh leaves it as
 * written, and uninstall takes it out, or says so where it can't be edited.
 *
 * What a spec chooses: where the config dir is, for each platform if need
 * be, with an environment variable that overrides it the way `GROK_HOME`
 * does; the file's name; the project local config dir, if the agent reads
 * one; the instructions file that gets the CodeGraph block, such as Codex's
 * `AGENTS.md` or Grok's `rules/codegraph.md`, or none; and notes to show
 * after a successful install.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, TargetId, WriteResult } from './types';
import {
  configDirFromEnv,
  getMcpServerConfig,
  removeInstructionsEntry,
  upsertInstructionsEntry,
} from './shared';
import { buildTomlTable, deleteTomlTable, tomlDefinesTable, writeTomlTable } from './toml';
import { resolveSpecDir, type ResolvedDir, type SpecDir } from './spec-paths';

const TOML_HEADER = 'mcp_servers.codegraph';

export interface TomlFamilySpec {
  id: TargetId;
  displayName: string;
  docsUrl?: string;
  /** The global config dir: a string, or one for each platform. */
  configDir: SpecDir;
  /** An environment variable that names the global config dir when set, such as `GROK_HOME`. */
  homeEnvVar?: string;
  /** The config file's name. Default `config.toml`. */
  configFileName?: string;
  /** The project local config dir, relative to the project. Absent: the target is global only. */
  localConfigDir?: string;
  /** The instructions file, relative to the config dir. Default `AGENTS.md`. `null` writes none. */
  instructionsFile?: string | null;
  /** Where the instructions file goes for a local install: the project root, or the local config dir. Default `project`. */
  instructionsLocal?: 'project' | 'config';
  /** Shown after a successful install, one line each. */
  notes?: string[];
}

function buildCodegraphBlock(): string {
  const { command, args } = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, { command, args });
}

export function createTomlFamilyTarget(spec: TomlFamilySpec): AgentTarget {
  const configFileName = spec.configFileName ?? 'config.toml';

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

  function configFile(dir: string): string {
    return path.join(dir, configFileName);
  }

  function instructionsFile(loc: Location, dir: string): string | null {
    if (spec.instructionsFile === null) return null;
    const name = spec.instructionsFile ?? 'AGENTS.md';
    if (loc === 'global') return path.join(dir, name);
    return (spec.instructionsLocal ?? 'project') === 'project' ? path.join(process.cwd(), name) : path.join(dir, name);
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
      const file = configFile(dir);
      let alreadyConfigured = false;
      try {
        alreadyConfigured = tomlDefinesTable(fs.readFileSync(file, 'utf-8'), TOML_HEADER);
      } catch { /* no config yet */ }
      return { installed: fs.existsSync(dir), alreadyConfigured, configPath: file };
    },

    install(loc: Location, _opts: InstallOptions): WriteResult {
      if (!supportsLocation(loc)) {
        return { files: [], notes: [`${spec.displayName} has no project local config. Run this again with --location=global.`] };
      }
      const { dir, reason } = dirFor(loc);
      if (!dir) return { files: [], notes: [unlocated(reason ?? 'unknown')] };
      const mcp = writeTomlTable(configFile(dir), TOML_HEADER, buildCodegraphBlock(), { keepExisting: true });
      const files = [mcp.file];
      const instructions = instructionsFile(loc, dir);
      if (instructions) files.push(upsertInstructionsEntry(instructions));
      const notes = [...(mcp.note ? [mcp.note] : []), ...(spec.notes ?? [])];
      return notes.length > 0 ? { files, notes } : { files };
    },

    uninstall(loc: Location): WriteResult {
      if (!supportsLocation(loc)) return { files: [] };
      const { dir } = dirFor(loc);
      if (!dir) return { files: [] };
      const mcp = deleteTomlTable(configFile(dir), TOML_HEADER);
      const files = [mcp.file];
      const instructions = instructionsFile(loc, dir);
      if (instructions) files.push(removeInstructionsEntry(instructions));
      return mcp.note ? { files, notes: [mcp.note] } : { files };
    },

    printConfig(loc: Location): string {
      if (!supportsLocation(loc)) return `# ${spec.displayName} has no project local config. Use --location=global.\n`;
      const { dir, reason } = dirFor(loc);
      if (!dir) return `# ${unlocated(reason ?? 'unknown')}\n`;
      return `# Add to ${configFile(dir)}\n\n${buildCodegraphBlock()}\n`;
    },

    describePaths(loc: Location): string[] {
      if (!supportsLocation(loc)) return [];
      const { dir } = dirFor(loc);
      if (!dir) return [];
      const instructions = instructionsFile(loc, dir);
      return instructions ? [configFile(dir), instructions] : [configFile(dir)];
    },
  };
}
