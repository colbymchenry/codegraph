/**
 * Go module path detection.
 *
 * A Go monorepo's cross-package calls (`pkga.FuncX(...)`) only resolve when
 * the resolver knows the project's module path (the `module ...` directive
 * in `go.mod`). Without it, `isExternalImport` treats every in-module import
 * — `github.com/example/myproject/pkga` — as a third-party package, so
 * resolution falls through to name-matching with path proximity and returns
 * a tiny fraction of the real call sites. See issue #388.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface GoModule {
  /** The module path declared in `go.mod`, e.g. `github.com/example/myproject` */
  modulePath: string;
  /** Absolute path to the directory containing the `go.mod` file. */
  rootDir: string;
}

/**
 * Read the `go.mod` file at the project root and extract the module path.
 * Returns `null` if no `go.mod` exists or it has no `module` directive.
 *
 * Only the project-root `go.mod` is read here. Nested / sibling `go.mod`
 * files (Go workspaces, monorepos with multiple side-by-side modules) are
 * resolved by {@link loadGoModules}, which builds an index over EVERY
 * `go.mod` in the project and is the path used for cross-module resolution.
 * This single-module reader is kept as a fast path + backward-compat shim.
 */
export function loadGoModule(projectRoot: string): GoModule | null {
  const goModPath = path.join(projectRoot, 'go.mod');
  let content: string;
  try {
    content = fs.readFileSync(goModPath, 'utf-8');
  } catch {
    return null;
  }
  // `module <path>` is the first non-comment directive in any valid go.mod.
  // Strip line comments so a `// module foo` doesn't false-match.
  const stripped = content.replace(/\/\/[^\n]*/g, '');
  const match = stripped.match(/^\s*module\s+(\S+)\s*$/m);
  if (!match) return null;
  // Strip optional quoting around the module path.
  const modulePath = match[1]!.replace(/^["']|["']$/g, '');
  if (!modulePath) return null;
  return { modulePath, rootDir: projectRoot };
}

/** A single `go.mod` entry discovered in the project tree. */
export interface GoModuleEntry {
  /** go.mod's `module` directive, e.g. `github.com/example/myorg/commons` */
  modulePath: string;
  /** Directory containing this `go.mod`, relative to projectRoot, `/`-separated; `''` for the root module */
  relDir: string;
}

/**
 * Index over EVERY `go.mod` in a project (multi-module monorepo). Built once
 * per resolution pass via {@link loadGoModules}. `null` when the project has
 * no `go.mod` at all — callers then fall back to the single-module path.
 *
 * Entries are kept sorted by `modulePath` length DESCENDING so the longest
 * prefix wins (`example.com/org/platform/sdk` must claim its own imports
 * before `example.com/org/platform` shadows them).
 */
export interface GoModuleIndex {
  /** All entries, sorted by `modulePath` length descending. */
  entries: GoModuleEntry[];
  /** Which local module an import belongs to, or `null` if none. */
  resolve(importPath: string): { entry: GoModuleEntry; subPath: string } | null;
  /** Import path → project-relative package directory, or `null` if not local. */
  packageDir(importPath: string): string | null;
}

/** Directories never descended into while scanning for `go.mod` files. */
const GO_MOD_SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'testdata', 'dist', 'build', 'target', '.venv', '.codegraph', 'graphify-out',
]);
/** Safety net for pathological repos: stop descending past this depth. */
const GO_MOD_MAX_DEPTH = 8;
/** Safety net: stop collecting after this many `go.mod` files. */
const GO_MOD_MAX_FILES = 1000;

/**
 * Build a {@link GoModuleIndex} by recursively collecting every `go.mod` under
 * `projectRoot`. Returns `null` only when NO `go.mod` is found, so a non-Go
 * project stays on the same code path as before. See `docs/design/go-multi-
 * module-resolution.md` §3 for the matching/normalization contract.
 */
export function loadGoModules(projectRoot: string): GoModuleIndex | null {
  const byModulePath = new Map<string, GoModuleEntry>();

  const scan = (dir: string, depth: number): void => {
    // Collect the go.mod in THIS directory (if any), then keep descending —
    // Go allows nested modules (the repro repo has 84 go.mod incl. nested
    // tools modules), so finding one does NOT stop the descent.
    const goModPath = path.join(dir, 'go.mod');
    let content: string | undefined;
    try {
      content = fs.readFileSync(goModPath, 'utf-8');
    } catch {
      content = undefined;
    }
    if (content !== undefined) {
      const modulePath = parseModuleDirective(content);
      if (modulePath) {
        const relDir = toRelDir(projectRoot, dir);
        // A modulePath appearing in several go.mod (a vendored copy, a forked
        // subtree): keep the entry with the SHORTEST relDir, deterministically.
        // Determinism does NOT rely on traversal order — ties keep the incumbent.
        const existing = byModulePath.get(modulePath);
        if (!existing || relDir.length < existing.relDir.length) {
          byModulePath.set(modulePath, { modulePath, relDir });
        }
      }
      // Below the file-count cap, stop collecting but keep scanning the tree
      // (we still want the recursion bounds to hold, not throw).
      if (byModulePath.size >= GO_MOD_MAX_FILES) return;
    }

    if (depth >= GO_MOD_MAX_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort directory names so traversal (and thus any incidental tiebreak) is
    // deterministic regardless of filesystem ordering.
    const subdirs = entries
      .filter((e) => e.isDirectory() && !GO_MOD_SKIP_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
    for (const name of subdirs) {
      scan(path.join(dir, name), depth + 1);
      if (byModulePath.size >= GO_MOD_MAX_FILES) return;
    }
  };

  scan(projectRoot, 0);

  if (byModulePath.size === 0) return null;

  const entries = [...byModulePath.values()].sort(
    (a, b) => b.modulePath.length - a.modulePath.length || a.modulePath.localeCompare(b.modulePath)
  );

  const resolve = (importPath: string): { entry: GoModuleEntry; subPath: string } | null => {
    for (const entry of entries) {
      const mp = entry.modulePath;
      if (importPath === mp) return { entry, subPath: '' };
      if (importPath.startsWith(mp + '/')) return { entry, subPath: importPath.substring(mp.length + 1) };
    }
    return null;
  };

  const packageDir = (importPath: string): string | null => {
    const r = resolve(importPath);
    if (!r) return null;
    const { entry, subPath } = r;
    // relDir='' + subPath=''  → ''   (root module, root package)
    // relDir=''               → subPath (root module, subpackage)
    // subPath=''              → relDir  (non-root module, root package)
    // else                    → relDir + '/' + subPath
    if (!entry.relDir) return subPath;
    if (!subPath) return entry.relDir;
    return entry.relDir + '/' + subPath;
  };

  return { entries, resolve, packageDir };
}

/** Strip line comments and parse the `module <path>` directive; `''` if absent. */
function parseModuleDirective(content: string): string {
  const stripped = content.replace(/\/\/[^\n]*/g, '');
  const match = stripped.match(/^\s*module\s+(\S+)\s*$/m);
  if (!match) return '';
  return match[1]!.replace(/^["']|["']$/g, '');
}

/** `path.relative(projectRoot, dir)` normalized to forward slashes; root dir → `''`. */
function toRelDir(projectRoot: string, dir: string): string {
  return path.relative(projectRoot, dir).replace(/\\/g, '/');
}
