/**
 * Files grouped by owning package (#1871)
 *
 * A manifest is not a source file, so it holds no row in `files` and no node:
 * nothing could answer "which package owns this file", and `--format grouped`
 * grouped by language instead. These pin the nearest-manifest walk, the
 * same-directory tie, the unowned bucket, and the MCP wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { groupFilesByPackage } from '../src/graph/package-owners';

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

describe('groupFilesByPackage', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-package-owners-'));
  });

  afterEach(() => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives a file the nearest ancestor manifest that names a package', () => {
    writeJson(path.join(root, 'package.json'), { private: true });
    writeJson(path.join(root, 'apps', 'api', 'package.json'), { name: '@acme/api' });
    writeJson(path.join(root, 'apps', 'web', 'package.json'), { name: '@acme/web' });

    const groups = groupFilesByPackage(root, [
      { path: 'apps/api/src/deep/a.ts' },
      { path: 'apps/api/b.ts' },
      { path: 'apps/web/c.ts' },
    ]);

    expect(groups.map((group) => group.owner?.name)).toEqual(['@acme/api', '@acme/web']);
    expect(groups[0]!.files.map((file) => file.path)).toEqual([
      'apps/api/b.ts',
      'apps/api/src/deep/a.ts',
    ]);
    expect(groups[0]!.owner).toMatchObject({ dir: 'apps/api', manifest: 'package.json' });
  });

  it('leaves a file with no naming manifest above it unowned, and last', () => {
    writeJson(path.join(root, 'package.json'), { private: true });
    writeJson(path.join(root, 'apps', 'api', 'package.json'), { name: '@acme/api' });

    const groups = groupFilesByPackage(root, [
      { path: 'scripts/orphan.mjs' },
      { path: 'apps/api/a.ts' },
    ]);

    expect(groups[0]!.owner?.name).toBe('@acme/api');
    expect(groups[1]!.owner).toBeNull();
    expect(groups[1]!.files.map((file) => file.path)).toEqual(['scripts/orphan.mjs']);
  });

  it('breaks a same-directory tie in favour of package.json over composer.json', () => {
    writeJson(path.join(root, 'vendor', 'pkg', 'composer.json'), { name: 'acme/legacy' });
    writeJson(path.join(root, 'vendor', 'pkg', 'package.json'), { name: '@acme/legacy-js' });

    const [group] = groupFilesByPackage(root, [{ path: 'vendor/pkg/a.ts' }]);

    expect(group!.owner).toMatchObject({
      name: '@acme/legacy-js',
      manifest: 'package.json',
      dir: 'vendor/pkg',
    });
  });

  it('falls through to composer.json when package.json names nothing', () => {
    writeJson(path.join(root, 'vendor', 'pkg', 'package.json'), { private: true });
    writeJson(path.join(root, 'vendor', 'pkg', 'composer.json'), { name: 'acme/legacy' });

    const [group] = groupFilesByPackage(root, [{ path: 'vendor/pkg/a.php' }]);

    expect(group!.owner?.name).toBe('acme/legacy');
  });

  it('reads a malformed manifest as naming nothing, not as a crash', () => {
    fs.mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'api', 'package.json'), '{ "name": ');

    const [group] = groupFilesByPackage(root, [{ path: 'apps/api/a.ts' }]);

    expect(group!.owner).toBeNull();
  });

  it('treats a blank name as naming nothing', () => {
    writeJson(path.join(root, 'apps', 'api', 'package.json'), { name: '   ' });

    const [group] = groupFilesByPackage(root, [{ path: 'apps/api/a.ts' }]);

    expect(group!.owner).toBeNull();
  });
});

describe('codegraph_files --format package', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-files-package-'));
    writeJson(path.join(tempDir, 'package.json'), { private: true });
    writeJson(path.join(tempDir, 'apps', 'api', 'package.json'), { name: '@acme/api' });
    writeJson(path.join(tempDir, 'apps', 'web', 'package.json'), { name: '@acme/web' });
    fs.mkdirSync(path.join(tempDir, 'apps', 'api', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'apps', 'web', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'apps', 'api', 'src', 'handler.ts'), 'export const handler = () => 1;\n');
    fs.writeFileSync(path.join(tempDir, 'apps', 'web', 'src', 'view.tsx'), 'export const View = () => null;\n');
    fs.writeFileSync(path.join(tempDir, 'scripts', 'tool.ts'), 'export const tool = 1;\n');
    cg = await CodeGraph.init(tempDir, { config: { include: ['**/*.ts', '**/*.tsx'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('groups the indexed files by their owning package', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_files', {
      format: 'package',
      includeMetadata: false,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text as string;

    expect(text).toContain('**@acme/api (apps/api) — 1 file**');
    expect(text).toContain('- apps/api/src/handler.ts');
    expect(text).toContain('**@acme/web (apps/web) — 1 file**');
    expect(text).toContain('- apps/web/src/view.tsx');
  });

  it('keeps files no manifest names in their own section', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_files', {
      format: 'package',
      includeMetadata: false,
    });
    const text = result.content[0]!.text as string;

    expect(text).toContain('**no owning package — 1 file**');
    expect(text).toContain('- scripts/tool.ts');
  });
});
