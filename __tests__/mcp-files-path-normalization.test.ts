/**
 * codegraph_files path-filter normalization (#426)
 *
 * Stored file paths are project-relative POSIX (e.g. "src/foo.ts"). Some
 * agents pass project-root variants like "/", ".", "./" or "" when they want
 * "the whole project", and Windows-style backslashes or leading "/" / "./"
 * prefixes when they want a subtree. The old filter used a plain
 * `startsWith(pathFilter)`, so any of those buried the agent at "no files
 * found" and pushed it back to Read/Glob — the exact opencode regression in
 * #426. These tests pin every branch of the normalization.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_files path normalization', () => {
  let tempDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-files-paths-'));
    fs.mkdirSync(path.join(tempDir, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'index.ts'), `export const x = 1;\n`);
    fs.writeFileSync(
      path.join(tempDir, 'src', 'components', 'Button.ts'),
      `export const Button = () => 1;\n`
    );
    fs.writeFileSync(path.join(tempDir, 'tests', 'a.test.ts'), `export const t = 1;\n`);
    cg = await CodeGraph.init(tempDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function listed(pathFilter: string | undefined): Promise<string> {
    const result = await handler.execute('codegraph_files', {
      ...(pathFilter !== undefined ? { path: pathFilter } : {}),
      format: 'flat',
      includeMetadata: false,
    });
    expect(result.isError).toBeFalsy();
    return result.content[0]!.text as string;
  }

  // Root-ish filters: every shape an agent might guess for "whole project"
  // must list the same files as no filter at all.
  for (const rootish of ['/', '.', './', '', '\\', '//', './/']) {
    it(`treats path=${JSON.stringify(rootish)} as project root`, async () => {
      const output = await listed(rootish);
      expect(output).toContain('src/index.ts');
      expect(output).toContain('src/components/Button.ts');
      expect(output).toContain('tests/a.test.ts');
    });
  }

  it('matches a real subdirectory prefix', async () => {
    const output = await listed('src');
    expect(output).toContain('src/index.ts');
    expect(output).toContain('src/components/Button.ts');
    expect(output).not.toContain('tests/a.test.ts');
  });

  it('tolerates a leading slash on a real subdirectory', async () => {
    const output = await listed('/src');
    expect(output).toContain('src/index.ts');
    expect(output).not.toContain('tests/a.test.ts');
  });

  it('tolerates a leading "./" on a real subdirectory', async () => {
    const output = await listed('./src');
    expect(output).toContain('src/index.ts');
    expect(output).not.toContain('tests/a.test.ts');
  });

  it('tolerates a trailing slash on a real subdirectory', async () => {
    const output = await listed('src/');
    expect(output).toContain('src/index.ts');
    expect(output).not.toContain('tests/a.test.ts');
  });

  it('normalizes Windows backslashes', async () => {
    const output = await listed('src\\components');
    expect(output).toContain('src/components/Button.ts');
    expect(output).not.toContain('src/index.ts');
  });

  // Old code matched on raw `startsWith`, so a filter "src" would also
  // return a sibling like "src-utils/...". The new code requires either an
  // exact match or a "<filter>/" boundary, so prefixes don't bleed.
  it('does not match sibling directories that share a prefix', async () => {
    fs.mkdirSync(path.join(tempDir, 'src-utils'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src-utils', 'helper.ts'), `export const h = 1;\n`);
    await cg.indexAll();

    const output = await listed('src');
    expect(output).toContain('src/index.ts');
    expect(output).not.toContain('src-utils/helper.ts');
  });
});
