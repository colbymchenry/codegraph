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
 * directory so the resolver can rewrite `@scope/ui/widgets` →
 * `packages/ui/widgets` and then run normal extension/index resolution.
 *
 * Scope deliberately small for v1 (mirrors path-aliases.ts):
 *   - reads `workspaces` (array OR `{ packages: [...] }`) from package.json,
 *     plus a minimal `pnpm-workspace.yaml` `packages:` list
 *   - expands `*`, `?` and `{a,b}` within a folder name and `**` across
 *     folders (`packages/*`, pnpm's nested `packages/**\/*`), and leaves out
 *     what a negated glob (`!**\/example`) matches
 *   - subpath resolution is directory-based (`@scope/ui/sub` → `<ui>/sub`);
 *     it does NOT yet honour a member's `exports` map or `main` field
 *   - returns null when the project declares no workspaces, so single-
 *     package repos pay nothing and see no behaviour change.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logDebug } from '../errors';

export interface WorkspacePackages {
  /** Member package `name` → directory relative to projectRoot (posix). */
  byName: Map<string, string>;
  /**
   * Member package `name` → its declared ENTRY FILE relative to projectRoot
   * (posix), when the member's manifest names one (ohpm's oh-package.json5
   * `"main": "Index.ets"`). Lets a bare `import { X } from "data"` resolve to
   * the member's real barrel even when it doesn't follow an index-file
   * convention — and independent of the CONSUMER's language (a `.ts` file
   * importing an `.ets` barrel resolves without `.ets` in the TS candidate
   * list). Absent for npm/pnpm members (their index conventions cover it).
   */
  entryByName?: Map<string, string>;
}

/**
 * Load workspace member packages for `projectRoot`. Returns `null` when
 * the project declares no workspaces (the common single-package case) —
 * callers then skip all workspace logic.
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
  // workspaces, different manifest.
  const entryByName = new Map<string, string>();
  for (const [name, dir] of collectOhpmFileDeps(projectRoot)) {
    if (byName.has(name)) continue;
    byName.set(name, dir);
    const entry = readOhpmMain(projectRoot, dir);
    if (entry) entryByName.set(name, entry);
  }

  if (byName.size === 0) return null;

  logDebug('workspace packages loaded', { count: byName.size });
  return { byName, entryByName: entryByName.size > 0 ? entryByName : undefined };
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
 * The walk is bounded (depth + directory budget) and prunes build/dependency
 * dirs, so non-ArkTS projects pay one readdir at the root and nothing else
 * (they have no oh-package.json5 anywhere shallow).
 */
const OHPM_MANIFEST = 'oh-package.json5';
const OHPM_WALK_MAX_DEPTH = 6;
const OHPM_WALK_DIR_BUDGET = 8000;
const OHPM_SKIP_DIRS = new Set([
  'node_modules', 'oh_modules', '.git', '.codegraph', '.hvigor', '.preview',
  'build', 'dist', 'out', 'oh-package-lock.json5',
]);

function collectOhpmFileDeps(projectRoot: string): Map<string, string> {
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();

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
      if (e.name !== OHPM_MANIFEST) continue;

      const deps = readOhpmFileDeps(path.join(abs, e.name));
      for (const [name, target] of deps) {
        const targetAbs = path.resolve(abs, target);
        const targetRel = path.relative(projectRoot, targetAbs).replace(/\\/g, '/');
        if (targetRel.startsWith('..')) continue; // escapes the project
        const existing = byName.get(name);
        if (existing === undefined) {
          if (!ambiguous.has(name)) byName.set(name, targetRel);
        } else if (existing !== targetRel) {
          byName.delete(name);
          ambiguous.add(name);
        }
      }
    }
  }

  return byName;
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
 * name `@scope/ui` → its directory. Returns `null` when no member package
 * name matches.
 */
export function resolveWorkspaceImport(
  importPath: string,
  ws: WorkspacePackages
): string | null {
  // Longest matching package name wins, so `@scope/ui/core` prefers a
  // `@scope/ui/core` package over a `@scope/ui` one when both exist.
  let bestName: string | null = null;
  for (const name of ws.byName.keys()) {
    if (importPath === name || importPath.startsWith(name + '/')) {
      if (!bestName || name.length > bestName.length) bestName = name;
    }
  }
  if (!bestName) return null;
  const dir = ws.byName.get(bestName)!;
  const subpath = importPath.slice(bestName.length); // '' or '/widgets'
  // A bare member import resolves straight to the member's declared entry
  // file when the manifest names one (ohpm `main`) — the caller's exact-path
  // check hits it without extension/index guessing.
  if (!subpath) {
    const entry = ws.entryByName?.get(bestName);
    if (entry) return entry;
  }
  return (dir + subpath).replace(/\/{2,}/g, '/');
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
