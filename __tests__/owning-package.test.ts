/**
 * `codegraph files --format package` and `codegraph_files` `format: "package"`
 * (#1871): a file's package is the nearest manifest above it that names one.
 *
 * Manifests are not indexed, so the walk reads the disk. These pin what it stops
 * on, what it refuses to read, and that the listing is opt-in: nothing else
 * `codegraph files` prints changes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';
import {
  groupFilesByPackage,
  owningPackageLookup,
  packageGroupTitle,
  packageListingTitle,
} from '../src/graph/owning-package';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

// These index a project and spawn the real CLI, up to several times a test.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function write(root: string, file: string, content: string): void {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function manifest(root: string, file: string, value: unknown): void {
  write(root, file, JSON.stringify(value));
}

describe('owning package of a file', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-owning-package-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ownerName = (file: string): string | null => owningPackageLookup(root)(file)?.name ?? null;

  it('takes the nearest manifest, however deep the file is', () => {
    manifest(root, 'package.json', { name: 'workspace-root' });
    manifest(root, 'apps/api/package.json', { name: '@acme/api' });

    expect(ownerName('apps/api/src/deep/er/a.ts')).toBe('@acme/api');
    expect(ownerName('apps/api/b.ts')).toBe('@acme/api');
    expect(ownerName('apps/web/c.ts')).toBe('workspace-root');
    expect(ownerName('d.ts')).toBe('workspace-root');
  });

  it('walks past a manifest that names nothing', () => {
    manifest(root, 'apps/api/package.json', { name: '@acme/api' });
    // The `{"type":"module"}` a build drops into an output folder.
    manifest(root, 'apps/api/dist/esm/package.json', { type: 'module' });

    expect(ownerName('apps/api/dist/esm/index.js')).toBe('@acme/api');
  });

  it('says so when nothing above a file names a package', () => {
    manifest(root, 'package.json', { private: true });

    expect(owningPackageLookup(root)('scripts/a.ts')).toBeNull();
  });

  it('settles a directory holding both manifests in favour of package.json', () => {
    manifest(root, 'lib/composer.json', { name: 'acme/lib' });
    manifest(root, 'lib/package.json', { name: '@acme/lib' });

    expect(owningPackageLookup(root)('lib/a.ts')).toEqual({
      name: '@acme/lib',
      dir: 'lib',
      manifest: 'package.json',
    });
  });

  it('uses composer.json when package.json in the same directory names nothing', () => {
    manifest(root, 'package.json', { name: 'workspace-root' });
    manifest(root, 'lib/package.json', { private: true });
    manifest(root, 'lib/composer.json', { name: 'acme/lib' });

    expect(owningPackageLookup(root)('lib/a.php')).toEqual({
      name: 'acme/lib',
      dir: 'lib',
      manifest: 'composer.json',
    });
  });

  it.each([
    ['malformed JSON', '{ "name": '],
    ['an empty file', ''],
    ['a blank name', '{ "name": "   " }'],
    ['a name that is not a string', '{ "name": { "first": "x" } }'],
    ['a top-level array', '["name"]'],
    ['a top-level null', 'null'],
  ])('reads %s as naming nothing, not as a failure', (_label, content) => {
    manifest(root, 'package.json', { name: 'workspace-root' });
    write(root, 'lib/package.json', content);

    expect(ownerName('lib/a.ts')).toBe('workspace-root');
  });

  it('reads a manifest saved with a byte-order mark', () => {
    write(root, 'lib/composer.json', '﻿{ "name": "acme/lib" }');

    expect(ownerName('lib/a.php')).toBe('acme/lib');
  });

  it('trims the name it reports', () => {
    manifest(root, 'lib/package.json', { name: '  @acme/lib ' });

    expect(ownerName('lib/a.ts')).toBe('@acme/lib');
  });

  it('skips a manifest over the source size limit instead of reading it', () => {
    manifest(root, 'package.json', { name: 'workspace-root' });
    write(root, 'lib/package.json', `{"name":"huge","pad":"${'x'.repeat(MAX_SOURCE_FILE_SIZE_BYTES)}"}`);

    expect(ownerName('lib/a.ts')).toBe('workspace-root');
  });

  it('does not read a manifest reached through a link out of the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-owning-outside-'));
    try {
      manifest(outside, 'package.json', { name: 'from-outside' });
      manifest(root, 'package.json', { name: 'workspace-root' });
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');

      expect(ownerName('linked/a.ts')).toBe('workspace-root');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('shares one answer across a package, and reads the disk again for the next listing', () => {
    manifest(root, 'lib/package.json', { name: '@acme/lib' });

    const lookup = owningPackageLookup(root);
    expect(lookup('lib/a.ts')).toBe(lookup('lib/src/b.ts'));

    manifest(root, 'lib/package.json', { name: '@acme/renamed' });
    expect(owningPackageLookup(root)('lib/a.ts')?.name).toBe('@acme/renamed');
  });

  it('orders packages by name, then directory, with the unowned group last', () => {
    manifest(root, 'z/package.json', { name: 'alpha' });
    manifest(root, 'a/package.json', { name: 'alpha' });
    manifest(root, 'm/package.json', { name: 'beta' });

    const groups = groupFilesByPackage(root, [
      { path: 'orphan.ts' },
      { path: 'm/b.ts' },
      { path: 'z/b.ts' },
      { path: 'z/a.ts' },
      { path: 'a/a.ts' },
    ]);

    expect(groups.map((group) => group.owner && `${group.owner.name}@${group.owner.dir}`)).toEqual([
      'alpha@a',
      'alpha@z',
      'beta@m',
      null,
    ]);
    expect(groups[1]!.files.map((file) => file.path)).toEqual(['z/a.ts', 'z/b.ts']);
    expect(groups[3]!.files.map((file) => file.path)).toEqual(['orphan.ts']);
  });

  it('keeps the original file records, so callers can render their metadata', () => {
    manifest(root, 'lib/package.json', { name: '@acme/lib' });
    const file = { path: 'lib/a.ts', language: 'typescript', nodeCount: 3 };

    expect(groupFilesByPackage(root, [file])[0]!.files[0]).toBe(file);
  });

  it('words a listing the same way for every surface', () => {
    manifest(root, 'package.json', { name: 'workspace-root' });
    manifest(root, 'apps/api/package.json', { name: '@acme/api' });

    const groups = groupFilesByPackage(root, [
      { path: 'apps/api/a.ts' },
      { path: 'apps/api/b.ts' },
      { path: 'c.ts' },
    ]);

    expect(packageListingTitle(groups)).toBe('Files by Package (3 files, 2 packages)');
    expect(groups.map(packageGroupTitle)).toEqual(['@acme/api in apps/api (2 files)', 'workspace-root (1 file)']);
    expect(packageGroupTitle({ owner: null, files: [{}] })).toBe('no owning package (1 file)');
    expect(packageListingTitle([{ owner: null, files: [{}] }])).toBe('Files by Package (1 file, 0 packages)');
  });
});

describe('listing an indexed project by package', () => {
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-files-package-'));
    manifest(dir, 'package.json', { private: true });
    manifest(dir, 'apps/api/package.json', { name: '@acme/api' });
    manifest(dir, 'apps/web/package.json', { name: '@acme/web' });
    write(dir, 'apps/api/src/handler.ts', 'export function handler() { return 1; }\n');
    write(dir, 'apps/web/src/view.ts', 'export function view() { return 2; }\n');
    write(dir, 'scripts/tool.ts', 'export function tool() { return 3; }\n');
    const cg = await CodeGraph.init(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.destroy();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function codegraph(...args: string[]): string {
    return execFileSync(process.execPath, [BIN, ...args, '--path', dir], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  describe('codegraph_files', () => {
    async function listed(args: Record<string, unknown>): Promise<string> {
      const cg = await CodeGraph.open(dir);
      try {
        const result = await new ToolHandler(cg).execute('codegraph_files', { format: 'package', ...args });
        expect(result.isError).toBeFalsy();
        return result.content[0]!.text as string;
      } finally {
        cg.destroy();
      }
    }

    it('offers the format in its schema', () => {
      const files = tools.find((tool) => tool.name === 'codegraph_files')!;
      expect(files.inputSchema.properties.format.enum).toContain('package');
    });

    it('sections the files by package, the unowned ones last', async () => {
      expect(await listed({ includeMetadata: false })).toBe(
        [
          '**Files by Package (3 files, 2 packages)**',
          '',
          '**@acme/api in apps/api (1 file)**',
          '- apps/api/src/handler.ts',
          '',
          '**@acme/web in apps/web (1 file)**',
          '- apps/web/src/view.ts',
          '',
          '**no owning package (1 file)**',
          '- scripts/tool.ts',
          '',
        ].join('\n'),
      );
    });

    it('shows metadata unless told not to', async () => {
      expect(await listed({})).toMatch(/- apps\/api\/src\/handler\.ts \(typescript, \d+ symbols\)/);
    });

    it('finds the manifest above a path filter', async () => {
      const text = await listed({ path: 'apps/api/src', includeMetadata: false });

      expect(text).toContain('**@acme/api in apps/api (1 file)**');
      expect(text).not.toContain('@acme/web');
      expect(text).not.toContain('no owning package');
    });

    it('follows a renamed manifest without a re-index', async () => {
      manifest(dir, 'apps/api/package.json', { name: '@acme/renamed' });

      expect(await listed({ includeMetadata: false })).toContain('**@acme/renamed in apps/api (1 file)**');
    });

    it('leaves the other formats alone', async () => {
      const flat = await listed({ format: 'flat', includeMetadata: false });

      expect(flat).toContain('- apps/api/src/handler.ts');
      expect(flat).not.toContain('Files by Package');
    });
  });

  describe('codegraph files', () => {
    it('prints sections when asked for --format package', () => {
      const out = codegraph('files', '--format', 'package', '--no-metadata');

      expect(out).toContain('Files by Package (3 files, 2 packages):');
      expect(out).toContain('@acme/api in apps/api (1 file):\n  apps/api/src/handler.ts\n');
      expect(out).toContain('no owning package (1 file):\n  scripts/tool.ts\n');
      expect(out.indexOf('@acme/web')).toBeLessThan(out.indexOf('no owning package'));
    });

    it('shows metadata unless told not to', () => {
      expect(codegraph('files', '--format', 'package')).toMatch(
        /apps\/api\/src\/handler\.ts \(typescript, \d+ symbols\)/,
      );
    });

    it('applies --filter before grouping', () => {
      const out = codegraph('files', '--format', 'package', '--filter', 'apps/web');

      expect(out).toContain('Files by Package (1 file, 1 package):');
      expect(out).not.toContain('@acme/api');
    });

    it('lists the help text for the new format', () => {
      expect(execFileSync(process.execPath, [BIN, 'files', '--help'], { encoding: 'utf-8' })).toContain(
        'tree, flat, grouped, package',
      );
    });

    it('still prints a tree by default', () => {
      const out = codegraph('files');

      expect(out).toContain('Project Structure (3 files):');
      expect(out).not.toContain('Files by Package');
    });

    it('keeps the --json shape, with or without the format', () => {
      const plain = JSON.parse(codegraph('files', '--json')) as Array<Record<string, unknown>>;

      expect(plain.map((file) => Object.keys(file).sort())).toEqual(
        plain.map(() => ['errors', 'isTest', 'language', 'nodeCount', 'path', 'size']),
      );
      expect(JSON.parse(codegraph('files', '--json', '--format', 'package'))).toEqual(plain);
    });
  });
});
