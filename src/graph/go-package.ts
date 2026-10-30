/**
 * The package a Go file declares — the name a `pkg.Type.method` query writes.
 *
 * It is usually the name of the file's directory, which is why a package
 * qualifier is first compared with the path. Not always: a module's root
 * package has no directory of its own (gin's `context.go` is `package gin` at
 * the top of the repository), and a versioned directory (`v2/`) keeps its
 * parent's name. The `package` clause is the authority, and it is not in the
 * index, so it is read from the file when a lookup needs it.
 */

import { closeSync, openSync, readSync } from 'fs';
import { validatePathWithinRoot } from '../utils';

/** The package a Go file declares, by its project-relative path; null when unknown. */
export type GoPackageOf = (filePath: string) => string | null;

/** Enough of a file to get past any license header and build tags. */
const HEAD_BYTES = 8192;

/**
 * The name in a Go source's `package` clause: the first token after its
 * comments and build constraints. Null when there is none.
 */
export function goPackageClause(source: string): string | null {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  return /^\s*package\s+([A-Za-z_]\w*)/.exec(code)?.[1] ?? null;
}

/** `goPackageReader` for a graph's project; none when the root can't be had. */
export function goPackageReaderFor(cg: { getProjectRoot(): string }): GoPackageOf | undefined {
  try {
    return goPackageReader(cg.getProjectRoot());
  } catch {
    return undefined;
  }
}

/**
 * A `GoPackageOf` for files under `projectRoot`, reading each file's head once.
 * A file it cannot read declares no package, so the qualifier does not match.
 */
export function goPackageReader(projectRoot: string): GoPackageOf {
  const cache = new Map<string, string | null>();
  return (filePath) => {
    const hit = cache.get(filePath);
    if (hit !== undefined) return hit;
    let pkg: string | null = null;
    const absPath = validatePathWithinRoot(projectRoot, filePath);
    if (absPath) {
      try {
        const fd = openSync(absPath, 'r');
        try {
          const buf = Buffer.alloc(HEAD_BYTES);
          const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
          pkg = goPackageClause(buf.toString('utf8', 0, n));
        } finally {
          closeSync(fd);
        }
      } catch {
        pkg = null;
      }
    }
    cache.set(filePath, pkg);
    return pkg;
  };
}
