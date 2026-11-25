/**
 * A Cargo workspace's members are read only inside the project: a member a
 * manifest writes as `../sibling`, or as an absolute path, is neither read
 * nor listed, so the cross-crate paths built on them stay in the project.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { getCargoWorkspaceCrateMap } from '../src/resolution/frameworks/cargo-workspace';
import type { ResolutionContext } from '../src/resolution/types';
import { escapesRoot } from '../src/utils';

function stubContext(files: Record<string, string>, dirs: Record<string, string[]>) {
  const read: string[] = [];
  const listed: string[] = [];
  const context = {
    readFile: (p: string) => {
      read.push(p);
      return files[p] ?? null;
    },
    listDirectories: (p: string) => {
      listed.push(p);
      return dirs[p] ?? [];
    },
    fileExists: (p: string) => p in files,
  } as unknown as ResolutionContext;
  return { context, read, listed };
}

const outside = (p: string): boolean => escapesRoot(path.posix.normalize(p));

describe('Cargo workspace members stay inside the project', () => {
  it('reads and lists no member outside the project', () => {
    const { context, read, listed } = stubContext(
      {
        'Cargo.toml': '[workspace]\nmembers = ["crates/*", "app", "../outside", "../vendor/*", "/abs/crate", "crates/../../escape"]\n',
        'crates/core/Cargo.toml': '[package]\nname = "core-crate"\n',
        'app/Cargo.toml': '[package]\nname = "app"\n',
        '../outside/Cargo.toml': '[package]\nname = "outside"\n',
        '/abs/crate/Cargo.toml': '[package]\nname = "abs"\n',
      },
      { crates: ['core'], '../vendor': ['x'] },
    );
    const map = getCargoWorkspaceCrateMap(context);
    expect([...map.keys()].sort()).toEqual(['app', 'core-crate', 'core_crate']);
    expect(read.filter(outside)).toEqual([]);
    expect(listed.filter(outside)).toEqual([]);
  });

  it('reads a member whose folder only starts with two dots', () => {
    const { context, read } = stubContext(
      {
        'Cargo.toml': '[workspace]\nmembers = ["..generated/crate"]\n',
        '..generated/crate/Cargo.toml': '[package]\nname = "generated"\n',
      },
      {},
    );
    expect([...getCargoWorkspaceCrateMap(context).keys()]).toEqual(['generated']);
    expect(read).toContain('..generated/crate/Cargo.toml');
  });
});
