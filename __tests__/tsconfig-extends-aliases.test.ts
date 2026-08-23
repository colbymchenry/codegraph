/**
 * `compilerOptions.paths` behind an `extends` chain (#1534).
 *
 * Nx-style TypeScript monorepos keep every alias in `tsconfig.base.json` and
 * let the root `tsconfig.json` inherit it with a bare `"extends"`. The v1
 * loader read only the root file's own `compilerOptions`, so those repos got
 * `null` back — every cross-package import fell through to name-based
 * matching, silently, with no unresolved-import warning.
 *
 * What is locked in here:
 *  - `paths` is picked up through one and through several `extends` hops
 *  - `extends` targets resolve as relative paths (with or without `.json`),
 *    and as `node_modules` package specifiers
 *  - inherited `paths` resolve against the config that DECLARED them (a base
 *    config one directory down must not have its targets read as root-relative)
 *  - an explicit `baseUrl` still wins, and is itself relative to the file that
 *    declared it
 *  - the nearest config wins: a child's own `paths` replaces (not merges with)
 *    the parent's, which is what `tsc` does
 *  - a cyclic `extends` terminates instead of blowing the stack
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadProjectAliases, applyAliases } from '../src/resolution/path-aliases';

function write(file: string, content: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

describe('tsconfig `extends` chains (#1534)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tsextends-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('picks up paths from an extended tsconfig.base.json (Nx layout)', () => {
    write(path.join(root, 'tsconfig.base.json'), {
      compilerOptions: {
        baseUrl: '.',
        paths: { '@scope/lib-name': ['libs/lib-name/src/index.ts'], '@scope/*': ['libs/*/src/index.ts'] },
      },
    });
    write(path.join(root, 'tsconfig.json'), { extends: './tsconfig.base.json', compilerOptions: {} });

    const aliases = loadProjectAliases(root);
    expect(aliases).not.toBeNull();
    expect(applyAliases('@scope/lib-name', aliases!, root)).toEqual(['libs/lib-name/src/index.ts']);
    expect(applyAliases('@scope/other', aliases!, root)).toEqual(['libs/other/src/index.ts']);
  });

  it('follows a multi-hop chain and accepts an extensionless relative target', () => {
    write(path.join(root, 'tsconfig.root.json'), {
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['packages/*/src'] } },
    });
    write(path.join(root, 'tsconfig.mid.json'), { extends: './tsconfig.root' });
    write(path.join(root, 'tsconfig.json'), { extends: './tsconfig.mid.json' });

    const aliases = loadProjectAliases(root);
    expect(applyAliases('@app/ui', aliases!, root)).toEqual(['packages/ui/src']);
  });

  it('resolves an `extends` package specifier through node_modules', () => {
    write(path.join(root, 'node_modules/@acme/tsconfig/tsconfig.json'), {
      // Anchored at the package's own directory: node_modules/@acme/tsconfig
      compilerOptions: { paths: { '@acme/*': ['../../../src/*'] } },
    });
    write(path.join(root, 'tsconfig.json'), { extends: '@acme/tsconfig' });

    const aliases = loadProjectAliases(root);
    expect(applyAliases('@acme/thing', aliases!, root)).toEqual(['src/thing']);
  });

  it('resolves inherited paths against the config that declared them, not the root', () => {
    // No baseUrl anywhere: tsc anchors `paths` at the declaring config's own
    // directory. Reading `src/*` as root-relative would silently point every
    // alias at the wrong tree.
    write(path.join(root, 'config/tsconfig.base.json'), {
      compilerOptions: { paths: { '~/*': ['src/*'] } },
    });
    write(path.join(root, 'tsconfig.json'), { extends: './config/tsconfig.base.json' });

    const aliases = loadProjectAliases(root);
    expect(applyAliases('~/foo', aliases!, root)).toEqual(['config/src/foo']);
  });

  it('honours an inherited baseUrl relative to the file that declared it', () => {
    write(path.join(root, 'config/tsconfig.base.json'), {
      compilerOptions: { baseUrl: '..', paths: { '~/*': ['src/*'] } },
    });
    write(path.join(root, 'tsconfig.json'), { extends: './config/tsconfig.base.json' });

    const aliases = loadProjectAliases(root);
    expect(applyAliases('~/foo', aliases!, root)).toEqual(['src/foo']);
  });

  it('lets the nearest config override inherited paths and baseUrl', () => {
    write(path.join(root, 'tsconfig.base.json'), {
      compilerOptions: { baseUrl: 'base-dir', paths: { '@x/*': ['from-base/*'] } },
    });
    write(path.join(root, 'tsconfig.json'), {
      extends: './tsconfig.base.json',
      compilerOptions: { baseUrl: 'own-dir', paths: { '@x/*': ['from-child/*'] } },
    });

    const aliases = loadProjectAliases(root);
    expect(applyAliases('@x/y', aliases!, root)).toEqual(['own-dir/from-child/y']);
  });

  it('terminates on a cyclic extends chain and still uses what it reached', () => {
    // The paths live INSIDE the cycle, so this only passes if the chain is
    // actually walked — and only returns at all if the cycle is cut.
    write(path.join(root, 'tsconfig.json'), { extends: './a.json' });
    write(path.join(root, 'a.json'), {
      extends: './b.json',
      compilerOptions: { paths: { '@cycle/*': ['from-a/*'] } },
    });
    write(path.join(root, 'b.json'), { extends: './a.json' });

    const aliases = loadProjectAliases(root);
    expect(applyAliases('@cycle/x', aliases!, root)).toEqual(['from-a/x']);
  });

  it('falls back to tsconfig.base.json behind a solution-style root config', () => {
    // What `nrwl/nx` itself ships: the root tsconfig.json is a project-
    // references shell with no `extends` and no `paths`, so following the
    // chain from it reaches nothing. The aliases are all in the base.
    write(path.join(root, 'tsconfig.base.json'), {
      compilerOptions: { baseUrl: '.', paths: { '@scope/*': ['libs/*/src/index.ts'] } },
    });
    write(path.join(root, 'tsconfig.json'), {
      compileOnSave: false,
      files: [],
      include: [],
      references: [{ path: './libs/lib-name' }],
    });

    const aliases = loadProjectAliases(root);
    expect(aliases).not.toBeNull();
    expect(applyAliases('@scope/lib-name', aliases!, root)).toEqual(['libs/lib-name/src/index.ts']);
  });

  it('falls back to tsconfig.base.json when no root tsconfig.json exists', () => {
    // The classic Nx integrated layout: only per-project tsconfigs and a
    // base at the root. Nothing to follow an `extends` chain from.
    write(path.join(root, 'tsconfig.base.json'), {
      compilerOptions: { baseUrl: '.', paths: { '@scope/*': ['libs/*/src/index.ts'] } },
    });

    const aliases = loadProjectAliases(root);
    expect(aliases).not.toBeNull();
    expect(applyAliases('@scope/lib-name', aliases!, root)).toEqual(['libs/lib-name/src/index.ts']);
  });

  it('still prefers the root tsconfig.json when both files carry paths', () => {
    // Precedence guard for the fallback: base is consulted only when the
    // root config yields nothing.
    write(path.join(root, 'tsconfig.base.json'), {
      compilerOptions: { baseUrl: '.', paths: { '@x/*': ['from-base/*'] } },
    });
    write(path.join(root, 'tsconfig.json'), {
      compilerOptions: { baseUrl: '.', paths: { '@x/*': ['from-root/*'] } },
    });

    const aliases = loadProjectAliases(root);
    expect(applyAliases('@x/y', aliases!, root)).toEqual(['from-root/y']);
  });

  it('still returns null when nothing in the chain declares paths', () => {
    write(path.join(root, 'tsconfig.base.json'), { compilerOptions: { strict: true } });
    write(path.join(root, 'tsconfig.json'), { extends: './tsconfig.base.json' });

    expect(loadProjectAliases(root)).toBeNull();
  });
});
