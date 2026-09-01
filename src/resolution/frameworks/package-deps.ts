/**
 * The dependencies a project declares — in its root `package.json` and in
 * the ones one or two directories down (`apps/web/package.json`,
 * `frontend/package.json`, `packages/api/package.json`). A framework detector
 * that reads only the root misses every monorepo: proshop keeps `react` in
 * `frontend/`, a Turborepo keeps `next` in `apps/web/`, and the resolver for
 * that framework then never runs, so its routes never exist.
 */

import type { ResolutionContext } from '../types';

/** Nested manifests read per project, at most — a monorepo with hundreds of packages is sampled, not scanned. */
const MAX_MANIFESTS = 24;

/**
 * Cached per context, keyed by how many files are indexed.
 *
 * The resolver is constructed — and every `detect()` runs once — BEFORE any
 * file exists, so that first pass sees no directories to probe and reads only
 * the root manifest. Caching that answer outright made the re-detect after
 * indexing (`CodeGraph.indexAll`) a cache hit on the empty set, and every
 * framework whose dependency lives one directory down stayed undetected: a
 * proshop-shaped repo indexed its React Router routes (extraction is not
 * gated on detection) and then resolved none of its navigation. Re-reading
 * when the file count changes costs one manifest sweep per index.
 */
const cache = new WeakMap<ResolutionContext, { files: number; names: Set<string> }>();

/** Every dependency name declared at the root or up to two directories down, de-duplicated. */
export function declaredDependencies(context: ResolutionContext): Set<string> {
  const files = context.getAllFiles();
  const cached = cache.get(context);
  if (cached && cached.files === files.length) return cached.names;
  const names = new Set<string>();
  // The index lists source files, never manifests: the candidate directories
  // are the first one or two segments of what IS indexed, probed on disk.
  const dirs = new Set<string>();
  for (const file of files) {
    const segs = file.split('/');
    if (segs.length > 1) dirs.add(segs[0] + '/');
    if (segs.length > 2) dirs.add(segs[0] + '/' + segs[1] + '/');
    if (dirs.size > MAX_MANIFESTS * 8) break;
  }
  const manifests = ['package.json'];
  for (const dir of dirs) {
    if (manifests.length > MAX_MANIFESTS) break;
    if (!dir.includes('node_modules') && context.fileExists(dir + 'package.json')) manifests.push(dir + 'package.json');
  }
  for (const manifest of manifests) {
    const content = context.readFile(manifest);
    if (!content) continue;
    try {
      const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
      for (const group of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
        if (group && typeof group === 'object') for (const name of Object.keys(group)) names.add(name);
      }
    } catch {
      // Not JSON — a template, a broken manifest; nothing to read.
    }
  }
  cache.set(context, { files: files.length, names });
  return names;
}

/** True when any of `deps` is declared anywhere the project's manifests are read. */
export function dependsOn(context: ResolutionContext, ...deps: string[]): boolean {
  const names = declaredDependencies(context);
  return deps.some((d) => names.has(d));
}
