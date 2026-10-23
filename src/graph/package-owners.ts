/**
 * Owning-package lookup for a project's files (issue #1871).
 *
 * "Which package owns this file" is a question the index could not answer: a
 * manifest (`package.json`, `composer.json`) is not a source file, so it holds
 * no row in `files` and no node, and `--format grouped` grouped by language.
 * The use case is sharding — a review or a build agent that wants one batch per
 * workspace member.
 *
 * The answer is the NEAREST ancestor directory whose manifest names a package,
 * so a monorepo needs no configuration: a member's own manifest is nearer to its
 * files than the root's. The walk is bounded by the project root and memoized
 * per directory for the life of one call, because a grouped listing asks once
 * per file.
 *
 * JSON manifests only. `Cargo.toml` and `pyproject.toml` need a real parser; a
 * `name =` grep would group a file under a dependency's name, so #1871 leaves
 * them for later and so does this.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Manifests read, in the order that breaks a same-directory tie. One package
 * per directory is the invariant: a directory holding both is a package whose
 * manifest type is the one written first here.
 */
const MANIFESTS = ['package.json', 'composer.json'] as const;

export interface PackageOwner {
  /** The manifest's `name`, trimmed. */
  name: string;
  /** Project-relative POSIX directory holding the manifest; `''` at the root. */
  dir: string;
  /** Which manifest named it. */
  manifest: (typeof MANIFESTS)[number];
}

/** The package `dir`'s own manifest names, or null when none does. */
function readOwner(projectRoot: string, dir: string): PackageOwner | null {
  for (const manifest of MANIFESTS) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(projectRoot, dir, manifest), 'utf-8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // a malformed manifest names nothing; a sibling type still may
    }
    const name = (parsed as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim() !== '') {
      return { name: name.trim(), dir, manifest };
    }
  }
  return null;
}

/**
 * A `(projectRelativePath) => PackageOwner | null` resolver, memoized per
 * directory. `null` means no ancestor manifest names a package — an answer the
 * caller must render, never swallow: a file silently bucketed under "" reads as
 * a package with an empty name.
 */
export function createPackageOwnerResolver(projectRoot: string): (file: string) => PackageOwner | null {
  const byDir = new Map<string, PackageOwner | null>();

  const ownerOfDir = (dir: string): PackageOwner | null => {
    const cached = byDir.get(dir);
    if (cached !== undefined) return cached;
    const owner = readOwner(projectRoot, dir);
    byDir.set(dir, owner);
    return owner;
  };

  return (file: string) => {
    let dir = path.posix.dirname(file.replace(/\\/g, '/'));
    if (dir === '.') dir = '';
    for (;;) {
      const owner = ownerOfDir(dir);
      if (owner) return owner;
      if (dir === '') return null;
      dir = path.posix.dirname(dir);
      if (dir === '.') dir = '';
    }
  };
}

export interface PackageGroup<T> {
  /** Null for the files no ancestor manifest claims. */
  owner: PackageOwner | null;
  files: T[];
}

/**
 * Bucket `files` by owning package. Packages sort by name (directories break a
 * duplicate name), files sort by path, and the unowned bucket goes last — a
 * listing that leads with "no package" buries the sharding the caller asked for.
 *
 * `projectRoot` is where manifests are read from: the project root, never the
 * filtered subdirectory, or every file would look unowned.
 */
export function groupFilesByPackage<T extends { path: string }>(
  projectRoot: string,
  files: readonly T[]
): PackageGroup<T>[] {
  const ownerOf = createPackageOwnerResolver(projectRoot);
  const groups = new Map<string, PackageGroup<T>>();

  for (const file of files) {
    const owner = ownerOf(file.path);
    const key = owner ? `${owner.dir}\u0000${owner.name}` : '\u0000';
    let group = groups.get(key);
    if (!group) {
      group = { owner, files: [] };
      groups.set(key, group);
    }
    group.files.push(file);
  }

  const sorted = [...groups.values()].sort((a, b) => {
    if (!a.owner || !b.owner) return a.owner ? -1 : b.owner ? 1 : 0;
    return a.owner.name.localeCompare(b.owner.name) || a.owner.dir.localeCompare(b.owner.dir);
  });
  for (const group of sorted) group.files.sort((a, b) => a.path.localeCompare(b.path));
  return sorted;
}
