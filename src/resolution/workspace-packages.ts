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
 *   - expands one level of `*` / `**` globs (`packages/*`, `apps/*`)
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
  const patterns = readWorkspaceGlobs(projectRoot);
  if (patterns.length === 0) return null;

  const byName = new Map<string, string>();
  for (const pattern of patterns) {
    for (const dir of expandWorkspaceGlob(projectRoot, pattern)) {
      const pkgName = readPackageName(path.join(projectRoot, dir));
      // First declaration wins — workspace patterns are tried in order.
      if (pkgName && !byName.has(pkgName)) byName.set(pkgName, dir);
    }
  }
  if (byName.size === 0) return null;

  logDebug('workspace packages loaded', { count: byName.size });
  return { byName };
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

/** Expand one level of a `packages/*` / `apps/**` glob to member dirs. */
function expandWorkspaceGlob(projectRoot: string, pattern: string): string[] {
  const norm = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  const star = norm.indexOf('*');
  if (star === -1) return [norm]; // exact directory

  // Everything before the wildcard segment is the base to enumerate.
  const base = norm.slice(0, star).replace(/\/+$/, '');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(projectRoot, base), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    out.push(base ? `${base}/${e.name}` : e.name);
  }
  return out;
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
