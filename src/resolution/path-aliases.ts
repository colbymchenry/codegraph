/**
 * Project-level import-path alias loading.
 *
 * Reads `compilerOptions.paths` from `tsconfig.json` / `jsconfig.json`
 * at the project root and converts the patterns into a form the
 * import-resolver can consult.
 *
 * This is the single biggest blocker to accurate resolution on modern
 * JS/TS codebases: aliases like `@/components/Foo` (Next, Nuxt, Nest,
 * Vite scaffolds) point into a `paths` map the resolver previously
 * ignored — every import through an alias was treated as unresolvable
 * unless it happened to match the small hard-coded fallback list.
 *
 * Scope:
 *   - reads tsconfig.json, then jsconfig.json, then tsconfig.base.json
 *   - honours `compilerOptions.baseUrl` and `compilerOptions.paths`; a
 *     `baseUrl` with no `paths` still loads, because it alone makes
 *     `layout/MainLayout` name `src/layout/MainLayout` (CRA / Vite admin
 *     templates)
 *   - follows `extends` chains, nearest config wins (#1534) — Nx-style
 *     monorepos keep every alias in a `tsconfig.base.json` the root
 *     config merely inherits, so without this they resolved nothing
 *   - supports `*` wildcard (the only TS-supported wildcard)
 *   - does NOT read Vite/webpack/Rollup configs (separate follow-up)
 *
 * The file is parsed as JSON-with-comments-tolerant — tsconfigs in the
 * wild routinely contain `//` and `/* *\/` comments and trailing
 * commas, which JSON.parse rejects. We strip those before parsing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';
import { escapesRoot } from '../utils';

/** A single alias pattern from `compilerOptions.paths`. */
export interface AliasPattern {
  /** The literal prefix before `*` (or the whole pattern if no `*`). */
  prefix: string;
  /** The literal suffix after `*` (almost always empty). */
  suffix: string;
  /** Whether the pattern contains a `*` wildcard. */
  hasWildcard: boolean;
  /**
   * Replacement templates. When `hasWildcard` is true, `*` in the
   * replacement is filled with the captured wildcard portion of the
   * import path. Stored relative to {@link AliasMap.baseUrl}.
   * tsconfig allows multiple targets per alias (priority order).
   */
  replacements: string[];
}

export interface AliasMap {
  /** Absolute path. The directory `compilerOptions.paths` is rooted at. */
  baseUrl: string;
  /**
   * Whether the config (or one it extends) sets `compilerOptions.baseUrl`.
   * A non-relative specifier is then also read from {@link baseUrl}, after
   * `paths`, the way tsc reads it. `paths` alone anchors only its own
   * targets (TypeScript 4.1+), so a map without a `baseUrl` never does.
   */
  declaresBaseUrl?: boolean;
  /**
   * Patterns ordered by specificity: longer prefix first, then literal-
   * before-wildcard, so the resolver tries the most-specific match.
   * Empty for a config that sets only `baseUrl`.
   */
  patterns: AliasPattern[];
}

/**
 * Strip JSONC comments + trailing commas so a tsconfig with the usual
 * VS Code-style annotations parses cleanly. Walks the source as a
 * tiny state machine that tracks string context — the previous
 * regex-only version corrupted any URL inside a string value
 * (`"baseUrl": "https://cdn.example.com"` had everything after `//`
 * truncated).
 */
function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Trailing commas before } or ] — outside strings, so safe to
  // run on the comment-stripped output.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

interface RawTsconfig {
  extends?: string | string[];
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

/**
 * The `baseUrl`/`paths` a config ends up with once its `extends` chain has
 * been folded in. `pathsDir` is the directory of the config that actually
 * declared `paths` — with no `baseUrl` anywhere, tsc anchors the targets
 * there, not at the project root.
 */
interface EffectiveOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsDir?: string;
}

/** Guards against a pathological chain; real ones are 1-3 deep. */
const MAX_EXTENDS_DEPTH = 32;

/**
 * Locate an `extends` target the way tsc does: `./x`-style values are
 * relative to the referencing config, anything else is a node_modules
 * package specifier resolved by walking up from that config. A missing
 * `.json` extension is implied, and a bare package name means its
 * `tsconfig.json`.
 */
function resolveExtendsTarget(spec: string, fromDir: string): string | null {
  const isFile = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  if (spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec)) {
    const base = path.resolve(fromDir, spec);
    for (const cand of [base, `${base}.json`, path.join(base, 'tsconfig.json')]) {
      if (isFile(cand)) return cand;
    }
    return null;
  }

  let dir = fromDir;
  for (;;) {
    const base = path.join(dir, 'node_modules', spec);
    for (const cand of [base, `${base}.json`, path.join(base, 'tsconfig.json')]) {
      if (isFile(cand)) return cand;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read `filePath` and fold its `extends` chain into a single set of
 * effective options. Parents are applied first and the nearest config
 * wins — tsc replaces `paths` wholesale rather than merging it.
 *
 * `stack` holds the configs currently being resolved, so a cycle
 * (`a extends b extends a`) stops instead of recursing forever.
 */
function loadEffectiveOptions(
  filePath: string,
  stack: Set<string>,
  depth: number,
  read?: Set<string>
): EffectiveOptions | null {
  const abs = path.resolve(filePath);
  if (stack.has(abs) || depth > MAX_EXTENDS_DEPTH) {
    logDebug('path-aliases: extends chain cycle or too deep', { filePath: abs, depth });
    return null;
  }
  read?.add(abs);
  const raw = readTsconfigLike(abs);
  if (!raw) return null;

  stack.add(abs);
  const dir = path.dirname(abs);
  const effective: EffectiveOptions = {};

  const parents = typeof raw.extends === 'string' ? [raw.extends] : (raw.extends ?? []);
  for (const spec of parents) {
    if (typeof spec !== 'string') continue;
    const target = resolveExtendsTarget(spec, dir);
    if (!target) {
      logDebug('path-aliases: unresolved extends', { from: abs, spec });
      continue;
    }
    const inherited = loadEffectiveOptions(target, stack, depth + 1, read);
    if (!inherited) continue;
    if (inherited.baseUrl !== undefined) effective.baseUrl = inherited.baseUrl;
    if (inherited.paths !== undefined) {
      effective.paths = inherited.paths;
      effective.pathsDir = inherited.pathsDir;
    }
  }
  stack.delete(abs);

  const co = raw.compilerOptions ?? {};
  // Both are relative to the file that declared them, not to whichever
  // config started the chain.
  if (typeof co.baseUrl === 'string') effective.baseUrl = path.resolve(dir, co.baseUrl);
  if (co.paths && typeof co.paths === 'object') {
    effective.paths = co.paths;
    effective.pathsDir = dir;
  }
  return effective;
}

function readTsconfigLike(filePath: string): RawTsconfig | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(stripJsonc(raw)) as RawTsconfig;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    logDebug('path-aliases: failed to parse', { filePath, err: String(err) });
    return null;
  }
}

/**
 * What {@link loadProjectAliases} reads from one config file, its `extends`,
 * `compilerOptions.baseUrl` and `compilerOptions.paths`, as one string, or
 * `null` for a file it can't read. A sync compares it to tell an edit that
 * moves the alias map from one that doesn't, like a `strict` flag (#2977).
 */
export function aliasConfigFields(filePath: string): string | null {
  const raw = readTsconfigLike(path.resolve(filePath));
  if (!raw) return null;
  const co = raw.compilerOptions ?? {};
  return JSON.stringify([raw.extends ?? null, co.baseUrl ?? null, co.paths ?? null]);
}

function splitWildcard(pattern: string): {
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
} {
  const star = pattern.indexOf('*');
  if (star === -1) return { prefix: pattern, suffix: '', hasWildcard: false };
  return {
    prefix: pattern.slice(0, star),
    suffix: pattern.slice(star + 1),
    hasWildcard: true,
  };
}

/**
 * Load aliases for `projectRoot`. Returns `null` when no tsconfig /
 * jsconfig is present or when the file has neither usable `paths` nor a
 * `baseUrl`.
 *
 * Cheap to call repeatedly — caching is the caller's job (the
 * resolver does it via {@link aliasCache}). `read` collects the absolute
 * path of every config file the load read, the `extends` chain included, so
 * the caller can tell when one of them changes (#2977).
 */
export function loadProjectAliases(projectRoot: string, read?: Set<string>): AliasMap | null {
  // `tsconfig.base.json` comes last on purpose: when a root `tsconfig.json`
  // exists it stays authoritative and reaches the base through `extends`.
  // The fallback is for the Nx layouts where that never happens — a
  // solution-style root config (`references`, no `extends`, no `paths`), or
  // no root `tsconfig.json` at all.
  const candidates = ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json'];
  let effective: EffectiveOptions | null = null;
  let usedFile: string | null = null;
  for (const name of candidates) {
    const p = path.join(projectRoot, name);
    if (!fs.existsSync(p)) continue;
    const opts = loadEffectiveOptions(p, new Set(), 0, read);
    if (!opts) continue;
    // Remember the first readable config so a `paths`-less project still
    // logs the file it was judged on, but keep looking: a config that
    // contributes no aliases must not shadow one that does.
    if (!effective) {
      effective = opts;
      usedFile = name;
    }
    if (opts.paths) {
      effective = opts;
      usedFile = name;
      break;
    }
  }
  if (!effective) return null;

  // With no explicit baseUrl, `paths` targets are relative to the config that
  // declared them — which is the project root only when that config is the
  // root one (the pre-`extends` assumption).
  const baseUrl = effective.baseUrl ?? effective.pathsDir ?? projectRoot;
  const declaresBaseUrl = effective.baseUrl !== undefined;

  const patterns: AliasPattern[] = [];
  const paths = effective.paths;
  if (paths && typeof paths === 'object') {
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const filtered = targets.filter((t): t is string => typeof t === 'string');
      if (filtered.length === 0) continue;
      const { prefix, suffix, hasWildcard } = splitWildcard(pattern);
      patterns.push({ prefix, suffix, hasWildcard, replacements: filtered });
    }
  }

  // A `baseUrl` with no `paths` is still a map: the resolver reads a bare
  // specifier from it, but only one that names a project file and no package
  // the app depends on (see resolveFromOwnConfig in import-resolver.ts).
  if (patterns.length === 0 && !declaresBaseUrl) return null;

  // Specificity sort: longer prefix first; literal patterns before
  // wildcard patterns of the same prefix length. TypeScript itself
  // uses a similar "most specific match wins" rule.
  patterns.sort((a, b) => {
    if (a.prefix.length !== b.prefix.length) return b.prefix.length - a.prefix.length;
    if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
    return 0;
  });

  logDebug('path-aliases loaded', {
    file: usedFile,
    baseUrl,
    declaresBaseUrl,
    patternCount: patterns.length,
  });

  return { baseUrl, declaresBaseUrl, patterns };
}

/**
 * Resolve an import path through an {@link AliasMap}. Returns the list
 * of candidate filesystem paths (relative to `projectRoot`), in the
 * priority order defined by tsconfig (multiple replacements per alias
 * are tried in order). Returns `[]` when no alias matches.
 *
 * Callers still need to try each candidate with the language's
 * extension list — this function only does the alias rewrite.
 */
export function applyAliases(
  importPath: string,
  aliases: AliasMap,
  projectRoot: string
): string[] {
  for (const pat of aliases.patterns) {
    if (!importPath.startsWith(pat.prefix)) continue;
    if (pat.suffix && !importPath.endsWith(pat.suffix)) continue;

    let captured = '';
    if (pat.hasWildcard) {
      // The prefix and the suffix may not share characters. `@x/*/index`
      // both starts and ends `@x/index` only by counting its one `/` twice,
      // which leaves nothing for `*` to stand on. tsc's `isPatternMatch`
      // wants the specifier at least as long as the two together, so this
      // pattern is skipped and a less specific one may still match.
      if (importPath.length < pat.prefix.length + pat.suffix.length) continue;
      captured = importPath.slice(pat.prefix.length, importPath.length - pat.suffix.length);
    } else if (importPath !== pat.prefix) {
      // Literal pattern must match exactly.
      continue;
    }

    const out: string[] = [];
    for (const target of pat.replacements) {
      const filled = pat.hasWildcard ? target.replace('*', captured) : target;
      // baseUrl is absolute; produce a path relative to projectRoot
      const absolute = path.resolve(aliases.baseUrl, filled);
      const relative = path.relative(projectRoot, absolute);
      // Skip if the rewrite escapes the project root (unsafe + can't
      // be looked up via the file index anyway). A folder named like
      // `..generated` is inside it.
      if (escapesRoot(relative)) continue;
      out.push(relative.replace(/\\/g, '/'));
    }
    return out;
  }
  return [];
}

/**
 * Where a non-relative specifier can live under `aliases`, in the order tsc
 * tries them: the targets of the most specific pattern it matches, then the
 * specifier read from `baseUrl` when the config declares one. Relative to
 * `projectRoot`; a candidate that escapes it is dropped.
 */
export function aliasAndBaseUrlCandidates(
  importPath: string,
  aliases: AliasMap,
  projectRoot: string
): string[] {
  const out = applyAliases(importPath, aliases, projectRoot);
  if (aliases.declaresBaseUrl) {
    const relative = path.relative(projectRoot, path.resolve(aliases.baseUrl, importPath));
    if (relative && !escapesRoot(relative)) {
      out.push(relative.replace(/\\/g, '/'));
    }
  }
  return out;
}
