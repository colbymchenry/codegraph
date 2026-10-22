/**
 * JS/TS workspace (monorepo) package resolution.
 *
 * npm / yarn / bun read member packages from the root `package.json`
 * `workspaces` field; pnpm from `pnpm-workspace.yaml`. A cross-package
 * import like `@scope/ui/widgets` is LOCAL to the monorepo, but to a
 * single-package resolver it looks exactly like a third-party npm
 * specifier — so `isExternalImport` flags it external and the
 * consumer↔definition edge is never created. For component barrels
 * (`export { default as X } from './x.svelte'`) that surfaces as a false
 * `0 callers` on a live component (issue #629).
 *
 * This module maps each member package's declared `name` to its
 * directory, and its package.json's declared entries (`exports`, `main`,
 * `module`, `types`) to files, so the resolver can rewrite `@scope/ui` →
 * `packages/ui/src/index.ts` and `@scope/ui/widgets` → the file its
 * `exports` names, or `packages/ui/widgets` with normal extension/index
 * resolution when the manifest names none (#2502).
 *
 *   - reads `workspaces` (array OR `{ packages: [...] }`) from package.json,
 *     plus a minimal `pnpm-workspace.yaml` `packages:` list
 *   - expands `*`, `?` and `{a,b}` within a folder name and `**` across
 *     folders (`packages/*`, pnpm's nested `packages/**\/*`), and leaves out
 *     what a negated glob (`!**\/example`) matches
 *   - reads the sibling packages a package.json depends on by path
 *     (`"acme-shared": "file:../common"`, `link:`, `portal:`), which need no
 *     workspace declaration at all: the root manifest's for every file, any
 *     other's for the files under it, as npm installs a package's
 *     dependencies for that package (#2456)
 *   - returns null when the project declares none of these, so single-
 *     package repos pay nothing and see no behaviour change.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';

export interface WorkspacePackages {
  /**
   * Package `name` → directory relative to projectRoot (posix): the workspace
   * members, ohpm's `file:` dependencies, and the root package.json's path
   * dependencies.
   */
  byName: Map<string, string>;
  /**
   * Member package `name` → its declared ENTRY FILE relative to projectRoot
   * (posix), when the member's manifest names one (ohpm's oh-package.json5
   * `"main": "Index.ets"`). Lets a bare `import { X } from "data"` resolve to
   * the member's real barrel even when it doesn't follow an index-file
   * convention — and independent of the CONSUMER's language (a `.ts` file
   * importing an `.ets` barrel resolves without `.ets` in the TS candidate
   * list). npm/pnpm packages use `entriesByDir`.
   */
  entryByName?: Map<string, string>;
  /**
   * The entries an npm/pnpm/yarn/bun package's package.json declares, by the
   * package's directory (see PackageEntries).
   */
  entriesByDir?: Map<string, PackageEntries>;
  /**
   * The path dependencies a package.json below the root declares: its
   * directory → dependency name → target directory (all projectRoot-relative
   * posix). Seen only from the files under that manifest — a test fixture's
   * `"left-pad": "file:../stub"` is the fixture's own, and `left-pad` stays the
   * npm package for everyone else. The root manifest's are in `byName`.
   */
  scopedByName?: Map<string, Map<string, string>>;
}

/**
 * What a package.json declares a package's importers reach, as targets
 * relative to projectRoot (posix), best candidate first. A target may name
 * build output the index does not hold; the resolver then reads the source it
 * is built from, where that is clear.
 */
export interface PackageEntries {
  /**
   * The `exports` map: `.`, `./utils`, `./schema/*` → targets. A string, an
   * array or a conditions-only `exports` is the `.` entry. A key mapped to
   * `null` (not exported) holds no target.
   */
  exports?: Map<string, string[]>;
  /**
   * The package root's `source`, `module`, `main`, `types` and `typings`
   * fields, read after `exports` (as TypeScript's older `node` resolution
   * reads them in its place).
   */
  main?: string[];
}

/** Where an import of a workspace or path-dependency package lands, before any file is probed. */
export interface WorkspaceImportTargets {
  /**
   * The entries the package declares for the import, best first: what
   * `exports` names for it in condition order, then, for the package root,
   * its `main`-style fields.
   */
  declared: string[];
  /** The package's directory plus the import's subpath (`packages/ui/widgets`), extension-less. */
  directory: string;
  /** The package's directory. */
  packageDir: string;
}

/**
 * Load workspace member packages for `projectRoot`. Returns `null` when
 * the project declares no workspaces and no package depends on another by
 * path (the common single-package case) — callers then skip all workspace
 * logic.
 *
 * Cheap to call repeatedly only via the resolver's per-instance cache;
 * this function itself touches the filesystem, so the resolver memoises it
 * the same way it does {@link loadProjectAliases} / {@link loadGoModule}.
 */
export function loadWorkspacePackages(projectRoot: string): WorkspacePackages | null {
  const byName = new Map<string, string>();

  const patterns = readWorkspaceGlobs(projectRoot);
  // What a negated glob matches (`!examples/with-nx`, pnpm's `!**/example`) is
  // no member, wherever the glob is listed.
  const excluded = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    for (const dir of expandWorkspaceGlob(projectRoot, pattern)) {
      if (excluded.some((x) => workspaceGlobMatches(x, dir))) continue;
      const pkgName = readPackageName(path.join(projectRoot, dir));
      // First declaration wins — workspace patterns are tried in order.
      if (pkgName && !byName.has(pkgName)) byName.set(pkgName, dir);
    }
  }

  // HarmonyOS/OpenHarmony (ArkTS) modular projects: every module's
  // oh-package.json5 declares its local siblings as `"data": "file:../../
  // core/data"` dependencies, and code then imports the bare name
  // (`import { CartRepository } from "data"`). Same monorepo problem as npm
  // workspaces, different manifest. An npm package does the same with
  // `"acme-shared": "file:../common"` and no root `workspaces` (#2456).
  const { ohpm, npm } = collectPathDeps(projectRoot);
  const entryByName = new Map<string, string>();
  for (const [name, dir] of ohpm) {
    if (byName.has(name)) continue;
    byName.set(name, dir);
    const entry = readOhpmMain(projectRoot, dir);
    if (entry) entryByName.set(name, entry);
  }
  for (const [name, dir] of npm.get('') ?? []) {
    if (!byName.has(name)) byName.set(name, dir);
  }
  npm.delete('');

  if (byName.size === 0 && npm.size === 0) return null;

  // What each npm-style package's manifest declares for its importers.
  const entriesByDir = new Map<string, PackageEntries>();
  const packageDirs = new Set(byName.values());
  for (const names of npm.values()) for (const dir of names.values()) packageDirs.add(dir);
  for (const dir of packageDirs) {
    const entries = readPackageEntries(projectRoot, dir);
    if (entries) entriesByDir.set(dir, entries);
  }

  logDebug('workspace packages loaded', { count: byName.size, scoped: npm.size, entries: entriesByDir.size });
  return {
    byName,
    entryByName: entryByName.size > 0 ? entryByName : undefined,
    entriesByDir: entriesByDir.size > 0 ? entriesByDir : undefined,
    scopedByName: npm.size > 0 ? npm : undefined,
  };
}

/**
 * Condition keys an `exports` target is read through first: the ones
 * TypeScript and the bundlers resolve by. Any other condition (`browser`,
 * `development`, a custom `@acme/source`) comes next, and `types`/`typings`
 * last — a declaration file is the package as tsc reads it, the
 * implementation is what its importers run.
 */
const RESOLVING_CONDITIONS = new Set(['import', 'require', 'node', 'module', 'module-sync', 'default']);
const TYPE_CONDITIONS = new Set(['types', 'typings']);

/** An `exports` value's targets, best first: a string, a fallback array, or (nested) conditions, by key order within each tier. */
function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (!value || typeof value !== 'object') return [];
  const conditions = Object.entries(value as Record<string, unknown>);
  const tier = (key: string): number => (RESOLVING_CONDITIONS.has(key) ? 0 : TYPE_CONDITIONS.has(key) ? 2 : 1);
  return [0, 1, 2].flatMap((t) => conditions.filter(([key]) => tier(key) === t).flatMap(([, v]) => exportTargets(v)));
}

/** The package.json fields an importer of the package root reaches without `exports`, best first. */
const MAIN_FIELDS = ['source', 'module', 'main', 'types', 'typings'];

/** Read a package's declared entries (see PackageEntries); null when its manifest declares none. */
function readPackageEntries(projectRoot: string, dirRel: string): PackageEntries | null {
  let pkg: Record<string, unknown> | null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, dirRel, 'package.json'), 'utf-8')) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== 'object') return null;
  const inPackage = (target: string): string | null => packageTarget(projectRoot, dirRel, target);
  const out: PackageEntries = {};
  const exp = pkg.exports;
  if (exp !== undefined && exp !== null) {
    const exports = new Map<string, string[]>();
    const subpaths = typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((key) => key.startsWith('.'));
    const entries: Array<[string, unknown]> = subpaths
      ? Object.entries(exp as Record<string, unknown>).filter(([key]) => key.startsWith('.'))
      : [['.', exp]];
    for (const [key, value] of entries) {
      exports.set(key, [...new Set(exportTargets(value).map(inPackage).filter((t): t is string => t !== null))]);
    }
    out.exports = exports;
  }
  const main = MAIN_FIELDS
    .map((field) => pkg![field])
    .filter((value): value is string => typeof value === 'string')
    .map(inPackage)
    .filter((t): t is string => t !== null);
  if (main.length > 0) out.main = [...new Set(main)];
  return out.exports || out.main ? out : null;
}

/** A package-relative target (`./src/index.ts`) → projectRoot-relative posix, or null if it leaves the package. */
function packageTarget(projectRoot: string, dirRel: string, target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  const packageDir = path.resolve(projectRoot, dirRel);
  const abs = path.resolve(packageDir, trimmed);
  const inside = path.relative(packageDir, abs);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return path.relative(projectRoot, abs).replace(/\\/g, '/');
}

/**
 * Read an ohpm member's declared entry file: `<dir>/oh-package.json5`'s
 * `main`, normalized to a projectRoot-relative posix path. Null when the
 * manifest or field is missing/escaping.
 */
function readOhpmMain(projectRoot: string, dirRel: string): string | null {
  let parsed: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    parsed = require('jsonc-parser').parse(
      fs.readFileSync(path.join(projectRoot, dirRel, OHPM_MANIFEST), 'utf-8')
    );
  } catch {
    return null;
  }
  const main = (parsed as { main?: unknown } | null)?.main;
  if (typeof main !== 'string' || !main.trim()) return null;
  const entryAbs = path.resolve(projectRoot, dirRel, main.trim());
  const entryRel = path.relative(projectRoot, entryAbs).replace(/\\/g, '/');
  if (entryRel.startsWith('..')) return null;
  return entryRel;
}

/**
 * Scan the project for `oh-package.json5` manifests and collect their
 * `file:`-protocol dependencies as workspace members: dep name (what the
 * source imports) → target directory (projectRoot-relative posix).
 *
 * Precision rule: a name declared with DIFFERENT target directories in
 * different manifests (e.g. every sample in a samples monorepo has its own
 * "common") is AMBIGUOUS and dropped entirely — a missing edge beats a wrong
 * cross-module link. Registry dependencies (`@ohos/axios: "^2.0.0"`) don't
 * use `file:` and are ignored, staying external.
 *
 * The same walk reads every package.json's `file:`, `link:` and `portal:`
 * dependencies (#2456), by the directory of the manifest that declares them
 * (`''` for the root): npm installs a package's dependencies for that package,
 * so the files under it are the ones that see them. Only a directory of the
 * project counts, other than the root and nothing under `node_modules` — a
 * tarball or a path into installed packages maps nothing.
 *
 * The walk is bounded (depth + directory budget) and prunes build/dependency
 * dirs; a manifest is parsed only where the walk finds one.
 */
const OHPM_MANIFEST = 'oh-package.json5';
const NPM_MANIFEST = 'package.json';
const OHPM_WALK_MAX_DEPTH = 6;
const OHPM_WALK_DIR_BUDGET = 8000;
const OHPM_SKIP_DIRS = new Set([
  'node_modules', 'oh_modules', '.git', '.codegraph', '.hvigor', '.preview',
  'build', 'dist', 'out', 'oh-package-lock.json5',
]);

function collectPathDeps(projectRoot: string): { ohpm: Map<string, string>; npm: Map<string, Map<string, string>> } {
  const ohpm = new Map<string, string>();
  const ambiguous = new Set<string>();
  const npm = new Map<string, Map<string, string>>();

  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const { rel, depth } = queue.shift()!;
    if (++visited > OHPM_WALK_DIR_BUDGET) break;
    const abs = path.join(projectRoot, rel);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth >= OHPM_WALK_MAX_DEPTH) continue;
        if (e.name.startsWith('.') || OHPM_SKIP_DIRS.has(e.name)) continue;
        queue.push({ rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 });
        continue;
      }
      if (e.name === NPM_MANIFEST) {
        const deps = new Map<string, string>();
        for (const [name, target] of readNpmPathDeps(path.join(abs, e.name))) {
          const targetAbs = path.resolve(abs, target);
          const targetRel = path.relative(projectRoot, targetAbs).replace(/\\/g, '/');
          if (targetRel === '' || targetRel.startsWith('..') || path.isAbsolute(targetRel)) continue;
          if (/(?:^|\/)node_modules(?:\/|$)/.test(targetRel) || !isDirectory(targetAbs)) continue;
          deps.set(name, targetRel);
        }
        if (deps.size > 0) npm.set(rel, deps);
        continue;
      }
      if (e.name !== OHPM_MANIFEST) continue;

      const deps = readOhpmFileDeps(path.join(abs, e.name));
      for (const [name, target] of deps) {
        const targetAbs = path.resolve(abs, target);
        const targetRel = path.relative(projectRoot, targetAbs).replace(/\\/g, '/');
        if (targetRel.startsWith('..')) continue; // escapes the project
        const existing = ohpm.get(name);
        if (existing === undefined) {
          if (!ambiguous.has(name)) ohpm.set(name, targetRel);
        } else if (existing !== targetRel) {
          ohpm.delete(name);
          ambiguous.add(name);
        }
      }
    }
  }

  return { ohpm, npm };
}

function isDirectory(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** A package.json's dependencies on a path (`file:`, `link:`, `portal:`), from every dependency field → [name, target]. */
function readNpmPathDeps(manifestAbs: string): Array<[string, string]> {
  let pkg: Record<string, unknown> | null;
  try {
    pkg = JSON.parse(fs.readFileSync(manifestAbs, 'utf-8')) as Record<string, unknown> | null;
  } catch {
    return [];
  }
  if (!pkg || typeof pkg !== 'object') return [];
  const out: Array<[string, string]> = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      const m = typeof value === 'string' ? /^(?:file|link|portal):(.+)$/.exec(value.trim()) : null;
      if (m && m[1]!.trim()) out.push([name, m[1]!.trim()]);
    }
  }
  return out;
}

/** Parse one oh-package.json5's dependencies → [name, file-target] pairs. */
function readOhpmFileDeps(manifestAbs: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let parsed: unknown;
  try {
    // JSON5 tolerates comments and trailing commas; jsonc-parser (already a
    // dependency, used by the opencode installer target) handles both.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    parsed = require('jsonc-parser').parse(fs.readFileSync(manifestAbs, 'utf-8'));
  } catch {
    return out;
  }
  const deps = (parsed as { dependencies?: Record<string, unknown> } | null)?.dependencies;
  if (!deps || typeof deps !== 'object') return out;
  for (const [name, value] of Object.entries(deps)) {
    if (typeof value !== 'string' || !value.startsWith('file:')) continue;
    const target = value.slice('file:'.length).trim();
    if (target) out.push([name, target]);
  }
  return out;
}

/**
 * Rewrite a bare workspace import to a path relative to projectRoot,
 * WITHOUT an extension — the caller applies the language's extension/index
 * resolution. `@scope/ui/widgets` → `packages/ui/widgets`; the bare package
 * name `@scope/ui` → its directory, or the ohpm entry its manifest names.
 * `fromFile`, the importing file, sees the path dependencies the manifests
 * above it declare. Returns `null` when no package name matches.
 */
export function resolveWorkspaceImport(
  importPath: string,
  ws: WorkspacePackages,
  fromFile?: string
): string | null {
  const hit = matchPackage(importPath, ws, fromFile);
  if (!hit) return null;
  const subpath = importPath.slice(hit.name.length); // '' or '/widgets'
  // A bare member import resolves straight to the member's declared entry
  // file when the ohpm manifest names one — the caller's exact-path check
  // hits it without extension/index guessing.
  const ohpm = subpath ? undefined : ws.entryByName?.get(hit.name);
  return ohpm ?? (hit.dir + subpath).replace(/\/{2,}/g, '/');
}

/**
 * Where an import of a package of the project lands (see
 * WorkspaceImportTargets): what its manifest declares for the import, and
 * the directory form. Null when no package name matches.
 */
export function workspaceImportTargets(
  importPath: string,
  ws: WorkspacePackages,
  fromFile?: string
): WorkspaceImportTargets | null {
  const hit = matchPackage(importPath, ws, fromFile);
  if (!hit) return null;
  const subpath = importPath.slice(hit.name.length); // '' or '/widgets'
  const directory = (hit.dir + subpath).replace(/\/{2,}/g, '/');
  const ohpm = subpath ? undefined : ws.entryByName?.get(hit.name);
  const declared = ohpm ? [ohpm] : declaredEntries(ws.entriesByDir?.get(hit.dir), subpath);
  return { declared, directory, packageDir: hit.dir };
}

/**
 * The package an import names: a path dependency of the nearest manifest
 * above `fromFile` that declares a matching name, else a workspace member or
 * a root path dependency. The longest name wins, so `@scope/ui/core` prefers
 * a `@scope/ui/core` package over a `@scope/ui` one when both exist.
 */
function matchPackage(importPath: string, ws: WorkspacePackages, fromFile?: string): { name: string; dir: string } | null {
  const scoped = scopedPackage(importPath, ws, fromFile);
  if (scoped) return scoped;
  const name = longestName(importPath, ws.byName.keys());
  return name === null ? null : { name, dir: ws.byName.get(name)! };
}

/** The path dependency the nearest declaring manifest above `fromFile` maps `importPath` to. */
function scopedPackage(importPath: string, ws: WorkspacePackages, fromFile?: string): { name: string; dir: string } | null {
  if (!fromFile || !ws.scopedByName) return null;
  let dir = fromFile.replace(/\\/g, '/');
  while (dir !== '') {
    const slash = dir.lastIndexOf('/');
    dir = slash < 0 ? '' : dir.slice(0, slash);
    const names = ws.scopedByName.get(dir);
    if (!names) continue;
    const name = longestName(importPath, names.keys());
    if (name !== null) return { name, dir: names.get(name)! };
  }
  return null;
}

function longestName(importPath: string, names: Iterable<string>): string | null {
  let best: string | null = null;
  for (const name of names) {
    if ((importPath === name || importPath.startsWith(name + '/')) && (best === null || name.length > best.length)) best = name;
  }
  return best;
}

/**
 * The targets a package's manifest declares for `subpath` (`''` or
 * `/widgets`), best first: its `exports` entry, then, for the package root,
 * its `main`-style fields.
 */
function declaredEntries(entries: PackageEntries | undefined, subpath: string): string[] {
  if (!entries) return [];
  const exported = entries.exports ? exportedTargets(entries.exports, '.' + subpath) : [];
  return subpath ? exported : [...new Set([...exported, ...(entries.main ?? [])])];
}

/** `exports`' targets for `key`: the exact key's, else the `*` pattern's with the longest prefix, its `*`s filled in. */
function exportedTargets(exports: Map<string, string[]>, key: string): string[] {
  const exact = exports.get(key);
  if (exact) return exact;
  let best: { prefix: string; match: string; targets: string[] } | null = null;
  for (const [pattern, targets] of exports) {
    const star = pattern.indexOf('*');
    if (star < 0 || pattern.indexOf('*', star + 1) >= 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.length < prefix.length + suffix.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    if (best && prefix.length <= best.prefix.length) continue;
    best = { prefix, match: key.slice(prefix.length, key.length - suffix.length), targets };
  }
  return best ? best.targets.map((t) => t.split('*').join(best!.match)) : [];
}

/**
 * The workspace map as a stable string: every name, scope, directory and
 * declared entry an import can be resolved by. Two loads that agree on it
 * resolve every package import the same way; sync compares it with the one
 * the index was built with to see a package.json edit (#2456, #2502).
 */
export function workspaceFingerprint(ws: WorkspacePackages | null): string {
  if (!ws) return 'none';
  const sorted = <V>(map: Map<string, V> | undefined): Array<[string, V]> =>
    map ? [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : [];
  const canonical = JSON.stringify({
    byName: sorted(ws.byName),
    entryByName: sorted(ws.entryByName),
    scoped: sorted(ws.scopedByName).map(([dir, names]) => [dir, sorted(names)]),
    entries: sorted(ws.entriesByDir).map(([dir, e]) => [dir, sorted(e.exports), e.main ?? []]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Each map's package folders, outermost first. */
const PACKAGE_DIRS = new WeakMap<WorkspacePackages, string[]>();

/**
 * The folder of the package `file` is in — a workspace member, or a path
 * dependency's target — the outermost when packages nest, or null. Every
 * import of a package by its name lands in its folder, inner packages'
 * files included.
 */
export function workspacePackageDirOf(ws: WorkspacePackages, file: string): string | null {
  let dirs = PACKAGE_DIRS.get(ws);
  if (!dirs) {
    const all = new Set(ws.byName.values());
    for (const names of ws.scopedByName?.values() ?? []) for (const dir of names.values()) all.add(dir);
    dirs = [...all].filter((dir) => dir !== '').sort((a, b) => a.length - b.length);
    PACKAGE_DIRS.set(ws, dirs);
  }
  return dirs.find((dir) => file.startsWith(dir + '/')) ?? null;
}

/** Read workspace glob patterns from package.json + pnpm-workspace.yaml. */
function readWorkspaceGlobs(projectRoot: string): string[] {
  const out: string[] = [];

  // package.json `workspaces` (npm / yarn / bun): array, or Yarn's
  // `{ packages: [...], nohoist: [...] }` object form.
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
    );
    const ws = pkg?.workspaces;
    if (Array.isArray(ws)) {
      out.push(...ws.filter((w: unknown): w is string => typeof w === 'string'));
    } else if (ws && Array.isArray(ws.packages)) {
      out.push(...ws.packages.filter((w: unknown): w is string => typeof w === 'string'));
    }
  } catch {
    /* no / invalid package.json — not a workspace root */
  }

  // pnpm-workspace.yaml `packages:` list. Parsed with a minimal line
  // scanner so we don't pull in a YAML dependency.
  try {
    const yaml = fs.readFileSync(path.join(projectRoot, 'pnpm-workspace.yaml'), 'utf-8');
    out.push(...parsePnpmPackages(yaml));
  } catch {
    /* no pnpm-workspace.yaml */
  }

  return out;
}

/**
 * Minimal pnpm-workspace.yaml `packages:` extractor. Handles the only shape
 * pnpm actually uses:
 *   packages:
 *     - 'packages/*'
 *     - "apps/*"
 *     - tools/build
 */
function parsePnpmPackages(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split(/\r?\n/);
  let inPackages = false;
  for (const line of lines) {
    if (/^\s*packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item) {
        out.push(item[1]!.replace(/^['"]|['"]$/g, ''));
        continue;
      }
      // A non-list, non-blank line ends the `packages:` block.
      if (line.trim() !== '' && !/^\s/.test(line)) inPackages = false;
    }
  }
  return out;
}

/** Folders no wildcard matches: installed packages. */
const GLOB_SKIP_DIRS = new Set(['node_modules', 'bower_components']);
/**
 * Folders a `**` doesn't descend into either, as pnpm's default ignores
 * don't: their fixture packages are no members, and their names (`react`,
 * `lodash`) would make imports of the real package the project's.
 */
const GLOBSTAR_SKIP_DIRS = new Set(['test', 'tests']);
/** How far a `**` reaches below the glob's literal prefix, and how many folders one glob reads. */
const GLOBSTAR_MAX_DEPTH = 8;
const GLOB_DIR_BUDGET = 10_000;

/**
 * Expand a workspace glob to the member directories it matches, nearest
 * first: `packages/*`, `packages/plugin-*`, `apps/*\/web`, `{apps,libs}/*`,
 * and the nested members of pnpm's `packages/**\/*` or npm's `libs/**\/*`
 * (folo's `@follow/utils` is `packages/internal/utils`, two levels down).
 * A wildcard never matches a dot-folder or one of GLOB_SKIP_DIRS, and a `**`
 * none of GLOBSTAR_SKIP_DIRS; a folder the glob names literally is always
 * entered. Breadth-first with sorted names, so a member nearer the root wins
 * a package name a deeper copy also declares.
 */
function expandWorkspaceGlob(projectRoot: string, pattern: string): string[] {
  const norm = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  const glob = compileGlob(norm);
  const first = glob.findIndex((seg) => seg.wildcard);
  if (first === -1) return [norm]; // exact directory

  const base = glob.slice(0, first).map((seg) => seg.text).join('/');
  const start = globClosure(glob, new Set([first]));
  // `tools/**` is `tools` too, as npm and pnpm match `tools/**/package.json`.
  const out: string[] = start.has(glob.length) ? [base || '.'] : [];
  let level = [{ rel: base, states: start }];
  let read = 0;
  for (let depth = 0; level.length > 0 && depth <= GLOBSTAR_MAX_DEPTH; depth++) {
    const next: typeof level = [];
    for (const { rel, states } of level) {
      if (++read > GLOB_DIR_BUDGET) {
        logDebug('workspace glob stopped at its folder budget', { pattern, read });
        return out;
      }
      let names: string[];
      try {
        names = fs.readdirSync(path.join(projectRoot, rel), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const advanced = globStep(glob, states, name, true);
        if (advanced.size === 0) continue;
        const child = rel ? `${rel}/${name}` : name;
        if (advanced.has(glob.length)) out.push(child);
        if ([...advanced].some((state) => state < glob.length)) next.push({ rel: child, states: advanced });
      }
    }
    level = next;
  }
  return out;
}

/** Whether a negated workspace glob's pattern (`**\/example`, `examples/with-*`) matches a member directory. */
function workspaceGlobMatches(pattern: string, dir: string): boolean {
  const glob = compileGlob(pattern.replace(/\\/g, '/').replace(/\/+$/, ''));
  let states = globClosure(glob, new Set([0]));
  for (const name of dir.split('/').filter((s) => s !== '' && s !== '.')) {
    states = globStep(glob, states, name, false);
    if (states.size === 0) return false;
  }
  return states.has(glob.length);
}

interface GlobSegment {
  text: string;
  /** `**`: any number of folders, none included. */
  globstar: boolean;
  wildcard: boolean;
  re: RegExp | null;
}

/** A glob's folder segments: `*`, `?` and `{a,b}` within one, `**` across them. */
function compileGlob(pattern: string): GlobSegment[] {
  return pattern.split('/').filter((s) => s !== '' && s !== '.').map((text) => {
    if (text === '**') return { text, globstar: true, wildcard: true, re: null };
    if (!/[*?{]/.test(text)) return { text, globstar: false, wildcard: false, re: null };
    const source = text
      .replace(/[.+^$()|[\]\\]/g, '\\$&')
      .replace(/\*+/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\{([^{}]*)\}/g, (_, alts: string) => `(?:${alts.split(',').join('|')})`);
    return { text, globstar: false, wildcard: true, re: new RegExp(`^${source}$`) };
  });
}

/** The states a folder named `name` leads to from `states`; `walking` skips what pnpm's walk skips. */
function globStep(glob: GlobSegment[], states: Set<number>, name: string, walking: boolean): Set<number> {
  const next = new Set<number>();
  const hidden = walking && (name.startsWith('.') || GLOB_SKIP_DIRS.has(name));
  for (const i of states) {
    const seg = glob[i];
    if (!seg) continue;
    if (seg.globstar) {
      if (!hidden && !(walking && GLOBSTAR_SKIP_DIRS.has(name))) next.add(i);
    } else if (seg.re ? !hidden && seg.re.test(name) : seg.text === name) {
      next.add(i + 1);
    }
  }
  return globClosure(glob, next);
}

/** `states` with every `**` that can match no folder at all stepped over. */
function globClosure(glob: GlobSegment[], states: Set<number>): Set<number> {
  for (const i of [...states]) {
    for (let j = i; glob[j]?.globstar; j++) states.add(j + 1);
  }
  return states;
}

/** Read the `name` field from a member directory's package.json. */
function readPackageName(dirAbs: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dirAbs, 'package.json'), 'utf-8'));
    return typeof pkg?.name === 'string' && pkg.name ? pkg.name : null;
  } catch {
    return null;
  }
}
