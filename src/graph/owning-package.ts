/**
 * The package that owns a file: the nearest manifest above it that names one.
 *
 * `package.json` and `composer.json` are not source, so nothing about them is
 * in the index and "which package owns this file" (#1871) is answered from disk
 * when it is asked. That also keeps the answer current without a re-index. The
 * nearest manifest is the whole rule: a workspace member's own manifest sits
 * closer to its files than the root's, so a monorepo needs no configuration, and
 * a `package.json` that names nothing (`{ "type": "module" }` in a build folder,
 * a private root) simply doesn't stop the walk.
 *
 * `Cargo.toml` and `pyproject.toml` are left out on purpose. Reading a name from
 * them needs a TOML parser, and a `name =` search would group files under a
 * dependency's name; a listing that says "no owning package" is the honest
 * answer until then.
 *
 * Two surfaces render this (`codegraph files` and `codegraph_files`), so the
 * grouping and its wording both live here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readBoundedSourceSync } from '../file-limits';
import { validatePathWithinRoot } from '../utils';

/** The manifests read, in the order that settles a directory holding both. */
const PACKAGE_MANIFESTS = ['package.json', 'composer.json'] as const;

export interface OwningPackage {
  /** The manifest's `name`, trimmed. */
  name: string;
  /** Project-relative POSIX directory of the manifest; `.` is the project root. */
  dir: string;
  /** Which manifest named it. */
  manifest: (typeof PACKAGE_MANIFESTS)[number];
}

export interface PackageGroup<F> {
  /** Null for the files no manifest above them names a package for. */
  owner: OwningPackage | null;
  files: F[];
}

/**
 * The `name` a manifest declares. Null when the file is absent, outside the
 * project, over the source size limit, not valid JSON, or names nothing: a bad
 * manifest must cost a listing one package name, never the listing.
 */
function manifestName(projectRoot: string, manifestPath: string): string | null {
  // Most directories hold no manifest, so this is the common exit, and it comes
  // before the containment check, which resolves symlinks on every path.
  if (!fs.existsSync(path.join(projectRoot, manifestPath))) return null;
  const file = validatePathWithinRoot(projectRoot, manifestPath);
  if (!file) return null;
  try {
    const { bytes } = readBoundedSourceSync(file);
    if (!bytes) return null;
    // JSON.parse rejects the byte-order mark some Windows editors write.
    const manifest: unknown = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
    const name = (manifest as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * A `(projectRelativePath) => owner` lookup for one listing. Each directory is
 * resolved once and shares its parent's answer, so a listing costs one probe per
 * manifest type per directory however many files it holds, and every file of a
 * package gets the same `OwningPackage` object.
 */
export function owningPackageLookup(projectRoot: string): (filePath: string) => OwningPackage | null {
  const ownerByDir = new Map<string, OwningPackage | null>();

  const ownerOf = (dir: string): OwningPackage | null => {
    const known = ownerByDir.get(dir);
    if (known !== undefined) return known;

    let owner: OwningPackage | null = null;
    for (const manifest of PACKAGE_MANIFESTS) {
      const name = manifestName(projectRoot, path.posix.join(dir, manifest));
      if (name) {
        owner = { name, dir, manifest };
        break;
      }
    }
    if (!owner) {
      const parent = path.posix.dirname(dir);
      if (parent !== dir) owner = ownerOf(parent);
    }
    ownerByDir.set(dir, owner);
    return owner;
  };

  return (filePath) => ownerOf(path.posix.dirname(filePath));
}

/**
 * `files` grouped by owning package: packages by name, then directory when two
 * share a name, files by path. The unowned group comes last and is a group of
 * its own, never folded into a package, because a file nothing claims is what
 * someone splitting work by package needs to see.
 *
 * `projectRoot` is always the project's root, not a filtered subdirectory: a
 * file's manifest can sit above the filter.
 */
export function groupFilesByPackage<F extends { path: string }>(
  projectRoot: string,
  files: readonly F[],
): PackageGroup<F>[] {
  const ownerOf = owningPackageLookup(projectRoot);
  const filesByOwner = new Map<OwningPackage | null, F[]>();
  for (const file of files) {
    const owner = ownerOf(file.path);
    const owned = filesByOwner.get(owner);
    if (owned) owned.push(file);
    else filesByOwner.set(owner, [file]);
  }
  return [...filesByOwner]
    .map(([owner, owned]) => ({ owner, files: owned.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => {
      if (!a.owner || !b.owner) return Number(!a.owner) - Number(!b.owner);
      return a.owner.name.localeCompare(b.owner.name) || a.owner.dir.localeCompare(b.owner.dir);
    });
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The heading of a by-package listing. */
export function packageListingTitle(groups: readonly PackageGroup<unknown>[]): string {
  const files = groups.reduce((total, group) => total + group.files.length, 0);
  const packages = groups.filter((group) => group.owner).length;
  return `Files by Package (${countOf(files, 'file')}, ${countOf(packages, 'package')})`;
}

/** The heading of one package's section. */
export function packageGroupTitle({ owner, files }: PackageGroup<unknown>): string {
  const size = countOf(files.length, 'file');
  if (!owner) return `no owning package (${size})`;
  return owner.dir === '.' ? `${owner.name} (${size})` : `${owner.name} in ${owner.dir} (${size})`;
}
