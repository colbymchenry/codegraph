/**
 * External include paths (`codegraph.json` `includePaths`, issue #499).
 *
 * A project can index, sync, and search directories OUTSIDE its root — the
 * multi-repo / microservice case where an agent working in project A must see
 * sibling projects B and C without indexing a shared parent. Each configured
 * path is mounted under a reserved virtual top-level directory inside the
 * project:
 *
 *   project root/__codegraph_external__/<slug>/…
 *
 * The file paths stored in the DB, returned by queries, and handed to MCP
 * tools are these VIRTUAL paths. That keeps the codebase's root-relative path
 * model (and its `validatePathWithinRoot` security checks) intact: a virtual
 * path never lexically escapes the root. Only the two places that actually
 * touch the filesystem translate virtual ↔ real:
 *
 *   - indexing/sync reads  → {@link resolveIndexReadPath} (module the walk
 *     enumerated, so no containment widening)
 *   - serving file contents   → {@link resolveServablePath} (strict, and only
 *     for exactly the configured mounts)
 *
 * The slug is derived from the mounted directory's basename and is deduped, so
 * it is always a single safe path segment — it can never carry separators or
 * `..` traversal.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadIncludePaths } from './project-config';
import { validatePathWithinRoot, isWithinDir } from './utils';

/** Reserved virtual top-level directory that external mounts live under. */
export const EXTERNAL_PREFIX = '__codegraph_external__';

/** A resolved external mount: a user-configured directory plus its virtual slug. */
export interface ExternalMount {
  /** Single safe path segment, unique within a project (basename, deduped). */
  slug: string;
  /** Resolved absolute directory path (does not have to exist yet). */
  abs: string;
}

function safeSlug(name: string, taken: Set<string>): string {
  let slug = name || 'external';
  // Only keep characters that are safe in a single path segment.
  slug = slug.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'external';
  let candidate = slug;
  let i = 2;
  while (taken.has(candidate)) candidate = `${slug}-${i++}`;
  taken.add(candidate);
  return candidate;
}

/**
 * Resolve the configured `includePaths` for a project into mount records.
 * Relative entries resolve against the project root; absolute entries are used
 * as-is. Duplicate resolved directories are collapsed, and each gets a unique
 * slug. Never throws — a bad entry is skipped.
 */
export function loadExternalMounts(rootDir: string): ExternalMount[] {
  const configured = loadIncludePaths(rootDir);
  if (configured.length === 0) return [];
  const seenAbs = new Set<string>();
  const takenSlugs = new Set<string>();
  const out: ExternalMount[] = [];
  for (const entry of configured) {
    const abs = path.resolve(rootDir, entry);
    if (seenAbs.has(abs)) continue;
    seenAbs.add(abs);
    out.push({ slug: safeSlug(path.basename(abs), takenSlugs), abs });
  }
  return out;
}

/** Is `filePath` a virtual path under an external mount? */
export function isExternalVirtual(filePath: string): boolean {
  return filePath.split('/')[0] === EXTERNAL_PREFIX;
}

/** Map a mount + a path relative to the mount's directory to its virtual path. */
export function externalToVirtual(mount: ExternalMount, relFromAbs: string): string {
  const rel = relFromAbs.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${EXTERNAL_PREFIX}/${mount.slug}/${rel}`;
}

/**
 * Split a virtual external path back into its mount and the path inside it.
 * Returns null when the path isn't external or doesn't reference a configured
 * mount.
 */
export function resolveExternalVirtual(
  rootDir: string,
  filePath: string,
): { mount: ExternalMount; rel: string } | null {
  if (!isExternalVirtual(filePath)) return null;
  const segs = filePath.split('/');
  if (segs.length < 2) return null;
  const slug = segs[1]!;
  const rel = segs.slice(2).join('/');
  const mounts = loadExternalMounts(rootDir);
  const mount = mounts.find((m) => m.slug === slug);
  if (!mount) return null;
  return { mount, rel };
}

/**
 * Resolve a stored (possibly virtual-external) path to the real absolute file
 * path for INDEXING / SYNC reads. External virtual paths are translated to
 * their configured mount; everything else goes through the normal
 * `validatePathWithinRoot` (with symlink-escape allowed, matching the directory
 * walk the index uses).
 */
export function resolveIndexReadPath(rootDir: string, filePath: string): string | null {
  const ext = resolveExternalVirtual(rootDir, filePath);
  if (ext) {
    // Lexical containment against the configured mount: block `../` traversal
    // out of the mount. Symlink following is intentionally left untouched to
    // match the directory walk (the virtual path mirrors what the walk
    // enumerated inside the mount).
    const abs = path.resolve(ext.mount.abs, ext.rel);
    if (!isWithinDir(abs, ext.mount.abs)) return null;
    return abs;
  }
  return validatePathWithinRoot(rootDir, filePath, { allowSymlinkEscape: true });
}

/**
 * Resolve a stored (possibly virtual-external) path to the real absolute file
 * path for SERVING file contents (MCP tools, context builder). Strict: only
 * exactly the configured external mounts are reachable, and the resolved file
 * must exist. Everything else uses the strict (leak-safe) `validatePathWithinRoot`.
 */
export function resolveServablePath(rootDir: string, filePath: string): string | null {
  const ext = resolveExternalVirtual(rootDir, filePath);
  if (ext) {
    const full = path.join(ext.mount.abs, ext.rel);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) return null;
      const real = fs.realpathSync(full);
      const mountReal = fs.realpathSync(ext.mount.abs);
      // The resolved file must stay inside the mount's real directory — this
      // blocks both `../` traversal and symlink escapes out of the mount (#527).
      if (!isWithinDir(real, mountReal)) return null;
      return real;
    } catch {
      return null;
    }
  }
  return validatePathWithinRoot(rootDir, filePath);
}

/**
 * Whether a stored path is an external mount path (used to route exists-checks
 * and stat calls in reconcile loops through {@link resolveIndexReadPath}).
 */
export function isExternalPath(rootDir: string, filePath: string): boolean {
  return resolveExternalVirtual(rootDir, filePath) !== null;
}
