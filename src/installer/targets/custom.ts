/**
 * User-defined custom installer targets (#1272, #1324).
 *
 * A custom target is a small declarative spec naming a **family** —
 * one of the config shapes CodeGraph already knows how to write — plus
 * the paths that identify the agent. Specs live in
 * `~/.codegraph/targets.json` (override: `CODEGRAPH_TARGETS_FILE`),
 * are managed by `codegraph targets add|list|remove`, and are merged
 * into the registry (`./registry.ts` → `getAllTargets()`) so
 * `codegraph install --target <id>`, `auto`/`all`, the interactive
 * multiselect, uninstall's sweep, and `--print-config` all see them.
 *
 * A spec never says *what* to write — only *where*, under a family's
 * rules. That's what keeps the installer contract (sibling
 * preservation, byte-identical idempotent re-runs, uninstall reverses
 * install) provable per family instead of per spec. Design:
 * docs/design/custom-installer-targets.md.
 *
 * Loading is tolerant — an invalid spec is skipped with a one-line
 * warning, never a crash (the installer must keep working for the
 * built-ins). `addCustomTargetSpec` is strict and throws.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentTarget } from './types';
import { atomicWriteFileSync } from './shared';
import { createOpencodeFamilyTarget } from './opencode-family';
import { createTomlFamilyTarget } from './toml-family';
import { createMcpJsonFamilyTarget } from './mcp-json-family';

export type CustomTargetFamily = 'opencode' | 'toml' | 'mcp-json';

export interface CustomTargetSpec {
  /** Registry id, used as `--target <id>`. `^[a-z][a-z0-9-]{0,31}$`. */
  id: string;
  /** Shown in prompts and log lines. Defaults to `id`. */
  displayName?: string;
  family: CustomTargetFamily;
  docsUrl?: string;

  // --- family: opencode ---
  /** App identity: `~/.config/<appName>/<appName>.jsonc`. */
  appName?: string;
  /** Optional `$schema` URL stamped into fresh configs. */
  schemaUrl?: string;

  // --- families: toml, mcp-json ---
  /** Global config dir; absolute or `~/`-prefixed. */
  configDir?: string;
  /** Config file basename (default: 'config.toml' / 'settings.json'). */
  configFileName?: string;
  /** Project-local config dir name; absent = global-only. */
  localConfigDir?: string;

  // --- family: toml ---
  /** Env var overriding `configDir` when set (e.g. GROK_HOME). */
  homeEnvVar?: string;

  // --- family: mcp-json ---
  /** Top-level servers key. Default 'mcpServers'. */
  serversKey?: string;
  /** Instructions basename; default 'AGENTS.md', null disables. */
  instructionsFileName?: string | null;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_IDS = new Set(['auto', 'all', 'none', 'custom']);
const FAMILIES: readonly CustomTargetFamily[] = ['opencode', 'toml', 'mcp-json'];
// Single path segment — no separators, no traversal.
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function targetsFilePath(): string {
  const override = process.env.CODEGRAPH_TARGETS_FILE;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.codegraph', 'targets.json');
}

/**
 * Validate one spec against `builtinIds`. Returns error strings —
 * empty array means valid. Kept as data (not throws) so the tolerant
 * loader and the strict `targets add` path share one implementation.
 */
export function validateCustomTargetSpec(spec: unknown, builtinIds: readonly string[]): string[] {
  const errors: string[] = [];
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['spec must be a JSON object'];
  }
  const s = spec as Record<string, unknown>;

  if (typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) {
    errors.push(`"id" must match ${ID_PATTERN} (got ${JSON.stringify(s.id)})`);
  } else if (RESERVED_IDS.has(s.id)) {
    errors.push(`"id" ${JSON.stringify(s.id)} is reserved`);
  } else if (builtinIds.includes(s.id)) {
    errors.push(`"id" ${JSON.stringify(s.id)} collides with a built-in target`);
  }

  if (typeof s.family !== 'string' || !FAMILIES.includes(s.family as CustomTargetFamily)) {
    errors.push(`"family" must be one of ${FAMILIES.join(', ')} (got ${JSON.stringify(s.family)})`);
    return errors; // family-specific checks below are meaningless
  }

  if (s.displayName !== undefined && (typeof s.displayName !== 'string' || !s.displayName.trim())) {
    errors.push('"displayName" must be a non-empty string when present');
  }

  if (s.family === 'opencode') {
    if (typeof s.appName !== 'string' || !SEGMENT_PATTERN.test(s.appName)
        || s.appName === '.' || s.appName === '..') {
      errors.push(`"appName" is required for the opencode family and must be a single path segment (got ${JSON.stringify(s.appName)})`);
    }
  } else {
    // toml + mcp-json
    if (typeof s.configDir !== 'string' || !s.configDir.trim()) {
      errors.push(`"configDir" is required for the ${s.family} family`);
    } else if (!s.configDir.startsWith('~') && !path.isAbsolute(s.configDir)) {
      errors.push(`"configDir" must be absolute or ~/-prefixed (got ${JSON.stringify(s.configDir)})`);
    }
    if (s.localConfigDir !== undefined) {
      const localOk = typeof s.localConfigDir === 'string'
        && s.localConfigDir.trim().length > 0
        && !path.isAbsolute(s.localConfigDir)
        && !s.localConfigDir.split(/[\\/]/).some((seg) => seg === '..' || seg === '');
      if (!localOk) {
        errors.push(`"localConfigDir" must be a relative path with no ".." (got ${JSON.stringify(s.localConfigDir)})`);
      }
    }
    if (s.configFileName !== undefined
        && (typeof s.configFileName !== 'string' || !SEGMENT_PATTERN.test(s.configFileName))) {
      errors.push(`"configFileName" must be a single file name (got ${JSON.stringify(s.configFileName)})`);
    }
  }

  if (s.family === 'mcp-json' && s.instructionsFileName !== undefined && s.instructionsFileName !== null
      && (typeof s.instructionsFileName !== 'string' || !SEGMENT_PATTERN.test(s.instructionsFileName))) {
    errors.push(`"instructionsFileName" must be a single file name or null (got ${JSON.stringify(s.instructionsFileName)})`);
  }

  return errors;
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
        // sweepLegacyWindowsAppData deliberately not spec-exposed —
        // only the built-in opencode target has a pre-#535 install base.
      });
    case 'toml':
      return createTomlFamilyTarget({
        id: spec.id,
        displayName,
        docsUrl: spec.docsUrl,
        configDir: spec.configDir!,
        homeEnvVar: spec.homeEnvVar,
        localConfigDir: spec.localConfigDir,
        configFileName: spec.configFileName,
      });
    case 'mcp-json':
      return createMcpJsonFamilyTarget({
        id: spec.id,
        displayName,
        docsUrl: spec.docsUrl,
        configDir: spec.configDir!,
        localConfigDir: spec.localConfigDir,
        configFileName: spec.configFileName,
        serversKey: spec.serversKey,
        instructionsFileName: spec.instructionsFileName,
      });
  }
}

/** Tolerant read: `null` when missing, throws only on unparseable JSON. */
function readTargetsFile(): { targets?: unknown } | null {
  const file = targetsFilePath();
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('top-level value must be an object');
  }
  return parsed;
}

export interface LoadedCustomTargets {
  targets: AgentTarget[];
  specs: CustomTargetSpec[];
  /** One line per skipped spec / unreadable file — caller decides where to surface them. */
  warnings: string[];
}

let cache: LoadedCustomTargets | null = null;

/** Test hook — the loader caches per-process. */
export function resetCustomTargetsCache(): void {
  cache = null;
}

/**
 * Load, validate, and instantiate every custom target. Tolerant:
 * invalid specs and an unreadable file degrade to warnings, never a
 * crash. Warnings are printed to stderr exactly once per process
 * (the registry calls this from several paths).
 */
export function loadCustomTargets(builtinIds: readonly string[]): LoadedCustomTargets {
  if (cache) return cache;

  const targets: AgentTarget[] = [];
  const specs: CustomTargetSpec[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  let parsed: { targets?: unknown } | null = null;
  try {
    parsed = readTargetsFile();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Ignoring ${targetsFilePath()}: ${msg}`);
  }

  const raw = parsed?.targets;
  if (raw !== undefined && !Array.isArray(raw)) {
    warnings.push(`Ignoring ${targetsFilePath()}: "targets" must be an array`);
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      const errors = validateCustomTargetSpec(entry, builtinIds);
      if (errors.length > 0) {
        const label = (entry as any)?.id ?? '<no id>';
        warnings.push(`Skipping custom target ${JSON.stringify(label)}: ${errors[0]}`);
        continue;
      }
      const spec = entry as CustomTargetSpec;
      if (seen.has(spec.id)) {
        warnings.push(`Skipping duplicate custom target ${JSON.stringify(spec.id)} (first definition wins)`);
        continue;
      }
      seen.add(spec.id);
      specs.push(spec);
      targets.push(buildCustomTarget(spec));
    }
  }

  for (const w of warnings) console.warn(`  Warning: ${w}`);
  cache = { targets, specs, warnings };
  return cache;
}

/**
 * Strict upsert for `codegraph targets add`. Throws on an invalid
 * spec or an unparseable targets file (never clobbers a file we can't
 * read). Returns whether the id already existed.
 */
export function addCustomTargetSpec(spec: CustomTargetSpec, builtinIds: readonly string[]): { replaced: boolean } {
  const errors = validateCustomTargetSpec(spec, builtinIds);
  if (errors.length > 0) {
    throw new Error(`Invalid custom target spec:\n  - ${errors.join('\n  - ')}`);
  }
  const file = targetsFilePath();
  let parsed: { targets?: unknown };
  try {
    parsed = readTargetsFile() ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot update ${file} — fix or remove it first: ${msg}`);
  }
  const list: unknown[] = Array.isArray(parsed.targets) ? parsed.targets : [];
  const idx = list.findIndex((t) => (t as any)?.id === spec.id);
  const replaced = idx !== -1;
  if (replaced) list[idx] = spec;
  else list.push(spec);
  atomicWriteFileSync(file, JSON.stringify({ ...parsed, targets: list }, null, 2) + '\n');
  resetCustomTargetsCache();
  return { replaced };
}

/** Strict removal for `codegraph targets remove`. Returns whether the id was present. */
export function removeCustomTargetSpec(id: string): { removed: boolean } {
  const file = targetsFilePath();
  let parsed: { targets?: unknown } | null;
  try {
    parsed = readTargetsFile();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot update ${file} — fix or remove it first: ${msg}`);
  }
  if (!parsed || !Array.isArray(parsed.targets)) return { removed: false };
  const next = parsed.targets.filter((t) => (t as any)?.id !== id);
  if (next.length === parsed.targets.length) return { removed: false };
  atomicWriteFileSync(file, JSON.stringify({ ...parsed, targets: next }, null, 2) + '\n');
  resetCustomTargetsCache();
  return { removed: true };
}
