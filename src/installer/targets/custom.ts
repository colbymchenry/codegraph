/**
 * User defined installer targets.
 *
 * A custom target is a small spec naming a family, one of the config shapes
 * the installer already writes, plus the paths that identify the agent.
 * Specs live in `~/.codegraph/targets.json` (override: `CODEGRAPH_TARGETS_FILE`,
 * for tests), are managed by `codegraph targets add|list|remove`, and are
 * appended to the registry by `getAllTargets()` in `./registry.ts`, so
 * `codegraph install --target <id>`, `auto` and `all`, the agent picker,
 * `--refresh`, `--print-config` and `codegraph uninstall` see them with no
 * further wiring.
 *
 * A spec says where to write, never what: the family supplies the entry and
 * the editing rules, which is what keeps the installer's promises provable
 * for each family rather than for each spec, and keeps a typo in a spec from
 * writing outside an agent's config dir. Every value is checked here, on
 * `targets add` and again on load. Loading is tolerant: a spec that fails a
 * check is skipped with one warning, and the installer keeps working for the
 * builtin targets. `targets add` is strict and refuses the spec.
 *
 * Design: docs/design/custom-installer-targets.md.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { AgentTarget, Location } from './types';
import { atomicWriteFileSync } from './shared';
import { createOpencodeFamilyTarget } from './opencode-family';
import { createTomlFamilyTarget } from './toml-family';
import { createMcpJsonFamilyTarget } from './mcp-json-family';
import {
  PLATFORM_KEYS,
  hasParentSegment,
  isRootedDir,
  type PlatformKey,
  type SpecDir,
} from './spec-paths';

export type CustomTargetFamily = 'opencode' | 'toml' | 'mcp-json';

export interface CustomTargetSpec {
  /** The registry id, used as `--target <id>`. Lowercase letters, digits and `-`, up to 32 characters. */
  id: string;
  /** Shown in prompts and log lines. Default: the id. */
  displayName?: string;
  family: CustomTargetFamily;
  docsUrl?: string;

  // family: opencode
  /** The app's name on disk: `~/.config/<appName>/<appName>.jsonc`. */
  appName?: string;
  /** `$schema` written into a config the install creates. */
  schemaUrl?: string;

  // families: toml, mcp-json
  /** The global config dir, or one for each platform. Absolute, `~`, or one leading `${ENV}` token. */
  configDir?: SpecDir;
  /** An environment variable that names the global config dir when set. */
  homeEnvVar?: string;
  /** The config file's name. Default `config.toml` or `settings.json`. */
  configFileName?: string;
  /** The project local config dir, relative to the project; `.` is the project itself. Absent: global only. */
  localConfigDir?: string;
  /** The instructions file, relative to the config dir. Default `AGENTS.md`. `null` writes none. */
  instructionsFile?: string | null;
  /** Where a local install puts the instructions file: the project root or the local config dir. */
  instructionsLocal?: 'project' | 'config';

  // family: mcp-json
  /** The project local file's name, when it differs from `configFileName`. */
  localConfigFileName?: string;
  /** The keys that lead to the servers map, joined by dots. Default `mcpServers`. */
  serversKey?: string;
  /** Write `{ command, args }` with no `type` key. */
  omitTypeField?: boolean;
  /** Write the binary's absolute path as `command` on macOS, for an app launched from the Dock. */
  absoluteCommand?: boolean;

  // any family
  /** Shown after a successful install. Up to 5 lines of up to 200 characters. */
  notes?: string[];
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_IDS = new Set(['auto', 'all', 'none', 'custom']);
const FAMILIES: readonly CustomTargetFamily[] = ['opencode', 'toml', 'mcp-json'];
/** One path segment: no separators, and `.` and `..` are refused separately. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const MAX_NOTES = 5;
const MAX_NOTE_LENGTH = 200;
const MAX_DISPLAY_NAME = 64;
const MAX_URL = 2048;
export const MAX_CUSTOM_TARGETS = 50;

const COMMON_KEYS = ['id', 'displayName', 'family', 'docsUrl', 'notes'];
const DIR_KEYS = ['configDir', 'homeEnvVar', 'configFileName', 'localConfigDir', 'instructionsFile', 'instructionsLocal'];
const FAMILY_KEYS: Record<CustomTargetFamily, readonly string[]> = {
  opencode: [...COMMON_KEYS, 'appName', 'schemaUrl'],
  toml: [...COMMON_KEYS, ...DIR_KEYS],
  'mcp-json': [...COMMON_KEYS, ...DIR_KEYS, 'localConfigFileName', 'serversKey', 'omitTypeField', 'absoluteCommand'],
};
const CONFIG_EXTENSIONS: Record<'toml' | 'mcp-json', readonly string[]> = {
  toml: ['.toml'],
  'mcp-json': ['.json', '.jsonc'],
};

export function targetsFilePath(): string {
  const override = process.env.CODEGRAPH_TARGETS_FILE;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.codegraph', 'targets.json');
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isPlainText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !CONTROL_CHARS.test(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_URL) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isSegment(value: unknown): value is string {
  return typeof value === 'string' && SEGMENT.test(value) && value !== '.' && value !== '..';
}

/** A relative path with no `..`, no empty segment, and no absolute form on any platform. */
function isRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (hasParentSegment(value)) return false;
  return value.split(/[\\/]/).every((segment) => isSegment(segment));
}

function dirErrors(key: string, value: unknown, platform: NodeJS.Platform): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [`"${key}" must be a path (got ${show(value)})`];
  }
  if (!isRootedDir(value, platform)) {
    return [`"${key}" must be absolute, start with ~/ or start with one \${ENV} token (got ${show(value)})`];
  }
  if (hasParentSegment(value)) return [`"${key}" must not contain ".." (got ${show(value)})`];
  if (CONTROL_CHARS.test(value)) return [`"${key}" contains a control character`];
  return [];
}

/**
 * Check one spec. Returns the problems found, in words a user can act on;
 * an empty list means the spec is valid on this machine. Kept as data, not
 * throws, so the tolerant loader and the strict `targets add` share it.
 * `builtins` are the registry's own targets: a custom id may not shadow one,
 * and a custom target may not write a file one of them owns.
 */
export function validateCustomTargetSpec(spec: unknown, builtins: readonly AgentTarget[]): string[] {
  const errors: string[] = [];
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['spec must be a JSON object'];
  }
  const s = spec as Record<string, unknown>;

  if (typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) {
    errors.push(`"id" must be 1 to 32 lowercase letters, digits or dashes, starting with a letter (got ${show(s.id)})`);
  } else if (RESERVED_IDS.has(s.id)) {
    errors.push(`"id" ${show(s.id)} is reserved`);
  } else if (builtins.some((t) => t.id === s.id)) {
    errors.push(`"id" ${show(s.id)} is a builtin target`);
  }

  if (typeof s.family !== 'string' || !FAMILIES.includes(s.family as CustomTargetFamily)) {
    errors.push(`"family" must be one of ${FAMILIES.join(', ')} (got ${show(s.family)})`);
    return errors;
  }
  const family = s.family as CustomTargetFamily;

  const allowed = FAMILY_KEYS[family];
  for (const key of Object.keys(s)) {
    if (!allowed.includes(key)) errors.push(`"${key}" is not a key the ${family} family reads`);
  }

  if (s.displayName !== undefined && !isPlainText(s.displayName, MAX_DISPLAY_NAME)) {
    errors.push(`"displayName" must be one line of up to ${MAX_DISPLAY_NAME} characters`);
  }
  for (const key of ['docsUrl', 'schemaUrl']) {
    if (s[key] !== undefined && !isHttpUrl(s[key])) {
      errors.push(`"${key}" must be an http or https URL (got ${show(s[key])})`);
    }
  }
  if (s.notes !== undefined) {
    const ok = Array.isArray(s.notes)
      && s.notes.length <= MAX_NOTES
      && s.notes.every((n) => isPlainText(n, MAX_NOTE_LENGTH));
    if (!ok) {
      errors.push(`"notes" must be up to ${MAX_NOTES} lines of up to ${MAX_NOTE_LENGTH} printable characters each`);
    }
  }

  if (family === 'opencode') {
    if (!isSegment(s.appName)) {
      errors.push(`"appName" must be one path segment (got ${show(s.appName)})`);
    }
    return errors;
  }

  // toml and mcp-json
  const dir = s.configDir;
  if (dir === undefined || dir === null) {
    errors.push(`"configDir" is required for the ${family} family`);
  } else if (typeof dir === 'string') {
    errors.push(...dirErrors('configDir', dir, process.platform));
  } else if (typeof dir === 'object' && !Array.isArray(dir)) {
    const map = dir as Record<string, unknown>;
    const unknown = Object.keys(map).filter((k) => !(PLATFORM_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      errors.push(`"configDir" has unknown platform(s) ${unknown.join(', ')}; allowed: ${PLATFORM_KEYS.join(', ')}`);
    }
    for (const key of PLATFORM_KEYS) {
      if (map[key] !== undefined) errors.push(...dirErrors(`configDir.${key}`, map[key], key));
    }
    if (map[process.platform as PlatformKey] === undefined) {
      errors.push(`"configDir" has no entry for this platform (${process.platform})`);
    }
  } else {
    errors.push(`"configDir" must be a path or a {${PLATFORM_KEYS.join(', ')}} map (got ${show(dir)})`);
  }

  if (s.homeEnvVar !== undefined && (typeof s.homeEnvVar !== 'string' || !ENV_NAME.test(s.homeEnvVar))) {
    errors.push(`"homeEnvVar" must be an environment variable name (got ${show(s.homeEnvVar)})`);
  }
  if (s.localConfigDir !== undefined && s.localConfigDir !== '.' && !isRelativePath(s.localConfigDir)) {
    errors.push(`"localConfigDir" must be a relative path with no ".." (got ${show(s.localConfigDir)})`);
  }
  for (const key of ['configFileName', 'localConfigFileName']) {
    const value = s[key];
    if (value === undefined) continue;
    const extensions = CONFIG_EXTENSIONS[family];
    if (!isSegment(value) || !extensions.some((ext) => value.toLowerCase().endsWith(ext))) {
      errors.push(`"${key}" must be a file name ending in ${extensions.join(' or ')} (got ${show(value)})`);
    }
  }
  if (s.instructionsFile !== undefined && s.instructionsFile !== null && !isRelativePath(s.instructionsFile)) {
    errors.push(`"instructionsFile" must be null or a relative path with no ".." (got ${show(s.instructionsFile)})`);
  }
  if (s.instructionsLocal !== undefined && s.instructionsLocal !== 'project' && s.instructionsLocal !== 'config') {
    errors.push(`"instructionsLocal" must be "project" or "config" (got ${show(s.instructionsLocal)})`);
  }
  if (s.serversKey !== undefined) {
    const keys = typeof s.serversKey === 'string' ? s.serversKey.split('.') : [];
    const ok = keys.length >= 1 && keys.length <= 3 && keys.every((k) => IDENTIFIER.test(k)) && (s.serversKey as string).length <= 64;
    if (!ok) {
      errors.push(`"serversKey" must be 1 to 3 identifiers joined by dots, such as "mcpServers" or "mcp.servers" (got ${show(s.serversKey)})`);
    }
  }
  for (const key of ['omitTypeField', 'absoluteCommand']) {
    if (s[key] !== undefined && typeof s[key] !== 'boolean') {
      errors.push(`"${key}" must be true or false (got ${show(s[key])})`);
    }
  }

  // Only a spec that is sound so far can be built and asked for its paths.
  if (errors.length === 0) {
    const owned = builtinFileOwner(buildCustomTarget(s as unknown as CustomTargetSpec), builtins);
    if (owned) errors.push(`it would write ${owned.file}, which the ${owned.owner} target owns`);
  }
  return errors;
}

/** The first file `target` would write that a builtin target also writes, if any. */
function builtinFileOwner(
  target: AgentTarget,
  builtins: readonly AgentTarget[],
): { file: string; owner: string } | null {
  for (const loc of ['global', 'local'] as const) {
    if (!target.supportsLocation(loc)) continue;
    const mine = new Set(target.describePaths(loc).map((p) => path.resolve(p)));
    for (const builtin of builtins) {
      if (!builtin.supportsLocation(loc)) continue;
      const shared = builtin.describePaths(loc).find((p) => mine.has(path.resolve(p)));
      if (shared) return { file: shared, owner: builtin.displayName };
    }
  }
  return null;
}

export function buildCustomTarget(spec: CustomTargetSpec): AgentTarget {
  const displayName = spec.displayName?.trim() || spec.id;
  switch (spec.family) {
    case 'opencode':
      return createOpencodeFamilyTarget({
        id: spec.id,
        displayName,
        docsUrl: spec.docsUrl,
        appName: spec.appName!,
        schemaUrl: spec.schemaUrl,
        // The sweep of the `%APPDATA%` state an install before #535 left
        // behind belongs to the opencode target alone: a fork never wrote there.
      });
    case 'toml':
      return createTomlFamilyTarget({
        id: spec.id,
        displayName,
        docsUrl: spec.docsUrl,
        configDir: spec.configDir!,
        homeEnvVar: spec.homeEnvVar,
        configFileName: spec.configFileName,
        localConfigDir: spec.localConfigDir,
        instructionsFile: spec.instructionsFile,
        instructionsLocal: spec.instructionsLocal,
        notes: spec.notes,
      });
    case 'mcp-json':
      return createMcpJsonFamilyTarget({
        id: spec.id,
        displayName,
        docsUrl: spec.docsUrl,
        configDir: spec.configDir!,
        homeEnvVar: spec.homeEnvVar,
        configFileName: spec.configFileName,
        localConfigDir: spec.localConfigDir,
        localConfigFileName: spec.localConfigFileName,
        serversKey: spec.serversKey,
        instructionsFile: spec.instructionsFile,
        instructionsLocal: spec.instructionsLocal,
        omitTypeField: spec.omitTypeField,
        absoluteCommand: spec.absoluteCommand,
        notes: spec.notes,
      });
  }
}

/** The file's top level object; `null` when the file is absent. Throws when it can't be read as JSON. */
function readTargetsFile(): { targets?: unknown } | null {
  const file = targetsFilePath();
  if (!fs.existsSync(file)) return null;
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(fs.readFileSync(file, 'utf-8'), errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`not valid JSON (error at offset ${errors[0]!.offset})`);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the top level value must be an object');
  }
  return parsed as { targets?: unknown };
}

export interface LoadedCustomTargets {
  targets: AgentTarget[];
  specs: CustomTargetSpec[];
  /** One line for each skipped spec, or for a file that couldn't be read. */
  warnings: string[];
}

let cache: { key: string; loaded: LoadedCustomTargets } | null = null;

/** The file's identity for the cache: its path, and when it last changed. */
function cacheKey(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${file}\n${stat.mtimeMs}\n${stat.size}`;
  } catch {
    return `${file}\nmissing`;
  }
}

/** Forget what was loaded, so the next call reads the file again. */
export function resetCustomTargetsCache(): void {
  cache = null;
}

/**
 * Load, check and build every custom target. Tolerant: a spec that fails a
 * check, and a file that can't be read, become warnings, never a throw.
 * The warnings are printed once for each version of the file; the registry
 * calls this from several paths.
 */
export function loadCustomTargets(builtins: readonly AgentTarget[]): LoadedCustomTargets {
  const file = targetsFilePath();
  const key = cacheKey(file);
  if (cache && cache.key === key) return cache.loaded;

  const targets: AgentTarget[] = [];
  const specs: CustomTargetSpec[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  let parsed: { targets?: unknown } | null = null;
  try {
    parsed = readTargetsFile();
  } catch (err) {
    warnings.push(`Ignoring ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const raw = parsed?.targets;
  if (raw !== undefined && !Array.isArray(raw)) {
    warnings.push(`Ignoring ${file}: "targets" must be an array`);
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (specs.length >= MAX_CUSTOM_TARGETS) {
        warnings.push(`Ignoring the rest of ${file}: at most ${MAX_CUSTOM_TARGETS} custom targets are loaded`);
        break;
      }
      const errors = validateCustomTargetSpec(entry, builtins);
      if (errors.length > 0) {
        const label = (entry as { id?: unknown } | null)?.id;
        warnings.push(`Skipping custom target ${show(label ?? '<no id>')}: ${errors[0]}`);
        continue;
      }
      const spec = entry as CustomTargetSpec;
      if (seen.has(spec.id)) {
        warnings.push(`Skipping a second custom target ${show(spec.id)}: the first one wins`);
        continue;
      }
      seen.add(spec.id);
      specs.push(spec);
      targets.push(buildCustomTarget(spec));
    }
  }

  for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  cache = { key, loaded: { targets, specs, warnings } };
  return cache.loaded;
}

/** The family of a loaded custom target, or undefined for a builtin or unknown id. */
export function customTargetFamily(id: string, builtins: readonly AgentTarget[]): CustomTargetFamily | undefined {
  return loadCustomTargets(builtins).specs.find((spec) => spec.id === id)?.family;
}

/**
 * Add a spec for `codegraph targets add`, replacing one with the same id.
 * Strict: an invalid spec, or a file that can't be read, throws and nothing
 * is written. Returns whether the id was already there.
 */
export function addCustomTargetSpec(spec: unknown, builtins: readonly AgentTarget[]): { replaced: boolean } {
  const errors = validateCustomTargetSpec(spec, builtins);
  if (errors.length > 0) {
    throw new Error(`Invalid custom target spec:\n  - ${errors.join('\n  - ')}`);
  }
  const valid = spec as CustomTargetSpec;
  const file = targetsFilePath();
  let parsed: { targets?: unknown };
  try {
    parsed = readTargetsFile() ?? {};
  } catch (err) {
    throw new Error(`Cannot update ${file}, fix or remove it first: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list: unknown[] = Array.isArray(parsed.targets) ? parsed.targets : [];
  const at = list.findIndex((t) => (t as { id?: unknown } | null)?.id === valid.id);
  const replaced = at !== -1;
  if (replaced) list[at] = valid;
  else list.push(valid);
  atomicWriteFileSync(file, `${JSON.stringify({ ...parsed, targets: list }, null, 2)}\n`);
  resetCustomTargetsCache();
  return { replaced };
}

/** Remove the spec with `id` for `codegraph targets remove`. Returns whether one was there. */
export function removeCustomTargetSpec(id: string): { removed: boolean } {
  const file = targetsFilePath();
  let parsed: { targets?: unknown } | null;
  try {
    parsed = readTargetsFile();
  } catch (err) {
    throw new Error(`Cannot update ${file}, fix or remove it first: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || !Array.isArray(parsed.targets)) return { removed: false };
  const rest = parsed.targets.filter((t) => (t as { id?: unknown } | null)?.id !== id);
  if (rest.length === parsed.targets.length) return { removed: false };
  atomicWriteFileSync(file, `${JSON.stringify({ ...parsed, targets: rest }, null, 2)}\n`);
  resetCustomTargetsCache();
  return { removed: true };
}

/** The locations a target supports, for `codegraph targets list`. */
export function supportedLocations(target: AgentTarget): Location[] {
  return (['global', 'local'] as const).filter((loc) => target.supportsLocation(loc));
}
