/**
 * Go module path detection.
 *
 * A Go monorepo's cross-package calls (`pkga.FuncX(...)`) only resolve when
 * the resolver knows the project's module path (the `module ...` directive
 * in `go.mod`). Without it, `isExternalImport` treats every in-module import
 * — `github.com/example/myproject/pkga` — as a third-party package, so
 * resolution falls through to name-matching with path proximity and returns
 * a tiny fraction of the real call sites. See issue #388.
 *
 * A project can hold several modules — a Go backend in `server/` next to a
 * frontend, or etcd's root module beside `server/go.mod` and
 * `client/v3/go.mod` — so the resolver reads the `go.mod` nearest every
 * directory with indexed Go files and maps an import path to the module
 * that declares the longest prefix of it (#2322).
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
 * Read the `go.mod` file in `moduleDir` and extract the module path.
 * Returns `null` if no `go.mod` exists there or it has no `module` directive.
 */
export function loadGoModule(moduleDir: string): GoModule | null {
  const goModPath = path.join(moduleDir, 'go.mod');
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
  return { modulePath, rootDir: moduleDir };
}

/**
 * The module an import path belongs to: the one whose module path equals it
 * or is a `/`-bounded prefix of it. Nested modules (`example.com/app` and
 * `example.com/app/tools`) take the longest module path, as Go does; two
 * modules declaring the same path prefer `own`, the importing file's module.
 * `null` for the standard library and third-party modules.
 */
export function findGoModuleForImport(
  importPath: string,
  modules: readonly GoModule[],
  own?: GoModule | null
): GoModule | null {
  let best: GoModule | null = null;
  for (const mod of own && !modules.includes(own) ? [...modules, own] : modules) {
    if (importPath !== mod.modulePath && !importPath.startsWith(`${mod.modulePath}/`)) continue;
    const length = best ? best.modulePath.length : -1;
    if (mod.modulePath.length > length || (mod.modulePath.length === length && mod === own)) best = mod;
  }
  return best;
}

/**
 * The project-relative directory (`/`-separated, `.` for the project root)
 * of the package `importPath` names inside module `mod`: the module's own
 * directory followed by the rest of the import path.
 */
export function goModulePackageDir(importPath: string, mod: GoModule, projectRoot: string): string {
  const modDir = path.relative(projectRoot, mod.rootDir).split(path.sep).join('/');
  const rest = importPath === mod.modulePath ? '' : importPath.slice(mod.modulePath.length + 1);
  return path.posix.join(modDir, rest);
}
