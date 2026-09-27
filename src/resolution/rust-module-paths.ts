/**
 * Rust #[path] module inclusion and effective parent-module resolution.
 *
 * Per the Rust Reference (Modules chapter), a `mod` item with a `path`
 * attribute loads its body from an external file while remaining a lexical
 * submodule of the declaring module; `super` in that file refers to the
 * declaring module, not to a path derived from the included file's location
 * on disk (Rust Reference, n.d., https://doc.rust-lang.org/reference/items/modules.html).
 */

import * as path from 'path';
import { ResolutionContext } from './types';

const rustPathInclusionMemos = new WeakMap<ResolutionContext, Map<string, string>>();

/** `#[path = "..."] mod name;` — attribute may share a line with other attrs. */
const RUST_PATH_ATTR_MOD_RE = /#\[\s*path\s*=\s*"([^"]+)"\s*\]\s*mod\s+\w+\s*;/g;

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function clearRustModulePathMemos(context: ResolutionContext): void {
  rustPathInclusionMemos.delete(context);
}

/**
 * Map from included child file (repo-relative) to its declaring parent module
 * file (repo-relative).
 */
export function buildRustPathInclusionMap(context: ResolutionContext): Map<string, string> {
  const cached = rustPathInclusionMemos.get(context);
  if (cached) return cached;

  const map = new Map<string, string>();
  const projectRoot = context.getProjectRoot();
  const toRel = (abs: string) => normalizeRelPath(path.relative(projectRoot, abs));

  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const content = context.readFile(file);
    if (!content?.includes('#[path')) continue;

    const parentDir = path.dirname(path.join(projectRoot, file));
    RUST_PATH_ATTR_MOD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RUST_PATH_ATTR_MOD_RE.exec(content)) !== null) {
      const child = toRel(path.normalize(path.join(parentDir, m[1]!)));
      map.set(child, normalizeRelPath(file));
    }
  }

  rustPathInclusionMemos.set(context, map);
  return map;
}

/** Parent module file when `childFile` is loaded via `#[path]`, else null. */
export function getRustPathInclusionParent(
  childFile: string,
  context: ResolutionContext
): string | null {
  return buildRustPathInclusionMap(context).get(normalizeRelPath(childFile)) ?? null;
}

/**
 * Resolve a lone `super` (or `super::super::…` with no trailing module
 * segments) to the parent module's source file. `#[path]`-included modules
 * treat one `super` as the declaring file (Rust Reference, Paths).
 */
export function resolveRustSuperModuleFile(
  superCount: number,
  fromFile: string,
  context: ResolutionContext
): string | null {
  if (superCount <= 0) return null;

  const projectRoot = context.getProjectRoot();
  const parentViaPath = getRustPathInclusionParent(fromFile, context);
  if (parentViaPath) {
    if (superCount === 1) return parentViaPath;
    // Additional `super` segments walk up from the declaring module file.
    let dir = path.dirname(path.join(projectRoot, parentViaPath));
    for (let s = 1; s < superCount && dir; s++) {
      dir = path.dirname(dir);
    }
    const base = path.basename(dir);
    const lib = normalizeRelPath(path.join(dir, 'lib.rs'));
    const main = normalizeRelPath(path.join(dir, 'main.rs'));
    const modRs = normalizeRelPath(path.join(dir, 'mod.rs'));
    if (context.fileExists(lib)) return lib;
    if (context.fileExists(main)) return main;
    if (context.fileExists(modRs)) return modRs;
    return normalizeRelPath(path.join(dir, base + '.rs'));
  }

  const fromAbs = path.join(projectRoot, fromFile);
  let dir = rustSelfModuleDirAbs(fromAbs);
  for (let s = 0; s < superCount && dir; s++) {
    dir = path.dirname(dir);
  }
  if (!dir) return null;

  const base = path.basename(dir);
  const lib = normalizeRelPath(path.join(dir, 'lib.rs'));
  const main = normalizeRelPath(path.join(dir, 'main.rs'));
  const modRs = normalizeRelPath(path.join(dir, 'mod.rs'));
  if (context.fileExists(lib)) return lib;
  if (context.fileExists(main)) return main;
  if (context.fileExists(modRs)) return modRs;
  const asRs = normalizeRelPath(path.join(dir, base + '.rs'));
  if (context.fileExists(asRs)) return asRs;
  return null;
}

/** Directory under which the current file's module declares its submodules. */
export function rustSelfModuleDirAbs(fromFileAbs: string): string {
  const base = path.basename(fromFileAbs);
  const dir = path.dirname(fromFileAbs);
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  return path.join(dir, base.replace(/\.rs$/, ''));
}
