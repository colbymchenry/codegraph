/**
 * Qwen Code target (https://github.com/QwenLM/qwen-code).
 *
 *   - MCP server entry to `~/.qwen/settings.json` (global, user scope)
 *     or `./.qwen/settings.json` (local, project scope) under the
 *     standard `mcpServers.codegraph` key — same shape as Claude /
 *     Gemini, so `getMcpServerConfig()` applies unchanged.
 *   - Instructions to `~/.qwen/QWEN.md` (global) or `./QWEN.md`
 *     (local — Qwen Code reads the project-root file directly; the
 *     personal project-scope variant `.qwen/QWEN.local.md` is the
 *     user's own and is left alone).
 *   - Permissions (gated on `autoAllow`): `permissions.allow` gains
 *     `mcp__codegraph`, Qwen's server-scoped rule form — one rule
 *     auto-approves every tool the server exposes (the analogue of
 *     Claude's `mcp__codegraph__*`, whose syntax Qwen does not use).
 *
 * Qwen's settings.json officially allows JSONC comments and `$VAR`
 * environment interpolation, so every read goes through `jsonc-parser`
 * and every write is a surgical `modify`/`applyEdits` — a plain
 * JSON.parse→stringify round-trip would silently delete the user's
 * comments (same reasoning as the opencode target).
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
  getMcpServerConfig,
  jsonDeepEqual,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.qwen')
    : path.join(process.cwd(), '.qwen');
}

function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}

function instructionsPath(loc: Location): string {
  // Global QWEN.md lives under ~/.qwen/; the project file sits at the
  // project root, matching Qwen Code's hierarchical context loader.
  return loc === 'global'
    ? path.join(configDir('global'), 'QWEN.md')
    : path.join(process.cwd(), 'QWEN.md');
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

/**
 * Qwen's auto-approve rule for the whole codegraph server — its
 * permission syntax is server-scoped (`mcp__<server>`), not
 * Claude's per-server wildcard (`mcp__<server>__*`).
 */
function getQwenPermissions(): string[] {
  return ['mcp__codegraph'];
}

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

class QwenTarget implements AgentTarget {
  readonly id = 'qwen' as const;
  readonly displayName = 'Qwen Code';
  readonly docsUrl = 'https://github.com/QwenLM/qwen-code';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsJsonPath(loc);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(configDir('global')) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeSettingsEntries(loc, opts.autoAllow));

    // QWEN.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read QWEN.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(removeSettingsEntries(loc));
    files.push(removeInstructionsEntry(loc));
    return { files };
  }

  printConfig(loc: Location): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { codegraph: getMcpServerConfig() } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsJsonPath(loc), instructionsPath(loc)];
  }
}

/**
 * One surgical pass over settings.json: upsert the MCP entry, and — when
 * `autoAllow` — the permissions rule. Both live in the same file, so they
 * share a single read/compare/write: two separate edits would report the
 * file twice and could not answer "unchanged" for the pair. Sibling
 * servers, permissions, comments and formatting are preserved; when the
 * file already holds exactly what we'd write, it is left byte-for-byte
 * untouched.
 */
function writeSettingsEntries(loc: Location, autoAllow: boolean): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const existed = fs.existsSync(file);
  let text = readConfigText(file);
  const config = parseConfig(text);

  const mcpBefore = config.mcpServers?.codegraph;
  const mcpAfter = getMcpServerConfig();
  const mcpMatches = jsonDeepEqual(mcpBefore, mcpAfter);

  const allowBefore = Array.isArray(config.permissions?.allow)
    ? config.permissions.allow
    : null;
  const want = autoAllow ? getQwenPermissions() : null;
  const allowMatches =
    !want ||
    (allowBefore !== null &&
      jsonDeepEqual(
        [...allowBefore, ...want.filter((p) => !allowBefore.includes(p))],
        allowBefore,
      ));

  if (mcpMatches && allowMatches) {
    return { path: file, action: existed ? 'unchanged' : 'created' };
  }

  // Fresh/empty file: seed a minimal object so the result is complete
  // (jsonc-parser's modify needs a document root to insert into).
  if (!text.trim()) text = '{\n}\n';

  if (!mcpMatches) {
    text = applyEdits(
      text,
      modify(text, ['mcpServers', 'codegraph'], mcpAfter, { formattingOptions: FORMATTING }),
    );
  }
  if (!allowMatches && want) {
    const merged = [...(allowBefore ?? []), ...want.filter((p) => !(allowBefore ?? []).includes(p))];
    text = applyEdits(
      text,
      modify(text, ['permissions', 'allow'], merged, { formattingOptions: FORMATTING }),
    );
  }

  atomicWriteFileSync(file, text);
  return { path: file, action: existed ? 'updated' : 'created' };
}

/**
 * Inverse of writeSettingsEntries: drop `mcpServers.codegraph` (and the
 * permissions rule, whether or not autoAllow wrote it) from settings.json.
 * Sibling servers, other permissions, and comments survive; empty
 * wrappers collapse so the file reads the way it did before install.
 * Only our own keys are touched — a settings.json we never wrote
 * reports `not-found`.
 */
function removeSettingsEntries(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  let text = readConfigText(file);
  const config = parseConfig(text);

  const hadMcp = !!config.mcpServers?.codegraph;
  const allow = Array.isArray(config.permissions?.allow) ? config.permissions.allow : null;
  const hadPerm = allow !== null && allow.some((p: unknown) =>
    typeof p === 'string' && (p === 'mcp__codegraph' || p.startsWith('mcp__codegraph(')),
  );
  if (!hadMcp && !hadPerm) return { path: file, action: 'not-found' };

  if (hadMcp) {
    text = applyEdits(
      text,
      modify(text, ['mcpServers', 'codegraph'], undefined, { formattingOptions: FORMATTING }),
    );
    const mid = parseConfig(text);
    if (mid.mcpServers && Object.keys(mid.mcpServers).length === 0) {
      text = applyEdits(
        text,
        modify(text, ['mcpServers'], undefined, { formattingOptions: FORMATTING }),
      );
    }
  }
  if (hadPerm) {
    const kept = allow.filter((p: unknown) =>
      !(typeof p === 'string' && (p === 'mcp__codegraph' || p.startsWith('mcp__codegraph('))),
    );
    if (kept.length > 0) {
      text = applyEdits(
        text,
        modify(text, ['permissions', 'allow'], kept, { formattingOptions: FORMATTING }),
      );
    } else {
      text = applyEdits(
        text,
        modify(text, ['permissions', 'allow'], undefined, { formattingOptions: FORMATTING }),
      );
      const mid = parseConfig(text);
      if (mid.permissions && Object.keys(mid.permissions).length === 0) {
        text = applyEdits(
          text,
          modify(text, ['permissions'], undefined, { formattingOptions: FORMATTING }),
        );
      }
    }
  }

  atomicWriteFileSync(file, text);
  return { path: file, action: 'removed' };
}

/**
 * Strip the marker-delimited CodeGraph block from QWEN.md if a prior
 * install wrote one. Used by both install (self-heal on upgrade) and
 * uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const qwenTarget: AgentTarget = new QwenTarget();
