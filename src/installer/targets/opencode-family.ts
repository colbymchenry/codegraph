/**
 * opencode-family target factory.
 *
 * The mechanics of the opencode target — jsonc `mcp.<name>` wrapper,
 * `command` as a string array, XDG-only config-dir resolution on every
 * platform, `.jsonc`-preferred-over-`.json`, AGENTS.md instructions —
 * apply verbatim to opencode forks that only rename the on-disk app
 * identity (CoDev Code, #1272). This factory turns an app spec into a
 * complete `AgentTarget`; the built-in opencode target is one
 * instantiation, custom targets (`./custom.ts`, family `"opencode"`)
 * are others.
 *
 * Everything below `appName` substitution is the original
 * `opencode.ts` implementation, moved here unchanged:
 *
 *   - MCP server entry to `$XDG_CONFIG_HOME|~/.config/<app>/<app>.jsonc`
 *     (global) or `./<app>.jsonc` (local). Falls back to `<app>.json`
 *     when a `.json` file already exists; defaults new installs to
 *     `.jsonc` because that's what opencode itself creates on first run.
 *   - Instructions to `AGENTS.md` next to the config (global) or the
 *     project root (local).
 *   - No permissions concept.
 *
 * Config shape uses opencode's wrapper:
 *   {
 *     "$schema": "<spec.schemaUrl, when set>",
 *     "mcp": { "codegraph": { "type": "local", "command": [...], "enabled": true } }
 *   }
 *
 * Reads + writes go through `jsonc-parser` so any `//` and `/* *\/`
 * comments the user has added to their `.jsonc` survive idempotent
 * re-runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  jsonDeepEqual,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

export interface OpencodeFamilySpec {
  /** Registry id, e.g. 'opencode', 'codev'. */
  id: string;
  displayName: string;
  docsUrl?: string;
  /**
   * On-disk app identity: names both the config dir
   * (`~/.config/<appName>/`) and the config file (`<appName>.jsonc`).
   * Single path segment — validated by `custom.ts` for user specs.
   */
  appName: string;
  /**
   * `$schema` URL stamped into freshly-created configs and added to
   * existing configs that lack one. Omit for forks that don't publish
   * a schema (nothing is written then).
   */
  schemaUrl?: string;
  /**
   * Sweep a stale pre-#535 codegraph entry out of the legacy
   * `%APPDATA%/<appName>` dir on global install/uninstall. Only the
   * built-in opencode target has that install base — custom forks
   * never do, so the loader leaves this unset.
   */
  sweepLegacyWindowsAppData?: boolean;
}

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

class OpencodeFamilyTarget implements AgentTarget {
  readonly id: string;
  readonly displayName: string;
  readonly docsUrl?: string;

  constructor(private readonly spec: OpencodeFamilySpec) {
    this.id = spec.id;
    this.displayName = spec.displayName;
    this.docsUrl = spec.docsUrl;
  }

  private globalConfigDir(): string {
    // XDG_CONFIG_HOME if set, else ~/.config — on every platform, matching
    // opencode's own `xdg-basedir` resolution (no Windows special case; #535).
    const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');
    return path.join(xdg, this.spec.appName);
  }

  /**
   * Pre-#535 installs wrote the global entry to `%APPDATA%/<app>` — a dir
   * today's opencode never reads. Returns that legacy dir when it could hold
   * stale state (APPDATA set and resolving somewhere other than the real config
   * dir). Gated on the env var rather than `process.platform` so the cleanup
   * logic runs under the cross-platform test suite; on POSIX, APPDATA is unset
   * in real life and this is a no-op.
   */
  private legacyWindowsConfigDir(): string | null {
    if (!this.spec.sweepLegacyWindowsAppData) return null;
    const appData = process.env.APPDATA;
    if (!appData || !appData.trim()) return null;
    const legacy = path.join(appData, this.spec.appName);
    return path.resolve(legacy) === path.resolve(this.globalConfigDir()) ? null : legacy;
  }

  private configBaseDir(loc: Location): string {
    return loc === 'global' ? this.globalConfigDir() : process.cwd();
  }

  // Pick existing .jsonc, then .json, default to .jsonc for new files.
  // opencode auto-creates .jsonc on first run, so that's the dominant
  // real-world case and the sensible default for greenfield installs.
  private configPath(loc: Location): string {
    const dir = this.configBaseDir(loc);
    const jsonc = path.join(dir, `${this.spec.appName}.jsonc`);
    const json = path.join(dir, `${this.spec.appName}.json`);
    if (fs.existsSync(jsonc)) return jsonc;
    if (fs.existsSync(json)) return json;
    return jsonc;
  }

  private instructionsPath(loc: Location): string {
    return path.join(this.configBaseDir(loc), 'AGENTS.md');
  }

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = this.configPath(loc);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.mcp?.codegraph;
    // Global: the XDG dir is what current opencode creates on first run; the
    // legacy %APPDATA% dir still counts as "opencode present" so a re-install
    // can sweep the stale pre-#535 entry out of it.
    const legacy = this.legacyWindowsConfigDir();
    const installed = loc === 'global'
      ? fs.existsSync(this.globalConfigDir()) || (!!legacy && fs.existsSync(legacy))
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(this.writeMcpEntry(loc));

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(this.instructionsPath(loc)));

    // Self-heal a pre-#535 install that wrote to %APPDATA%/<app> —
    // opencode never reads it, so anything of ours there is stale.
    if (loc === 'global') files.push(...this.cleanupLegacyWindowsState());

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(this.removeMcpEntryAt(this.configPath(loc)));
    files.push(this.removeInstructionsEntry(loc));
    if (loc === 'global') files.push(...this.cleanupLegacyWindowsState());
    return { files };
  }

  printConfig(loc: Location): string {
    const target = this.configPath(loc);
    const body: Record<string, any> = {};
    if (this.spec.schemaUrl) body.$schema = this.spec.schemaUrl;
    body.mcp = { codegraph: getServerEntry() };
    const snippet = JSON.stringify(body, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [this.configPath(loc), this.instructionsPath(loc)];
  }

  private writeMcpEntry(loc: Location): WriteResult['files'][number] {
    const file = this.configPath(loc);
    const existed = fs.existsSync(file);
    let text = readConfigText(file);

    // Seed a minimal config when the file is brand-new so the result is
    // a complete, schema-tagged file (not just a bare `{ "mcp": {...} }`).
    if (!text.trim()) {
      text = this.spec.schemaUrl
        ? `{\n  "$schema": ${JSON.stringify(this.spec.schemaUrl)}\n}\n`
        : '{}\n';
    }

    const config = parseConfig(text);
    const before = config.mcp?.codegraph;
    const after = getServerEntry();

    if (jsonDeepEqual(before, after)) {
      return { path: file, action: 'unchanged' };
    }

    // Add $schema if the user's existing file is missing it.
    if (this.spec.schemaUrl && !config.$schema) {
      const schemaEdits = modify(text, ['$schema'], this.spec.schemaUrl, {
        formattingOptions: FORMATTING,
      });
      text = applyEdits(text, schemaEdits);
    }

    // Surgical edit — preserves comments, formatting, and order of
    // every key we don't touch.
    const edits = modify(text, ['mcp', 'codegraph'], after, {
      formattingOptions: FORMATTING,
    });
    const updated = applyEdits(text, edits);
    atomicWriteFileSync(file, updated);

    return { path: file, action: existed ? 'updated' : 'created' };
  }

  /**
   * Surgically drop `mcp.codegraph` from one config file. Leaves sibling
   * servers, comments, and formatting untouched; drops an emptied `mcp`
   * wrapper too. Shared by uninstall and the legacy-%APPDATA% sweep.
   */
  private removeMcpEntryAt(file: string): WriteResult['files'][number] {
    if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
    const text = readConfigText(file);
    const config = parseConfig(text);
    if (!config.mcp?.codegraph) return { path: file, action: 'not-found' };

    let edits = modify(text, ['mcp', 'codegraph'], undefined, {
      formattingOptions: FORMATTING,
    });
    let updated = applyEdits(text, edits);

    // If `mcp` is now an empty object, drop the wrapper too.
    const afterParsed = parseConfig(updated);
    if (afterParsed.mcp && typeof afterParsed.mcp === 'object' &&
        Object.keys(afterParsed.mcp).length === 0) {
      edits = modify(updated, ['mcp'], undefined, { formattingOptions: FORMATTING });
      updated = applyEdits(updated, edits);
    }

    atomicWriteFileSync(file, updated);
    return { path: file, action: 'removed' };
  }

  /**
   * Remove whatever a pre-#535 install left in `%APPDATA%/<app>` — an MCP
   * entry opencode never reads, plus our marker-fenced AGENTS.md block. Returns
   * only files actually changed, so install output stays quiet when there is
   * nothing to heal. Never touches anything else in the legacy dir: a user may
   * genuinely keep other tools' state under %APPDATA%.
   */
  private cleanupLegacyWindowsState(): WriteResult['files'] {
    const dir = this.legacyWindowsConfigDir();
    if (!dir || !fs.existsSync(dir)) return [];
    const out: WriteResult['files'] = [];
    for (const name of [`${this.spec.appName}.jsonc`, `${this.spec.appName}.json`]) {
      const res = this.removeMcpEntryAt(path.join(dir, name));
      if (res.action === 'removed') out.push(res);
    }
    const agents = path.join(dir, 'AGENTS.md');
    const action = removeMarkedSection(agents, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    if (action === 'removed') out.push({ path: agents, action });
    return out;
  }

  /**
   * Strip the marker-delimited CodeGraph block from AGENTS.md if a prior
   * install wrote one. Used by both install (self-heal on upgrade) and
   * uninstall — see issue #529.
   */
  private removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
    const file = this.instructionsPath(loc);
    const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    return { path: file, action };
  }
}

function readConfigText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

function parseConfig(text: string): Record<string, any> {
  if (!text.trim()) return {};
  const errors: any[] = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, any>;
}

function getServerEntry(): { type: string; command: string[]; enabled: boolean } {
  return {
    type: 'local',
    command: ['codegraph', 'serve', '--mcp'],
    enabled: true,
  };
}

export function createOpencodeFamilyTarget(spec: OpencodeFamilySpec): AgentTarget {
  return new OpencodeFamilyTarget(spec);
}
