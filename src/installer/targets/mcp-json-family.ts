/**
 * mcp-json-family target factory — agents using the de-facto standard
 * `mcpServers.<name>` JSON object (the Claude / Cursor / Gemini shape).
 *
 * Unlike the opencode and toml families this one is not extracted from
 * a built-in (Claude / Cursor / Gemini each carry target-specific
 * quirks — permissions, `--path` injection, GEMINI.md at the project
 * root — that don't generalize); it's the plain-vanilla shape those
 * targets share, modeled on `./gemini.ts`, for custom targets
 * (`./custom.ts`, family `"mcp-json"`) only:
 *
 *   - MCP server entry to `<configDir>/<configFileName>` (global) or
 *     `./<localConfigDir>/<configFileName>` (local) under
 *     `<serversKey>.codegraph`, standard stdio shape.
 *   - Instructions block to `<instructionsFileName>` next to the global
 *     config, or at the project root for local installs. Optional.
 *   - No permissions concept.
 *
 * Writes go through `readJsonFile`/`writeJsonFile` (backup-on-unparseable,
 * atomic write) — same guarantees as the built-in JSON targets.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  resolveCodegraphCommand,
  writeJsonFile,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import { SpecDir, resolveSpecDir } from './spec-paths';

export interface McpJsonFamilySpec {
  /** Registry id. */
  id: string;
  displayName: string;
  docsUrl?: string;
  /**
   * Global config dir; absolute, `~/`-prefixed, or `${ENV}`-prefixed —
   * or a per-platform map (see `./spec-paths.ts`), for agents whose
   * config lives under `Application Support` / `%APPDATA%` / XDG
   * depending on OS (Qoder IDE, #1277). Validated by `custom.ts` for
   * user specs.
   */
  configDir: SpecDir;
  /**
   * Project-local config dir name (e.g. '.myagent'). Absent = the
   * agent is global-only.
   */
  localConfigDir?: string;
  /** Config file basename. Default 'settings.json'. */
  configFileName?: string;
  /** Top-level key holding the servers map. Default 'mcpServers'. */
  serversKey?: string;
  /**
   * Instructions file basename — written next to the global config, or
   * at the project root for local installs. Default 'AGENTS.md';
   * `null` disables instructions entirely.
   */
  instructionsFileName?: string | null;
  /**
   * Write the codegraph binary's resolved absolute path as `command`
   * instead of the bare name. For GUI apps launched from Dock/Finder
   * on macOS, whose stripped PATH can't find nvm-managed binaries —
   * same treatment the built-in Antigravity target applies
   * (`resolveCodegraphCommand` in `./shared.ts`; a no-op bare name on
   * other platforms and when resolution fails).
   */
  absoluteCommand?: boolean;
}

class McpJsonFamilyTarget implements AgentTarget {
  readonly id: string;
  readonly displayName: string;
  readonly docsUrl?: string;

  constructor(private readonly spec: McpJsonFamilySpec) {
    this.id = spec.id;
    this.displayName = spec.displayName;
    this.docsUrl = spec.docsUrl;
  }

  private serversKey(): string {
    return this.spec.serversKey ?? 'mcpServers';
  }

  private serverEntry(): { type: string; command: string; args: string[] } {
    const entry = getMcpServerConfig();
    if (this.spec.absoluteCommand) entry.command = resolveCodegraphCommand();
    return entry;
  }

  /** `null` when the spec's config dir can't be resolved on this machine. */
  private configDir(loc: Location): string | null {
    return loc === 'global'
      ? resolveSpecDir(this.spec.configDir).dir
      : path.join(process.cwd(), this.spec.localConfigDir!);
  }

  private unavailableNote(): string {
    const { reason } = resolveSpecDir(this.spec.configDir);
    return `Cannot locate ${this.displayName}'s config dir on this machine: ${reason ?? 'unresolvable configDir'}.`;
  }

  private settingsPath(loc: Location): string | null {
    const dir = this.configDir(loc);
    return dir === null ? null : path.join(dir, this.spec.configFileName ?? 'settings.json');
  }

  private instructionsPath(loc: Location): string | null {
    if (this.spec.instructionsFileName === null) return null;
    const name = this.spec.instructionsFileName ?? 'AGENTS.md';
    // Local instructions live at the project root, not inside the
    // config dir — matching how agents' hierarchical context loaders
    // search (same convention as opencode local / Gemini local).
    if (loc === 'global') {
      const dir = this.configDir('global');
      return dir === null ? null : path.join(dir, name);
    }
    return path.join(process.cwd(), name);
  }

  supportsLocation(loc: Location): boolean {
    return loc === 'global' || !!this.spec.localConfigDir;
  }

  detect(loc: Location): DetectionResult {
    if (!this.supportsLocation(loc)) {
      return { installed: false, alreadyConfigured: false };
    }
    const file = this.settingsPath(loc);
    if (file === null) {
      return { installed: false, alreadyConfigured: false };
    }
    const config = readJsonFile(file);
    const alreadyConfigured = !!config[this.serversKey()]?.codegraph;
    const installed = fs.existsSync(this.configDir(loc)!) || fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (!this.supportsLocation(loc)) {
      return {
        files: [],
        notes: [`${this.displayName} has no project-local config — re-run with --location=global to install.`],
      };
    }
    if (this.settingsPath(loc) === null) {
      return { files: [], notes: [this.unavailableNote()] };
    }
    const files: WriteResult['files'] = [];
    files.push(this.writeMcpEntry(loc));

    // Instructions file gets the short marker-fenced CodeGraph block
    // (#704): subagents and non-MCP harnesses read it but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    const instructions = this.instructionsPath(loc);
    if (instructions) files.push(upsertInstructionsEntry(instructions));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    if (!this.supportsLocation(loc)) return { files: [] };
    const file = this.settingsPath(loc);
    if (file === null) {
      return { files: [], notes: [this.unavailableNote()] };
    }
    const files: WriteResult['files'] = [];

    const key = this.serversKey();
    const config = readJsonFile(file);
    if (config[key]?.codegraph) {
      delete config[key].codegraph;
      if (Object.keys(config[key]).length === 0) {
        delete config[key];
      }
      // If the file is now an empty `{}` we still leave it — other
      // top-level settings the user might add later can share the
      // file; deleting it would be surprising.
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    const instructions = this.instructionsPath(loc);
    if (instructions) {
      const action = removeMarkedSection(instructions, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
      files.push({ path: instructions, action });
    }

    return { files };
  }

  printConfig(loc: Location): string {
    if (!this.supportsLocation(loc)) {
      return `# ${this.displayName} has no project-local config — use --location=global.\n`;
    }
    const target = this.settingsPath(loc);
    if (target === null) {
      return `# ${this.unavailableNote()}\n`;
    }
    const snippet = JSON.stringify({ [this.serversKey()]: { codegraph: this.serverEntry() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (!this.supportsLocation(loc)) return [];
    const paths = [this.settingsPath(loc)];
    const instructions = this.instructionsPath(loc);
    if (instructions) paths.push(instructions);
    return paths.filter((p): p is string => p !== null);
  }

  private writeMcpEntry(loc: Location): WriteResult['files'][number] {
    const file = this.settingsPath(loc)!; // callers guard null
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const key = this.serversKey();
    const existing = readJsonFile(file);
    const before = existing[key]?.codegraph;
    const after = this.serverEntry();

    if (jsonDeepEqual(before, after)) {
      return { path: file, action: 'unchanged' };
    }
    const action: 'created' | 'updated' =
      before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
    if (!existing[key]) existing[key] = {};
    existing[key].codegraph = after;
    writeJsonFile(file, existing);
    return { path: file, action };
  }
}

export function createMcpJsonFamilyTarget(spec: McpJsonFamilySpec): AgentTarget {
  return new McpJsonFamilyTarget(spec);
}
