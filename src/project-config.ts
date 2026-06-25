/**
 * Project-scoped configuration: a committed `codegraph.json` at the project
 * root that a team shares through version control.
 *
 * Today it carries one thing — `extensions`, an opt-in map from a custom file
 * extension to one of CodeGraph's supported languages. The built-in
 * extension → language table (`EXTENSION_MAP` in `extraction/grammars.ts`) is
 * otherwise hardcoded, so a codebase that uses a non-standard extension for a
 * supported language (e.g. `.dota_lua` for Lua) sees those files silently
 * skipped. This lets the project map them once, in a version-controlled file:
 *
 *   {
 *     "extensions": {
 *       ".dota_lua": "lua",
 *       ".tpl": "php"
 *     }
 *   }
 *
 * User mappings merge on TOP of the built-ins and win on conflict, so a project
 * can also re-point a built-in extension (e.g. force `.h` → `cpp`). Absent or
 * malformed config is the zero-config default — no overrides, no error. Invalid
 * individual entries are warned-and-skipped (never fatal): an unparseable
 * project file must not break indexing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Language } from './types';
import { isLanguageSupported } from './extraction/grammars';
import { logWarn } from './errors';

/** Filename of the project-scoped config, resolved relative to the project root. */
export const PROJECT_CONFIG_FILENAME = 'codegraph.json';

export interface ProjectConfig {
  /** Map of custom file extension (`.foo`) to a supported language id. */
  extensions?: Record<string, string>;
  /**
   * Gitignore-style patterns naming gitignored directories whose embedded git
   * repositories should be indexed anyway — the explicit opt-in to override
   * `.gitignore` for nested-repo discovery (#622, #699). Absent/empty (the
   * default) means `.gitignore` is fully respected: gitignored embedded repos
   * are never discovered or indexed (#970, #976).
   */
  includeIgnored?: string[];
}

/** Parsed, validated view of a project's `codegraph.json`. */
interface ParsedConfig {
  extensions: Record<string, Language>;
  includeIgnored: string[];
}

interface CacheEntry {
  mtimeMs: number;
  config: ParsedConfig;
}

/**
 * Cache keyed by project root. The loader is called once per indexing/scan/sync
 * operation (and per watch event), so the mtime guard keeps repeat calls to one
 * `stat` while a single `codegraph.json` is in force. Keying by root keeps two
 * projects in the same process (the daemon / multi-project MCP server) isolated.
 */
const cache = new Map<string, CacheEntry>();

/** Shared frozen empties so the no-config path allocates nothing. */
const EMPTY_EXTENSIONS: Record<string, Language> = Object.freeze({});
const EMPTY_CONFIG: ParsedConfig = Object.freeze({
  extensions: EMPTY_EXTENSIONS,
  includeIgnored: Object.freeze([]) as unknown as string[],
});

/**
 * Normalize a user-provided extension key to the `.ext` lowercase form used by
 * the built-in map. Returns null for keys that can never match a real file
 * extension (so the caller warns and skips):
 *   - empty / just "."
 *   - multi-part (".d.ts") — language detection keys off the FINAL extension
 *     only (`lastIndexOf('.')`), so a multi-dot key would never be consulted.
 *   - anything containing a path separator.
 */
function normalizeExtKey(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let ext = raw.trim().toLowerCase();
  if (!ext) return null;
  if (!ext.startsWith('.')) ext = '.' + ext;
  const body = ext.slice(1);
  if (!body) return null;
  if (body.includes('.') || body.includes('/') || body.includes('\\')) return null;
  return ext;
}

/**
 * Read + JSON-parse a `codegraph.json` once and return its validated view.
 * Every failure mode degrades to the zero-config default — a missing file, bad
 * JSON, or a typo'd value never throws.
 */
function parseConfig(file: string): ParsedConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return EMPTY_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn(`Ignoring ${PROJECT_CONFIG_FILENAME}: not valid JSON`, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_CONFIG;
  }

  if (!parsed || typeof parsed !== 'object') return EMPTY_CONFIG;

  const extensions = extractExtensions(parsed, file);
  const includeIgnored = extractIncludeIgnored(parsed, file);
  if (extensions === EMPTY_EXTENSIONS && includeIgnored.length === 0) return EMPTY_CONFIG;
  return { extensions, includeIgnored };
}

/**
 * Validate the `extensions` map. Every failure mode degrades to "no overrides
 * from this entry" — a bad value or a typo'd language never throws.
 */
function extractExtensions(parsed: object, file: string): Record<string, Language> {
  const exts = (parsed as ProjectConfig).extensions;
  if (!exts || typeof exts !== 'object' || Array.isArray(exts)) return EMPTY_EXTENSIONS;

  const out: Record<string, Language> = {};
  for (const [rawKey, rawVal] of Object.entries(exts)) {
    const key = normalizeExtKey(rawKey);
    if (!key) {
      logWarn(`Ignoring extension mapping in ${PROJECT_CONFIG_FILENAME}: "${rawKey}" is not a valid file extension`, { file });
      continue;
    }
    if (typeof rawVal !== 'string' || !isLanguageSupported(rawVal as Language)) {
      logWarn(`Ignoring extension "${rawKey}" in ${PROJECT_CONFIG_FILENAME}: "${String(rawVal)}" is not a supported language`, { file });
      continue;
    }
    out[key] = rawVal as Language;
  }

  return Object.keys(out).length > 0 ? out : EMPTY_EXTENSIONS;
}

/**
 * Validate the `includeIgnored` patterns: an array of non-empty gitignore-style
 * strings. A non-array value or a non-string/blank entry warns-and-skips; never
 * throws. Patterns are kept verbatim (trimmed) so they match exactly as a
 * `.gitignore` line would.
 */
function extractIncludeIgnored(parsed: object, file: string): string[] {
  const raw = (parsed as ProjectConfig).includeIgnored;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logWarn(`Ignoring "includeIgnored" in ${PROJECT_CONFIG_FILENAME}: must be an array of gitignore-style patterns`, { file });
    return [];
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      logWarn(`Ignoring an "includeIgnored" entry in ${PROJECT_CONFIG_FILENAME}: every pattern must be a non-empty string`, { file });
      continue;
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Load the parsed `codegraph.json` for a project, mtime-cached. A missing or
 * malformed file yields the zero-config default. One `stat` (and at most one
 * read/parse) while a single config file is in force, shared across every field.
 */
function loadParsedConfig(rootDir: string): ParsedConfig {
  const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // No config file — drop any stale cache entry and return the default.
    cache.delete(rootDir);
    return EMPTY_CONFIG;
  }

  const entry = cache.get(rootDir);
  if (entry && entry.mtimeMs === mtimeMs) return entry.config;

  const config = parseConfig(file);
  cache.set(rootDir, { mtimeMs, config });
  return config;
}

/**
 * Load the validated extension overrides for a project, mtime-cached.
 *
 * Returns a map of `.ext` → supported language id. The result merges on top of
 * the built-in extension map at the point of use (see `detectLanguage` /
 * `isSourceFile`), with these user mappings taking precedence. Returns an empty
 * map when there is no `codegraph.json` (the zero-config default).
 */
export function loadExtensionOverrides(rootDir: string): Record<string, Language> {
  return loadParsedConfig(rootDir).extensions;
}

/**
 * Load the validated `includeIgnored` patterns for a project, mtime-cached.
 *
 * These name gitignored directories whose embedded git repositories should be
 * indexed despite `.gitignore` (#622, #699). An empty result — the zero-config
 * default — means `.gitignore` is fully respected: gitignored embedded repos
 * are never discovered or indexed (#970, #976).
 */
export function loadIncludeIgnoredPatterns(rootDir: string): string[] {
  return loadParsedConfig(rootDir).includeIgnored;
}

/** Test/maintenance hook: forget cached config (e.g. after rewriting it in a test). */
export function clearProjectConfigCache(): void {
  cache.clear();
}
