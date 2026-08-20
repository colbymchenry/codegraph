/**
 * opencode target.
 *
 *   - MCP server entry to `~/.config/opencode/opencode.jsonc` (global,
 *     XDG-style on EVERY platform, Windows included — see below) or
 *     `./opencode.jsonc` (local). Falls back to `opencode.json` when a
 *     `.json` file already exists; defaults new installs to `.jsonc`
 *     because that's what opencode itself creates on first run.
 *
 *     opencode resolves its config dir with the `xdg-basedir` package
 *     (sst/opencode `packages/core/src/global.ts`): `XDG_CONFIG_HOME`
 *     if set, else `~/.config` — unconditionally, on all platforms. It
 *     never reads `%APPDATA%`; that layout belonged to the discontinued
 *     Go fork. We previously wrote there on Windows, so opencode never
 *     saw the entry (#535) — install/uninstall now also sweep a stale
 *     codegraph entry out of the legacy `%APPDATA%/opencode` location.
 *   - Instructions to `~/.config/opencode/AGENTS.md` (global) or
 *     `./AGENTS.md` (local). opencode reads AGENTS.md for agent
 *     instructions — same convention Codex CLI uses.
 *   - No permissions concept.
 *
 * Config shape uses opencode's wrapper:
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "mcp": { "codegraph": { "type": "local", "command": [...], "enabled": true } }
 *   }
 *
 * The shape differs from Claude/Cursor — opencode uses `mcp.<name>`
 * (not `mcpServers`), takes `command` as a string array combining
 * binary + args, and includes an explicit `enabled` flag.
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

function globalConfigDir(): string {
  // XDG_CONFIG_HOME if set, else ~/.config — on every platform, matching
  // opencode's own `xdg-basedir` resolution (no Windows special case; #535).
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'opencode');
}

/**
 * Pre-#535 installs wrote the global entry to `%APPDATA%/opencode` — a dir
 * today's opencode never reads. Returns that legacy dir when it could hold
 * stale state (APPDATA set and resolving somewhere other than the real config
 * dir). Gated on the env var rather than `process.platform` so the cleanup
 * logic runs under the cross-platform test suite; on POSIX, APPDATA is unset
 * in real life and this is a no-op.
 */
function legacyWindowsConfigDir(): string | null {
  const appData = process.env.APPDATA;
  if (!appData || !appData.trim()) return null;
  const legacy = path.join(appData, 'opencode');
  return path.resolve(legacy) === path.resolve(globalConfigDir()) ? null : legacy;
}

function configBaseDir(loc: Location): string {
  return loc === 'global' ? globalConfigDir() : process.cwd();
}

// Pick existing .jsonc, then .json, default to .jsonc for new files.
// opencode auto-creates .jsonc on first run, so that's the dominant
// real-world case and the sensible default for greenfield installs.
function configPath(loc: Location): string {
  const dir = configBaseDir(loc);
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  if (fs.existsSync(jsonc)) return jsonc;
  if (fs.existsSync(json)) return json;
  return jsonc;
}

function instructionsPath(loc: Location): string {
  return path.join(configBaseDir(loc), 'AGENTS.md');
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

function getOpencodeServerEntry(): { type: string; command: string[]; enabled: boolean } {
  return {
    type: 'local',
    command: ['codegraph', 'serve', '--mcp'],
    enabled: true,
  };
}

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

class OpencodeTarget implements AgentTarget {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly docsUrl = 'https://opencode.ai/docs/config';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.mcp?.codegraph;
    // Global: the XDG dir is what current opencode creates on first run; the
    // legacy %APPDATA% dir still counts as "opencode present" so a re-install
    // can sweep the stale pre-#535 entry out of it.
    const legacy = legacyWindowsConfigDir();
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir()) || (!!legacy && fs.existsSync(legacy))
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    // Self-heal a pre-#535 install that wrote to %APPDATA%/opencode —
    // opencode never reads it, so anything of ours there is stale.
    if (loc === 'global') files.push(...cleanupLegacyWindowsState());

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(removeMcpEntryAt(configPath(loc)));
    files.push(removeInstructionsEntry(loc));
    if (loc === 'global') files.push(...cleanupLegacyWindowsState());
    return { files };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { codegraph: getOpencodeServerEntry() },
    }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const existed = fs.existsSync(file);
  let text = readConfigText(file);

  // Seed a minimal opencode config when the file is brand-new so
  // the result is a complete, schema-tagged file (not just a bare
  // `{ "mcp": {...} }`).
  if (!text.trim()) {
    text = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  }

  const config = parseConfig(text);
  const before = config.mcp?.codegraph;
  const after = getOpencodeServerEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  // Add $schema if the user's existing file is missing it.
  if (!config.$schema) {
    const schemaEdits = modify(text, ['$schema'], 'https://opencode.ai/config.json', {
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
function removeMcpEntryAt(file: string): WriteResult['files'][number] {
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
 * Remove whatever a pre-#535 install left in `%APPDATA%/opencode` — an MCP
 * entry opencode never reads, plus our marker-fenced AGENTS.md block. Returns
 * only files actually changed, so install output stays quiet when there is
 * nothing to heal. Never touches anything else in the legacy dir: a user may
 * genuinely keep other tools' state under %APPDATA%.
 */
function cleanupLegacyWindowsState(): WriteResult['files'] {
  const dir = legacyWindowsConfigDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const out: WriteResult['files'] = [];
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const res = removeMcpEntryAt(path.join(dir, name));
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
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const opencodeTarget: AgentTarget = new OpencodeTarget();
