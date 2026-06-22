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
}

interface CacheEntry {
  mtimeMs: number;
  overrides: Record<string, Language>;
}

/**
 * Cache keyed by project root. The loader is called once per indexing/scan/sync
 * operation (and per watch event), so the mtime guard keeps repeat calls to one
 * `stat` while a single `codegraph.json` is in force. Keying by root keeps two
 * projects in the same process (the daemon / multi-project MCP server) isolated.
 */
const overridesCache = new Map<string, Record<string, Language>>();
const cacheMeta = new Map<string, CacheEntry>();

/** Shared frozen empty map so the no-config path allocates nothing. */
const EMPTY: Record<string, Language> = Object.freeze({});

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
 * Parse and validate the `extensions` map out of a `codegraph.json` file.
 * Every failure mode degrades to "no overrides from this entry" — a bad file or
 * a typo'd language never throws.
 */
function parseExtensionOverrides(file: string): Record<string, Language> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return EMPTY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn(`Ignoring ${PROJECT_CONFIG_FILENAME}: not valid JSON`, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY;
  }

  if (!parsed || typeof parsed !== 'object') return EMPTY;
  const exts = (parsed as ProjectConfig).extensions;
  if (!exts || typeof exts !== 'object' || Array.isArray(exts)) return EMPTY;

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

  return Object.keys(out).length > 0 ? out : EMPTY;
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
  const file = path.join(rootDir, PROJECT_CONFIG_FILENAME);

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // No config file — drop any stale cache entry and return the default.
    cacheMeta.delete(rootDir);
    overridesCache.delete(rootDir);
    return EMPTY;
  }

  const meta = cacheMeta.get(rootDir);
  if (meta && meta.mtimeMs === mtimeMs) return meta.overrides;

  const overrides = parseExtensionOverrides(file);
  cacheMeta.set(rootDir, { mtimeMs, overrides });
  overridesCache.set(rootDir, overrides);
  return overrides;
}

/** Test/maintenance hook: forget cached config (e.g. after rewriting it in a test). */
export function clearProjectConfigCache(): void {
  cacheMeta.clear();
  overridesCache.clear();
}
