/**
 * opencode target.
 *
 *   - MCP server entry to `~/.config/opencode/opencode.jsonc` (global,
 *     XDG-style; `%APPDATA%/opencode/opencode.jsonc` on Windows) or
 *     `./opencode.jsonc` (local). Falls back to `opencode.json` when a
 *     `.json` file already exists; defaults new installs to `.jsonc`
 *     because that's what opencode itself creates on first run.
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
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function globalConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'opencode');
  }
  // XDG_CONFIG_HOME if set, else ~/.config — matches opencode's docs.
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'opencode');
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
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir())
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // AGENTS.md is no longer written — the codegraph usage guidance
    // ships in the MCP server's `initialize` response (issue #529).
    // Strip a block a previous install left so an upgrade self-heals.
    const instrCleanup = removeInstructionsEntry(loc);
    if (instrCleanup.action === 'removed') files.push(instrCleanup);

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const file = configPath(loc);

    if (!fs.existsSync(file)) {
      files.push({ path: file, action: 'not-found' });
    } else {
      const text = readConfigText(file);
      const config = parseConfig(text);
      if (!config.mcp?.codegraph) {
        files.push({ path: file, action: 'not-found' });
      } else {
        // Drop our key surgically. Leaves siblings + comments untouched.
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
        files.push({ path: file, action: 'removed' });
      }
    }

    files.push(removeInstructionsEntry(loc));

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
